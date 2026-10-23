import {
  type DayTotal,
  densify,
  dailyRate,
  hitDay,
  nextRenewal,
  parseDays,
  periodAt,
  project,
  total,
  TOKEN_PASS_ALLOWANCE_USD,
  TOKEN_PASS_PERIOD_START_DAY,
} from './pass.js';

export type Config = {
  enabled: boolean;
  key: string;
  allowanceUsd?: number;
  periodStartDay?: number;
};

/** Everything the chart needs, already placed on the calendar. */
export type Snapshot = {
  status: 'ok' | 'disabled' | 'unauthenticated' | 'unavailable';
  /** Period allowance in USD — the denominator of every percentage. */
  allowanceUsd: number;
  /** Measured spend so far this period. */
  spentUsd: number | null;
  /** Share of the allowance consumed so far, unclamped (>100 is overage). */
  usedPercent: number | null;
  /** Trailing-average spend rate in USD per day. */
  rateUsdPerDay: number | null;
  /** Projection at period end; may exceed `allowanceUsd`. */
  projectedPercent: number | null;
  /** First forecast day at or over the allowance, `yyyy-mm-dd`. */
  hitDay: string | null;
  /** Current period, inclusive. */
  periodStart: string;
  periodEnd: string;
  /** Next renewal day — the right edge of the chart. */
  renewal: string;
  daily: DayTotal[];
  observedAt: number | null;
};

const GATEWAY = 'https://ai-gateway.vercel.sh/v1/report';
const RECENT_DAYS = 7;

/**
 * Only 401 is a credential problem. Any other refusal (403, 5xx) means the
 * read failed, so it stays `unavailable` rather than telling the user to
 * re-enter a key that is in fact valid.
 */
export function classify(status: number): Snapshot['status'] | null {
  if (status === 401) return 'unauthenticated';
  if (status >= 200 && status < 300) return 'ok';
  return 'unavailable';
}

export function createCollector(options: {
  fetch?: typeof fetch;
  now?: () => number;
} = {}) {
  const now = options.now ?? Date.now;
  const request = options.fetch ?? fetch;
  let config: Config | null = null, generation = 0, disposed = false;
  let cached: Snapshot | null = null, pending: Promise<Snapshot> | null = null;
  let abort: AbortController | null = null;

  const fingerprint = (c: Config) => JSON.stringify([
    c.enabled, c.key.trim(), c.allowanceUsd ?? null, c.periodStartDay ?? null,
  ]);

  function invalidate() {
    generation++; abort?.abort(); abort = null; cached = null; pending = null;
  }

  /** A non-ok snapshot still knows its calendar, so the UI can draw the frame. */
  function empty(status: Snapshot['status'], c: Config | null): Snapshot {
    const allowanceUsd = c?.allowanceUsd ?? TOKEN_PASS_ALLOWANCE_USD;
    const periodStartDay = c?.periodStartDay ?? TOKEN_PASS_PERIOD_START_DAY;
    const period = periodAt(now(), periodStartDay);
    return {
      status, allowanceUsd,
      spentUsd: null, usedPercent: null, rateUsdPerDay: null,
      projectedPercent: null, hitDay: null,
      periodStart: period.start, periodEnd: period.end,
      renewal: nextRenewal(period, periodStartDay),
      daily: [], observedAt: null,
    };
  }

  function measure(next: Config, refresh = false): Promise<Snapshot> {
    next = {
      enabled: next.enabled,
      key: next.key.trim(),
      allowanceUsd: next.allowanceUsd,
      periodStartDay: next.periodStartDay,
    };
    if (!config || fingerprint(config) !== fingerprint(next)) { invalidate(); config = next; }
    if (disposed) return Promise.resolve(empty('unavailable', config));
    if (!next.enabled) return Promise.resolve(empty('disabled', config));
    if (!next.key) return Promise.resolve(empty('unauthenticated', config));
    if (pending) return pending;
    if (!refresh && cached && cached.observedAt !== null && now() - cached.observedAt < 60_000) {
      return Promise.resolve(cached);
    }

    const gen = generation, controller = new AbortController(); abort = controller;
    const timer = setTimeout(() => controller.abort(), 10_000);
    const allowanceUsd = next.allowanceUsd ?? TOKEN_PASS_ALLOWANCE_USD;
    const periodStartDay = next.periodStartDay ?? TOKEN_PASS_PERIOD_START_DAY;

    const work = async (): Promise<Snapshot> => {
      try {
        const period = periodAt(now(), periodStartDay);
        const renewal = nextRenewal(period, periodStartDay);
        const url = `${GATEWAY}?start_date=${period.start}&end_date=${period.end}`
          + '&group_by=day&provider=token-pass';
        const response = await request(url, {
          headers: { Authorization: `Bearer ${next.key}` },
          redirect: 'error',
          signal: controller.signal,
        });
        if (gen !== generation || controller.signal.aborted) return empty('unavailable', config);
        const status = classify(response.status);
        if (status !== 'ok') return empty(status ?? 'unavailable', config);

        const daily = parseDays(await response.json());
        const spentUsd = total(densify(daily, period));
        const rateUsdPerDay = dailyRate(densify(daily, period), RECENT_DAYS);
        const { forecast } = project(daily, period, renewal, rateUsdPerDay);
        const projected = forecast[forecast.length - 1]?.usd ?? spentUsd;

        if (disposed || controller.signal.aborted || gen !== generation) {
          return empty('unavailable', config);
        }
        const result: Snapshot = {
          status: 'ok', allowanceUsd,
          spentUsd,
          usedPercent: allowanceUsd > 0 ? spentUsd / allowanceUsd * 100 : null,
          rateUsdPerDay,
          projectedPercent: allowanceUsd > 0 ? projected / allowanceUsd * 100 : null,
          hitDay: hitDay(forecast, allowanceUsd),
          periodStart: period.start, periodEnd: period.end, renewal,
          daily,
          observedAt: now(),
        };
        cached = result;
        return result;
      } catch {
        // Response bodies and keys never reach the client; a failure is just a
        // failure, never a zero spend that would read as a full allowance.
        return empty('unavailable', config);
      } finally {
        clearTimeout(timer);
        if (gen === generation) { pending = null; abort = null; }
      }
    };

    // Deferring also makes synchronous transport failures obey coalescing.
    cached = null; pending = Promise.resolve().then(work); return pending;
  }

  return {
    measure,
    invalidate,
    dispose() { disposed = true; invalidate(); },
  };
}
