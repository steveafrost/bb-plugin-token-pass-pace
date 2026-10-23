import { describe, expect, it } from 'vitest';
import {
  addDays, cumulative, dailyRate, daysBetween, daysOf, densify, hitDay,
  nextRenewal, parseDays, periodAt, project, total,
} from './pass.js';

const at = (iso: string) => Date.parse(iso);

describe('periodAt', () => {
  it('starts on the renewal day and ends today', () => {
    expect(periodAt(at('2026-10-22T18:42:00Z'), 20)).toEqual({ start: '2026-10-20', end: '2026-10-22' });
    expect(periodAt(at('2026-10-22T00:00:00Z'), 1)).toEqual({ start: '2026-10-01', end: '2026-10-22' });
  });
  it('reaches back a month before the renewal day', () => {
    expect(periodAt(at('2026-10-02T12:00:00Z'), 20)).toEqual({ start: '2026-09-20', end: '2026-10-02' });
  });
  it('treats the renewal day itself as the period start, not the prior month', () => {
    expect(periodAt(at('2026-10-20T00:00:01Z'), 20).start).toBe('2026-10-20');
  });
  it('clamps day 31 into February in both months', () => {
    // 2026-02 has 28 days: the previous period started on Jan 31, this one Feb 28.
    expect(periodAt(at('2026-03-01T00:00:00Z'), 31)).toEqual({ start: '2026-02-28', end: '2026-03-01' });
    expect(periodAt(at('2026-02-27T00:00:00Z'), 31)).toEqual({ start: '2026-01-31', end: '2026-02-27' });
  });
  it('handles a leap-year February and a January period that crosses the year', () => {
    expect(periodAt(at('2028-03-05T00:00:00Z'), 31).start).toBe('2028-02-29');
    expect(periodAt(at('2026-01-10T00:00:00Z'), 20)).toEqual({ start: '2025-12-20', end: '2026-01-10' });
  });
});

describe('nextRenewal', () => {
  it('is the renewal day of the following month', () => {
    expect(nextRenewal({ start: '2026-10-20', end: '2026-10-22' }, 20)).toBe('2026-11-20');
  });
  it('rolls the year over in December', () => {
    expect(nextRenewal({ start: '2026-12-20', end: '2027-01-02' }, 20)).toBe('2027-01-20');
  });
  it('clamps into short months', () => {
    expect(nextRenewal({ start: '2026-01-31', end: '2026-02-10' }, 31)).toBe('2026-02-28');
  });
});

