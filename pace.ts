import type { Point } from './pass.js';
import { addDays, daysBetween } from './pass.js';

/**
 * Presentation logic for the pace chart, kept free of React so the geometry
 * and the copy can be tested directly — the parts most likely to be subtly
 * wrong (a line that leaves the box, a date that disagrees with the headline).
 */

export type Geometry = {
  width: number;
  height: number;
  padTop: number;
  padBottom: number;
  padLeft: number;
  padRight: number;
};

export const GEOMETRY: Geometry = {
  width: 960, height: 300, padTop: 28, padBottom: 40, padLeft: 56, padRight: 24,
};

/**
 * The y-axis top. The reference widget anchors the scale to the 100% line
 * whenever the projection stays near it, so "how far over" is read against a
 * stable frame instead of a rescaling axis; a projection far beyond the
 * allowance would otherwise flatten every measured point against the floor.
 */
export function axisMax(values: number[], allowanceUsd: number): number {
  const peak = Math.max(allowanceUsd, ...values.filter(Number.isFinite));
  if (peak <= allowanceUsd) return allowanceUsd * 1.5;
  // Keep headroom above the peak so the final marker is never on the edge.
  const step = allowanceUsd * 0.5;
  return Math.ceil((peak * 1.08) / step) * step;
}

export type Scales = {
  x: (day: string) => number;
  y: (usd: number) => number;
  /** Where the period stops and the forecast starts. */
  boundaryX: number;
  yTicks: number[];
  /** Vertical gridlines at month starts and the window edges. */
  xTicks: { day: string; x: number }[];
};

/**
 * Maps day keys and USD onto the plot box. The x-axis is *calendar* time
 * across the whole window, so a short measured period and a long forecast stay
 * proportional — the forecast must look like the remaining part of the month.
 *
 * `end` is the right edge of the *window* (the renewal day) while `boundary`
 * is where measurement stops (today). They are different points whenever the
 * forecast is drawn, and conflating them would put the hatch in the wrong place.
 */
export function scales(args: {
  grid: Geometry;
  start: string;
  end: string;
  boundary: string;
  max: number;
}): Scales {
  const { grid, start, end, boundary, max } = args;
  const total = Math.max(1, daysBetween(start, end));
  const lastIndex = Math.max(1, total - 1);
  const plotW = grid.width - grid.padLeft - grid.padRight;
  const plotH = grid.height - grid.padTop - grid.padBottom;
  const clamp = (index: number) => Math.max(0, Math.min(lastIndex, index));
  const x = (day: string) =>
    grid.padLeft + (clamp(daysBetween(start, day) - 1) / lastIndex) * plotW;
  const y = (usd: number) => grid.padTop + plotH - (usd / max) * plotH;
  // Four evenly spaced y ticks starting at the floor, which is always 0.
  const yTicks = Array.from({ length: 4 }, (_, i) => (max * i) / 3);
  // Month-start gridlines, plus the two window edges.
  const xTicks: { day: string; x: number }[] = [];
  for (let i = 0; i < total; i++) {
    const day = addDays(start, i);
    if (day.endsWith('-01') || i === 0 || i === total - 1) xTicks.push({ day, x: x(day) });
  }
  return { x, y, boundaryX: x(boundary), yTicks, xTicks };
}

/** An SVG path through the points, or an empty string for fewer than one. */
export function line(points: Point[], s: Pick<Scales, 'x' | 'y'>): string {
  if (points.length === 0) return '';
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${s.x(p.day).toFixed(2)},${s.y(p.usd).toFixed(2)}`)
    .join(' ');
}

/** Closes a line down to the floor so it can be filled. */
export function area(points: Point[], s: Pick<Scales, 'x' | 'y'>, floorY: number): string {
  if (points.length === 0) return '';
  const first = points[0]!, last = points[points.length - 1]!;
  return `${line(points, s)} L${s.x(last.day).toFixed(2)},${floorY.toFixed(2)} L${s.x(first.day).toFixed(2)},${floorY.toFixed(2)} Z`;
}

/** `Oct 27` — the compact date the headline and axis use. */
export function shortDate(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

/** `OCT 27` — the axis strip is uppercase, as in the reference widget. */
export function axisDate(day: string): string {
  return shortDate(day).toUpperCase();
}

/**
 * The dates printed under the axis: the window edges plus each month start
 * between them, so a reader can locate a point without a tooltip. Kept to one
 * label per month so a long period cannot crowd the strip.
 */
export function axisDays(start: string, end: string): string[] {
  const days: string[] = [start];
  if (start.slice(0, 7) === end.slice(0, 7)) {
    for (let i = 1; ; i++) {
      const day = addDays(start, i);
      if (day >= end) break;
      if (day.endsWith('-01')) days.push(day);
    }
  } else {
    for (let day = start; day <= end; day = addDays(day, 1)) {
      if (day.endsWith('-01') && day !== start) days.push(day);
    }
  }
  days.push(end);
  return days.filter((day, i) => days.indexOf(day) === i);
}

export const percent = (value: number): string => `${value.toFixed(0)}%`;

export const usd = (value: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);

/**
 * The subline. It names the next renewal day (when the credit resets) and,
 * when the trailing rate actually reaches the allowance before then, the day
 * it runs out — the whole point of the widget.
 */
export function paceCopy(args: {
  hitDay: string | null;
  renewal: string;
  usedPercent: number;
}): { headline: string; renewal: string; verdict: string | null } {
  const over = args.usedPercent >= 100;
  return {
    headline: args.usedPercent >= 100 && args.usedPercent < 100.5
      ? '100%'
      : percent(args.usedPercent),
    renewal: `Renews ${shortDate(args.renewal)}`,
    verdict: args.hitDay
      ? over ? `Limit already reached · resets ${shortDate(args.renewal)}`
        : `On pace to hit the limit ${shortDate(args.hitDay)}`
      : null,
  };
}

/** The caption under the axis strip. */
export function averagingCopy(rateUsdPerDay: number | null, allowanceUsd: number): string {
  if (rateUsdPerDay === null || allowanceUsd <= 0) return 'No spend recorded yet';
  const perDay = rateUsdPerDay / allowanceUsd * 100;
  return `Averaging ${perDay.toFixed(1)}% a day`;
}
