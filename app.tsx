import { useCallback, useEffect, useMemo, useState } from 'react';
import { definePluginApp, useRpc, useSettings } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './server.js';
import type { Snapshot } from './collector.js';
import { project } from './pass.js';
import { averagingCopy, axisDays, paceCopy, percent, shortDate, usd } from './pace.js';
import { PaceChart } from './components/PaceChart';
import { Button } from './components/ui/button';
import { Icon } from './components/ui/icon';

/**
 * The measured/forecast split is derived here rather than sent over the wire:
 * the server already ships the daily series, and recomputing the split from it
 * keeps one source of truth for the projection maths.
 */
function usePace() {
  const rpc = useRpc<typeof rpcContract>();
  const settings = useSettings();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  // Settings are readable here but only the server may read secrets, so any
  // change to the visible values is enough to justify a refetch.
  const key = JSON.stringify(settings.values ?? {});

  useEffect(() => {
    let active = true;
    setLoading(true); setFailed(false);
    rpc.call('getPace', { refresh: refresh > 0 }).then(result => {
      if (active) { setSnapshot(result); setFailed(false); }
    }).catch(() => { if (active) setFailed(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [rpc, key, refresh]);

  return { snapshot, loading, failed, refresh: () => setRefresh(n => n + 1) };
}

const STATUS_COPY: Record<Snapshot['status'], string> = {
  ok: '',
  disabled: 'Tracking is off. Enable it in plugin settings.',
  unauthenticated: 'Add an AI Gateway API key in plugin settings to track usage.',
  unavailable: 'Unable to read usage right now. Vercel reporting may be temporarily unavailable — try refreshing.',
};

/**
 * First-run setup, spelled out for someone who just installed this: the three
 * settings that matter, where to get the key, and where to find the renewal
 * day. Shown instead of an empty chart, since a bare "no data" leaves a new
 * user with nothing to act on.
 */
function SetupSteps() {
  const steps = [
    {
      title: 'Add a Vercel AI Gateway key',
      detail: 'Vercel → AI Gateway → API Keys. Any key on the team that owns the Token Pass works.',
    },
    {
      title: 'Set your renewal day',
      detail: 'Teams → Billing → the day of your next invoice. No API exposes it, so it must be entered once.',
    },
    {
      title: 'Check the allowance',
      detail: `$80 unless your Token Pass differs. Usage is this allowance minus measured spend.`,
    },
  ];
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-6 text-left">
      <h2 className="text-sm font-medium">Set up Token Pass tracking</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Three settings, entered once. The key stays on this machine.
      </p>
      <ol className="mt-4 space-y-3">
        {steps.map((step, i) => (
          <li key={step.title} className="flex gap-3">
            <span
              aria-hidden
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium tabular-nums"
            >
              {i + 1}
            </span>
            <span className="min-w-0">
              <span className="block text-sm">{step.title}</span>
              <span className="block text-xs text-muted-foreground">{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-xs text-muted-foreground">
        Find these under Tools → Token Pass Pace → Settings.
      </p>
    </div>
  );
}

/** The headline block: percentage, period context, and the pace verdict. */
function Headline({ snapshot }: { snapshot: Snapshot }) {
  const measured = snapshot.usedPercent ?? 0;
  const copy = paceCopy({ hitDay: snapshot.hitDay, renewal: snapshot.renewal, usedPercent: measured });
  const warning = snapshot.hitDay !== null || measured >= 100;
  return (
    <div className="space-y-1">
      <h1 className="text-[44px] font-semibold leading-none tracking-tight tabular-nums">
        {copy.headline}
      </h1>
      <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
        <span>Token Pass usage</span>
        <span aria-hidden>·</span>
        <span>{copy.renewal}</span>
        {copy.verdict === null ? null : (
          <>
            <span aria-hidden>·</span>
            <span className={warning ? 'font-medium text-[var(--warning-text)]' : undefined}>
              {copy.verdict}
            </span>
          </>
        )}
      </p>
    </div>
  );
}

function Legend({ over }: { over: boolean }) {
  const item = 'flex items-center gap-1.5 text-xs text-muted-foreground';
  return (
    <div className="flex flex-wrap items-center gap-4">
      <span className={item}>
        <span className="h-3 w-[3px] rounded-full bg-[var(--success)]" aria-hidden />
        Usage
      </span>
      {/* The forecast key tracks the line's own colour, which turns to the
          warning tone only when the projection crosses the allowance. */}
      <span className={item}>
        <span
          className={
            over
              ? 'h-3 w-[3px] rounded-full bg-[var(--warning)]'
              : 'h-3 w-[3px] rounded-full bg-[var(--success)]'
          }
          aria-hidden
        />
        Forecast
      </span>
      <span className={item}>
        <span
          className="h-0 w-4 border-t-2 border-dashed border-muted-foreground"
          aria-hidden
        />
        Monthly limit
      </span>
    </div>
  );
}

/** The dashed frame BB's own pages use for empty and loading states. */
function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function PacePage() {
  const { snapshot, loading, failed, refresh } = usePace();

  const chart = useMemo(() => {
    if (!snapshot || snapshot.status !== 'ok') return null;
    const daily = snapshot.daily;
    const rate = snapshot.rateUsdPerDay ?? 0;
    return project(daily, { start: snapshot.periodStart, end: snapshot.periodEnd }, snapshot.renewal, rate);
  }, [snapshot]);

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-5xl px-4 pb-6 pt-4 md:px-6 md:pt-6">
        {failed ? (
          <p role="alert" className="mb-4 text-sm text-destructive">
            Unable to refresh usage. Try again.
          </p>
        ) : null}

        {snapshot === null || snapshot.status !== 'ok' || chart === null ? (
          <div className="space-y-4">
            <div className="h-11 w-24 animate-pulse rounded bg-muted" aria-hidden />
            <div className="h-4 w-64 animate-pulse rounded bg-muted" aria-hidden />
            {loading ? (
              <EmptyState>Reading Token Pass usage…</EmptyState>
            ) : snapshot === null ? (
              <EmptyState>Unable to read usage.</EmptyState>
            ) : snapshot.status === 'unauthenticated' || snapshot.status === 'disabled' ? (
              <SetupSteps />
            ) : (
              <EmptyState>{STATUS_COPY[snapshot.status]}</EmptyState>
            )}
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex items-start justify-between gap-4">
              <Headline snapshot={snapshot} />
              <Button
                variant="outline" size="icon"
                className="mt-1 shrink-0"
                aria-label="Refresh usage"
                disabled={loading}
                onClick={refresh}
              >
                <Icon name="RotateCcw" className={loading ? 'animate-spin' : undefined} />
              </Button>
            </div>

            <PaceChart
              measured={chart.measured}
              forecast={chart.forecast}
              allowanceUsd={snapshot.allowanceUsd}
              usedPercent={snapshot.usedPercent ?? 0}
            />

            {/* The axis strip: month starts and the window edges, echoing the
                reference widget's single place for dates. */}
            <div className="flex items-center justify-between gap-2 rounded-lg bg-muted px-4 py-2 text-xs uppercase tracking-wider text-muted-foreground">
              {axisDays(snapshot.periodStart, snapshot.renewal).map((day, i, all) => (
                <span
                  key={day}
                  className={i === all.length - 1 ? 'font-medium text-foreground' : undefined}
                >
                  {shortDate(day)}
                </span>
              ))}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                {averagingCopy(snapshot.rateUsdPerDay, snapshot.allowanceUsd)}
              </p>
              <Legend over={(snapshot.projectedPercent ?? 0) > 100} />
            </div>

            <dl className="grid grid-cols-3 gap-3 border-t border-border pt-4 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Spent this period</dt>
                <dd className="text-lg font-semibold tabular-nums">{usd(snapshot.spentUsd ?? 0)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Period allowance</dt>
                <dd className="text-lg font-semibold tabular-nums">{usd(snapshot.allowanceUsd)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Projected at renewal</dt>
                <dd
                  className={
                    (snapshot.projectedPercent ?? 0) > 100
                      ? 'text-lg font-semibold tabular-nums text-[var(--warning-text)]'
                      : 'text-lg font-semibold tabular-nums'
                  }
                >
                  {snapshot.projectedPercent === null ? '—' : percent(snapshot.projectedPercent)}
                </dd>
              </div>
            </dl>

            <p className="text-xs text-muted-foreground">
              Spend measured from AI Gateway reporting for the current Token Pass period;
              the projection extends the trailing 7-day average to the renewal day. Token Pass
              publishes no balance endpoint, so this is a derived figure, not a provider-stated balance.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The footer is a glance, not the chart: it shows the percentage and the day
 * the pass runs out, which is the only thing that needs acting on.
 */
export function PaceFooter() {
  const { snapshot, loading } = usePace();
  const ok = snapshot?.status === 'ok' && snapshot.usedPercent !== null;
  const used = snapshot?.usedPercent ?? 0;
  const warning = ok && (snapshot!.hitDay !== null || used >= 100);
  return (
    <div className="px-2 py-1.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="truncate">Token Pass</span>
        <span className="ml-auto font-semibold tabular-nums text-foreground">
          {ok ? percent(used) : loading ? '…' : '—'}
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
        <div
          className={warning ? 'h-full bg-[var(--warning)]' : 'h-full bg-[var(--success)]'}
          style={{ width: `${Math.min(100, Math.max(0, used))}%` }}
        />
      </div>
      {ok ? (
        <p className={warning ? 'mt-1 text-[11px] text-[var(--warning-text)]' : 'mt-1 text-[11px] text-muted-foreground'}>
          {snapshot!.hitDay ? `Hits limit ${shortDate(snapshot!.hitDay)}` : `Renews ${shortDate(snapshot!.renewal)}`}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A declared glyph rather than a BB icon name: an unknown name renders as the
 * generic Zap bolt without any error, so the plugin points at its own mark.
 */
export const PACE_ICON = 'token-pass-pace/pace';

export default definePluginApp(app => {
  app.slots.navPanel({
    id: 'pace',
    title: 'Token Pass Pace',
    icon: PACE_ICON,
    path: 'pace',
    component: PacePage,
  });
  app.experimental_sidebarFooter.register({
    id: 'token-pass-pace',
    label: 'Token Pass Pace',
    icon: PACE_ICON,
    kind: 'disclosure',
    component: PaceFooter,
  });
});
