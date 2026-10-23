/**
 * Token Pass has no balance endpoint and no billing-period endpoint. Both
 * facts shape this module:
 *
 * - `remaining = allowance - spend`, exactly as Credit Balances derives it,
 *   because `/v1/credits` is the *regular* Gateway balance and excludes the
 *   pass.
 * - The billing period is reconstructed from `periodStartDay` (the renewal
 *   day), clamped so day 31 stays inside short months. No API exposes the
 *   real period, so this is configuration, not detection.
 *
 * Everything here is pure so the calendar and arithmetic edge cases are
 * testable without a network or a clock.
 */

/** Documented Token Pass credit per billing period, overridable in settings. */
export const TOKEN_PASS_ALLOWANCE_USD = 80;
/** Default renewal day — the first of the month. */
export const TOKEN_PASS_PERIOD_START_DAY = 1;

/** One day of the measured series. `day` is a UTC `yyyy-mm-dd` key. */
export type DayTotal = { day: string; usd: number };

/** A billing period as UTC day keys, inclusive at both ends. */
export type Period = { start: string; end: string };

const DAY_MS = 86_400_000;

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const dayMs = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);

const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

const isoDay = (year: number, month: number, day: number): string =>
  `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/**
 * The current period, from the last renewal day up to `now` (inclusive).
 *
 * `end` is today, not the next renewal date: the measured part of the series
 * stops at today, and the forecast takes over from there. Clamping means a
 * renewal day of 31 falls back to the 28/29/30 of a short month in *both* the
 * current and the previous month, so a February period never starts on the
 * 3rd of March.
 */
export function periodAt(now: number, startDay: number): Period {
  const date = new Date(now);
  const year = date.getUTCFullYear(), month = date.getUTCMonth(), day = date.getUTCDate();
  const startThisMonth = Math.min(startDay, daysInMonth(year, month));
  const started = day >= startThisMonth;
  const sy = started ? year : month === 0 ? year - 1 : year;
  const sm = started ? month : month === 0 ? 11 : month - 1;
  return {
    start: isoDay(sy, sm, Math.min(startDay, daysInMonth(sy, sm))),
    end: utcDay(Date.parse(`${isoDay(year, month, day)}T00:00:00.000Z`)),
  };
}

/** The renewal day that follows `period` — the end of the forecast window. */
export function nextRenewal(period: Period, startDay: number): string {
  const start = new Date(`${period.start}T00:00:00.000Z`);
  const year = start.getUTCFullYear(), month = start.getUTCMonth();
  const ny = month === 11 ? year + 1 : year;
  const nm = month === 11 ? 0 : month + 1;
  return isoDay(ny, nm, Math.min(startDay, daysInMonth(ny, nm)));
}

/** Inclusive count of days between two UTC day keys. */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayMs(to) - dayMs(from)) / DAY_MS) + 1;
}

/** Every day key in `period`, in order. */
export function daysOf(period: Period): string[] {
  const total = daysBetween(period.start, period.end);
  const first = dayMs(period.start);
  return Array.from({ length: Math.max(0, total) }, (_, i) => utcDay(first + i * DAY_MS));
}

/** Adds `count` days to a day key. */
export function addDays(day: string, count: number): string {
  return utcDay(dayMs(day) + count * DAY_MS);
}

/**
 * Parses `group_by=day` report rows into a dense daily series.
 *
 * The endpoint omits days with no traffic, so a missing day is a truthful
 * zero rather than unknown data — unlike the *balance*, where a malformed
 * report must throw instead of silently reading as "nothing spent". Any row
 * that is present must still be well formed.
 */
export function parseDays(value: unknown): DayTotal[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid report.');
  const { results } = value as Record<string, unknown>;
  if (!Array.isArray(results)) throw Error('Invalid report.');
  const seen = new Map<string, number>();
  for (const row of results) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('Invalid report.');
    const entry = row as Record<string, unknown>;
    // A row with no `day` field is not a day row, so it carries no daily total to
    // read; a `day` that is present but unusable is malformed input.
    if (entry.day === undefined) continue;
    if (typeof entry.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.day)) {
      throw Error('Invalid report.');
    }
    if (Number.isNaN(dayMs(entry.day))) throw Error('Invalid report.');
    const cost = entry.total_cost;
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) throw Error('Invalid report.');
    seen.set(entry.day, (seen.get(entry.day) ?? 0) + cost);
  }
  return [...seen].sort(([a], [b]) => a.localeCompare(b)).map(([day, usd]) => ({ day, usd }));
}

/** Clips a series to `period` and fills the gaps with zero. */
export function densify(series: DayTotal[], period: Period): DayTotal[] {
  const byDay = new Map(series.map(entry => [entry.day, entry.usd]));
  return daysOf(period).map(day => ({ day, usd: byDay.get(day) ?? 0 }));
}

/** Cumulative spend at the end of each day, in USD. */
export function cumulative(daily: DayTotal[]): DayTotal[] {
  let total = 0;
  return daily.map(({ day, usd }) => {
    total += usd;
    return { day, usd: total };
  });
}

/** Sum of a series. */
export function total(series: DayTotal[]): number {
  return series.reduce((sum, entry) => sum + entry.usd, 0);
}

/**
 * Spend rate in USD per day from the trailing `window` days of `daily`.
 *
 * Trailing rather than whole-period: an early burst or a quiet first week
 * would otherwise dominate the projection for the rest of the period, and the
 * "Averaging X% a day" caption is a statement about current behavior. Days
 * with no traffic are real zeros and stay in the average, so a paused week
 * correctly pulls the forecast down.
 */
export function dailyRate(daily: DayTotal[], window: number): number {
  if (daily.length === 0) return 0;
  const span = daily.slice(Math.max(0, daily.length - window));
  // A one-day-old period would otherwise produce an infinite rate.
  return total(span) / Math.max(1, span.length);
}

/** A point on either the measured or the forecast half of the chart. */
export type Point = { day: string; usd: number; forecast: boolean };

/**
 * Builds both halves of the chart: measured cumulative spend through
 * `period.end`, then a straight projection at `rate` out to `renewal`.
 *
 * The forecast starts *at* the last measured point (shared, not duplicated
 * past it) so the two lines join without a gap, which is what the opencode
 * widget does.
 */
export function project(daily: DayTotal[], period: Period, renewal: string, rate: number): {
  measured: Point[];
  forecast: Point[];
} {
  const measured = cumulative(densify(daily, period));
  const last = measured[measured.length - 1];
  const start = last ?? { day: period.end, usd: 0 };
  const horizon = Math.max(0, daysBetween(period.end, renewal) - 1);
  const forecast: Point[] = [{ day: start.day, usd: start.usd, forecast: true }];
  for (let i = 1; i <= horizon; i++) {
    const day = addDays(period.end, i);
    if (day > renewal) break;
    forecast.push({ day, usd: start.usd + rate * i, forecast: true });
  }
  return { measured: measured.map(({ day, usd }) => ({ day, usd, forecast: false })), forecast };
}

/** The first day the projection reaches `allowanceUsd` after `period.end`, if any. */
export function hitDay(forecast: Point[], allowanceUsd: number): string | null {
  for (const point of forecast) if (point.usd >= allowanceUsd) return point.day;
  return null;
}
