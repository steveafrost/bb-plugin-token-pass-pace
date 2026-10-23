---
name: token-pass-pace
description: Read Vercel Token Pass spend pace, the projected renewal-day percentage, or explain why tracking shows no data. Use when asked about Token Pass usage, whether the pass will run out, the pace or forecast for the current period, or how to set the plugin up.
---

# Token Pass Pace

Sidebar panel and footer disclosure showing Vercel Token Pass spend as a percentage of the
period allowance, with a forecast to the renewal day.

## Reading the state

- `84%` — share of the period allowance already spent, from measured spend.
- `On pace to hit the limit Oct 27` — the trailing rate exhausts the allowance before it
  renews. Absent when it does not.
- `Limit already reached · resets Nov 20` — the allowance is spent; wait for renewal.
- `Projected at renewal` — the forecast. Over 100% means the pass is expected to run out.

Values are **derived**: Token Pass publishes no balance endpoint, so remaining is the
configured allowance minus AI Gateway spend for `provider=token-pass`. Say so rather than
presenting it as a provider-stated balance.

## Setup

Three settings, once per install:

1. `tokenpassApiKey` — a Vercel **AI Gateway** key (Vercel → AI Gateway → API Keys). Any key
   on the team that owns the pass works; only `provider=token-pass` spend is read.
2. `tokenpassPeriodStartDay` — the renewal day of the month (Vercel → Teams → Billing → next
   invoice).
3. `tokenpassAllowanceUsd` — the allowance, default $80.

The renewal day cannot be detected: no API exposes a subscription, billing or quota period,
and Vercel's team object carries only `plan`. Never try to infer it from spend gaps — a quiet
day and a period reset are indistinguishable, so the guess would silently misreport the
percentage. Never ask for or print a key value in chat.

## When it shows no data

| State | Meaning | Fix |
| --- | --- | --- |
| `unauthenticated` | Key missing, wrong, or revoked (HTTP 401) | Add or re-enter the key |
| `disabled` | Tracking is off | Enable `tokenpassEnabled` |
| `unavailable` | A read failed — 403, 5xx, or the network | Refresh; the key is not the problem |
| `—` in the footer | No measurement yet | Refresh, or check the above |

A 403 is `unavailable`, **not** a bad key. Do not tell a user to re-enter a key that Vercel
merely refused or failed to serve.
