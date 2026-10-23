import { describe, expect, it, vi } from 'vitest';
import { classify, createCollector } from './collector.js';

const AT = Date.parse('2026-10-22T12:00:00Z');
const config = { enabled: true, key: ' fixture-key ', allowanceUsd: 80, periodStartDay: 20 };

const report = (rows: { day: string; total_cost: number }[]) =>
  Response.json({ results: rows.map(row => ({ ...row, request_count: 1 })) });

describe('classify', () => {
  it('treats only 401 as a credential problem', () => {
    expect(classify(200)).toBe('ok');
    expect(classify(401)).toBe('unauthenticated');
    // A valid key can still be refused or fail upstream; that is not a bad key.
    expect(classify(403)).toBe('unavailable');
    expect(classify(500)).toBe('unavailable');
  });
});

describe('collector', () => {
  it('derives spend, rate and projection from the daily series', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => report([
      { day: '2026-10-20', total_cost: 4 },
      { day: '2026-10-21', total_cost: 2 },
      { day: '2026-10-22', total_cost: 2 },
    ]));
    const c = createCollector({ fetch, now: () => AT });
    const snapshot = await c.measure(config);
    expect(snapshot.status).toBe('ok');
    expect(snapshot.spentUsd).toBeCloseTo(8);
    expect(snapshot.usedPercent).toBeCloseTo(10);
    expect(snapshot.periodStart).toBe('2026-10-20');
    expect(snapshot.periodEnd).toBe('2026-10-22');
    expect(snapshot.renewal).toBe('2026-11-20');
    // Trailing 7-day average over 3 observed days.
    expect(snapshot.rateUsdPerDay).toBeCloseTo(8 / 3);
    // 29 forecast days at that rate on top of what is spent.
    expect(snapshot.projectedPercent).toBeCloseTo((8 + (8 / 3) * 29) / 80 * 100);
    c.dispose();
  });

  it('requests the day series for the token-pass provider only', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => report([]));
    const c = createCollector({ fetch, now: () => AT });
    await c.measure(config);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('group_by=day');
    expect(url).toContain('provider=token-pass');
    expect(url).toContain('start_date=2026-10-20');
    expect(url).toContain('end_date=2026-10-22');
    expect(init.headers).toEqual({ Authorization: 'Bearer fixture-key' });
    c.dispose();
  });

  it('reports an empty period as zero without inventing a full balance', async () => {
    const c = createCollector({ fetch: async () => report([]), now: () => AT });
    const snapshot = await c.measure(config);
    expect(snapshot.spentUsd).toBe(0);
    expect(snapshot.usedPercent).toBe(0);
    expect(snapshot.hitDay).toBeNull();
    c.dispose();
  });

  it('flags the day the projection crosses the allowance', async () => {
    const c = createCollector({
      fetch: async () => report([{ day: '2026-10-22', total_cost: 40 }]),
      now: () => AT,
    });
    const snapshot = await c.measure(config);
    // 50% used in 3 days → ~$13.33/day, so the remaining $40 lasts 3 more days
    // and the pass runs out on Oct 25, long before the Nov 20 renewal.
    expect(snapshot.usedPercent).toBeCloseTo(50);
    expect(snapshot.rateUsdPerDay).toBeCloseTo(40 / 3);
    expect(snapshot.hitDay).toBe('2026-10-25');
    c.dispose();
  });

  it('never requests when disabled or keyless, and keeps the calendar', async () => {
    const fetch = vi.fn();
    const c = createCollector({ fetch, now: () => AT });
    const off = await c.measure({ ...config, enabled: false });
    expect(off.status).toBe('disabled');
    expect(off.periodStart).toBe('2026-10-20');
    expect((await c.measure({ ...config, key: '  ' })).status).toBe('unauthenticated');
    expect(fetch).not.toHaveBeenCalled();
    c.dispose();
  });

  it.each([401, 403, 429, 500])('classifies HTTP %s without leaking the body', async status => {
    const c = createCollector({
      fetch: async () => new Response('private body', { status }),
      now: () => AT,
    });
    const snapshot = await c.measure(config);
    expect(snapshot.status).toBe(status === 401 ? 'unauthenticated' : 'unavailable');
    expect(snapshot.spentUsd).toBeNull();
    expect(JSON.stringify(snapshot)).not.toMatch(/fixture|private/);
    c.dispose();
  });

  it('treats a malformed report as unavailable, not as zero spend', async () => {
    const c = createCollector({
      fetch: async () => Response.json({ results: [{ day: '2026-10-20', total_cost: 'lots' }] }),
      now: () => AT,
    });
    const snapshot = await c.measure(config);
    expect(snapshot.status).toBe('unavailable');
    expect(snapshot.spentUsd).toBeNull();
    c.dispose();
  });

  it('coalesces, caches for 60 seconds, and bypasses on refresh', async () => {
    let now = AT;
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => report([]));
    const c = createCollector({ fetch, now: () => now });
    const a = c.measure(config), b = c.measure(config, true);
    expect(a).toBe(b);
    await a;
    await c.measure(config);
    expect(fetch).toHaveBeenCalledTimes(1);
    now = AT + 60_000;
    await c.measure(config);
    await c.measure(config, true);
    expect(fetch).toHaveBeenCalledTimes(3);
    c.dispose();
  });

  it('aborts on disposal and never resolves a stale snapshot', async () => {
    let resolve!: (r: Response) => void;
    let signal: AbortSignal | undefined;
    const fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(r => { resolve = r; });
    });
    const c = createCollector({ fetch, now: () => AT });
    const pending = c.measure(config);
    await Promise.resolve();
    c.dispose();
    expect(signal?.aborted).toBe(true);
    resolve(report([{ day: '2026-10-20', total_cost: 5 }]));
    expect((await pending).spentUsd).toBeNull();
  });
});
