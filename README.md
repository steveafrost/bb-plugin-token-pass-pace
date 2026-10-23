# Token Pass Pace

Tracks Vercel Token Pass spend against the current billing period's allowance and forecasts
whether the pass runs out before it renews.

## Surfaces

A sidebar navigation panel with the full chart, and an SDK experimental sidebar-footer
disclosure with the compact glance (percentage, a bar, and the day the pass is projected to
run out). Both resolve the glyph `token-pass-pace/pace`, declared in
`bb.branding.experimental_icons` from `assets/pace.svg`; `bb.branding.icon` points at the
same SVG for the Tools listing.

An unknown icon name silently renders as the generic `Zap` bolt, so the plugin spends its own
declared glyph rather than guessing at a builtin name. Frame, axis, legend and warning
colors come from host tokens (`--success`, `--warning`, `--warning-text`, `--border`,
`--muted-foreground`), so light and dark palettes both hold.

## What the chart says

On first run, before a key is stored, the panel shows setup steps naming each setting and
where to find it in Vercel — a new install never opens onto a bare "no data".

The headline is the share of the period allowance already spent. Under it, the renewal date
and — only when the trailing rate would exhaust the allowance first — the day it runs out
("On pace to hit the limit Oct 27"). Once the allowance is spent the verdict becomes
"Limit already reached · resets <date>", because a bare percentage over 100 does not say the
pass itself is exhausted.

The plot is calendar time across the whole period: a solid measured line to today, then a
dashed forecast to renewal, with the forecast window hatched so the boundary reads at a
glance. The 100% rule is drawn and labelled, the forecast's final value is annotated, and the
y-axis keeps the 100% line in frame unless the projection goes far past it — then it rescales
rather than clipping, so the measured points never flatten against the floor.

## Measurement

Token Pass has **no balance endpoint**. AI Gateway's `/v1/credits` is the regular credit
balance and explicitly excludes Token Pass; `/v1/token-pass`, `/v1/subscriptions`,
`/v1/addons`, `/v1/entitlements` and the Vercel REST API all lack a pass endpoint. The only
reachable signal is spend by provider:

```
GET https://ai-gateway.vercel.sh/v1/report?group_by=day&provider=token-pass&start_date=…&end_date=…
```

`total_cost` summed over the period is the spend; the remainder is **derived** as
`tokenpassAllowanceUsd` (default $80) minus that spend. This is a derived figure, not a
provider-stated balance, and the panel says so.

Billing periods are not exposed either, so `tokenpassPeriodStartDay` (default 1) is the
renewal day of the month, clamped so day 31 stays inside short months. The period end is the
day before the next renewal day.

The daily series is **sparse**: a day with no traffic is omitted, not reported as zero. Days
absent from the response are densified to real zeroes, which matters because the rate is a
mean — dropping quiet days would inflate it. A malformed *row* is different: it is treated as
`unavailable`, never as zero spend.

### Forecast

`rateUsdPerDay` is a trailing-window mean: spend over the last 7 days divided by the window
length in days actually observed, so a period younger than the window is not diluted by days
that have not happened yet. The projection is `spent + rate × days_until_renewal`, and
`hitDay` is the first day the projection crosses the allowance. Quiet days count as real
zeroes, so a recent lull pulls the forecast down as it should.

### Setup (three settings, entered once)

| Setting | What to enter |
| --- | --- |
| `tokenpassApiKey` | A Vercel **AI Gateway** key — Vercel → AI Gateway → API Keys. Any key on the team that owns the Token Pass works; the plugin only reads `provider=token-pass` spend. |
| `tokenpassPeriodStartDay` | The day of the month your pass renews — Vercel → Teams → Billing → the next invoice date. |
| `tokenpassAllowanceUsd` | The period allowance. Defaults to $80. |

The renewal day is a setting because **no API exposes it**. The gateway has no
subscription, billing, plan or quota endpoint (`/v1/subscriptions`, `/v1/entitlements`,
`/v1/billing`, `/v1/quota` and friends are all 404), and Vercel's own OpenAPI spec reports
only `plan: "pro"` on the team object — no period, no renewal date. Guessing a period
boundary from gaps in spend would be wrong constantly, because a quiet day and a period
reset look identical in the daily series.

Keys are read by the server only, from `plugins/token-pass-pace/secrets/<key>` (0600), and
each installer enters their own. Never put a key in a prompt, source, CLI argument, or RPC
output.

Only a 401 means the key is wrong. A 403 or 5xx is a failed read and is reported as
`unavailable`, so a valid key is never blamed for an upstream problem.

## Transport and lifecycle

REST with a 10-second abort, coalesced concurrent reads, a 60-second success cache bypassed by
explicit refresh, and generation guards plus disposal aborts so a stale or superseded response
can never resolve. Failures clear the measurement to `null` and never become zero, and no
response body or key is surfaced.

All reads are demand driven: no intervals, no inference requests, no routing changes.

## Development and verification

```
npm install --ignore-scripts
npm run typecheck
npm test
bb plugin build
```