describe('day arithmetic', () => {
  it('counts inclusively across a month boundary', () => {
    expect(daysBetween('2026-10-30', '2026-11-02')).toBe(4);
    expect(daysBetween('2026-10-20', '2026-10-20')).toBe(1);
  });
  it('enumerates and steps days', () => {
    expect(daysOf({ start: '2026-10-30', end: '2026-11-02' })).toEqual([
      '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02',
    ]);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('parseDays', () => {
  it('sums duplicate days and sorts', () => {
    expect(parseDays({ results: [
      { day: '2026-10-21', total_cost: 0.5 },
      { day: '2026-10-20', total_cost: 0.25 },
      { day: '2026-10-21', total_cost: 0.25 },
    ] })).toEqual([
      { day: '2026-10-20', usd: 0.25 },
      { day: '2026-10-21', usd: 0.75 },
    ]);
  });
  it('skips rows without a day and accepts an empty report', () => {
    expect(parseDays({ results: [{ provider: 'token-pass', total_cost: 1 }] })).toEqual([]);
    expect(parseDays({ results: [] })).toEqual([]);
  });
  it.each([
    null, {}, [], { results: null }, { results: [null] },
    { results: [{ day: '2026-10-20' }] },
    { results: [{ day: '2026-10-20', total_cost: '1' }] },
    { results: [{ day: '2026-10-20', total_cost: -1 }] },
    { results: [{ day: '2026-10-20', total_cost: Infinity }] },
    { results: [{ day: 'yesterday', total_cost: 1 }] },
  ])('rejects malformed report %j', value => expect(() => parseDays(value)).toThrow());
});

describe('series shaping', () => {
  const period = { start: '2026-10-20', end: '2026-10-23' };
  it('fills missing days with a truthful zero', () => {
    expect(densify([{ day: '2026-10-22', usd: 2 }], period)).toEqual([
      { day: '2026-10-20', usd: 0 },
      { day: '2026-10-21', usd: 0 },
      { day: '2026-10-22', usd: 2 },
      { day: '2026-10-23', usd: 0 },
    ]);
  });
  it('accumulates and totals', () => {
    const daily = densify([{ day: '2026-10-21', usd: 1 }, { day: '2026-10-23', usd: 2 }], period);
    expect(cumulative(daily)).toEqual([
      { day: '2026-10-20', usd: 0 },
      { day: '2026-10-21', usd: 1 },
      { day: '2026-10-22', usd: 1 },
      { day: '2026-10-23', usd: 3 },
    ]);
    expect(total(daily)).toBe(3);
  });
});

describe('dailyRate', () => {
  it('averages the trailing window only', () => {
    // A burst on day 1 must not dominate once it leaves the window.
    const daily = [10, 0, 0, 0, 0, 0, 0, 0, 0, 2].map((usd, i) => ({ day: addDays('2026-10-01', i), usd }));
    expect(dailyRate(daily, 7)).toBeCloseTo(2 / 7);
  });
  it('counts quiet days as real zeros and divides by the window actually present', () => {
    expect(dailyRate([{ day: '2026-10-20', usd: 5 }, { day: '2026-10-21', usd: 0 }], 7)).toBeCloseTo(2.5);
    expect(dailyRate([{ day: '2026-10-20', usd: 5 }], 7)).toBe(5);
    expect(dailyRate([], 7)).toBe(0);
  });
});

describe('project', () => {
  const period = { start: '2026-10-20', end: '2026-10-22' };
  it('joins measured and forecast at the last observed day', () => {
    const daily = [{ day: '2026-10-20', usd: 1 }, { day: '2026-10-21', usd: 1 }];
    const { measured, forecast } = project(daily, period, '2026-11-20', 1);
    expect(measured).toEqual([
      { day: '2026-10-20', usd: 1, forecast: false },
      { day: '2026-10-21', usd: 2, forecast: false },
      { day: '2026-10-22', usd: 2, forecast: false },
    ]);
    // Shares the measured endpoint, then runs to the renewal day.
    expect(forecast[0]).toEqual({ day: '2026-10-22', usd: 2, forecast: true });
    expect(forecast[forecast.length - 1]?.day).toBe('2026-11-20');
    expect(forecast[forecast.length - 1]?.usd).toBeCloseTo(2 + 29);
  });
  it('produces a flat forecast when nothing has been spent', () => {
    const { forecast } = project([], period, '2026-10-25', 0);
    expect(forecast).toEqual([
      { day: '2026-10-22', usd: 0, forecast: true },
      { day: '2026-10-23', usd: 0, forecast: true },
      { day: '2026-10-24', usd: 0, forecast: true },
      { day: '2026-10-25', usd: 0, forecast: true },
    ]);
  });
});

describe('hitDay', () => {
  const forecast = [
    { day: '2026-10-22', usd: 60, forecast: true },
    { day: '2026-10-23', usd: 79, forecast: true },
    { day: '2026-10-24', usd: 81, forecast: true },
  ];
  it('finds the first day at or over the allowance', () => {
    expect(hitDay(forecast, 80)).toBe('2026-10-24');
  });
  it('is null when already over, or when the projection stays under', () => {
    expect(hitDay(forecast, 50)).toBe('2026-10-22');
    expect(hitDay(forecast, 500)).toBeNull();
  });
});
