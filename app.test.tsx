// @vitest-environment jsdom
import { cleanup, fireEvent, within } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { afterEach, describe, expect, it } from 'vitest';
import type { Snapshot } from './collector.js';
import { axisMax, averagingCopy, paceCopy, percent, scales, GEOMETRY } from './pace.js';

afterEach(cleanup);

const ok = (over: Partial<Snapshot> = {}): Snapshot => ({
  status: 'ok',
  allowanceUsd: 80,
  spentUsd: 67.2,
  usedPercent: 84,
  rateUsdPerDay: 2.8,
  projectedPercent: 104,
  hitDay: '2026-10-27',
  periodStart: '2026-09-28',
  periodEnd: '2026-10-23',
  renewal: '2026-10-28',
  daily: [
    { day: '2026-09-28', usd: 2 },
    { day: '2026-10-23', usd: 3 },
  ],
  observedAt: 1000,
  ...over,
});

describe('copy', () => {
  it('names the renewal day and the day the pass runs out', () => {
    expect(paceCopy({ hitDay: '2026-10-27', renewal: '2026-10-28', usedPercent: 84 })).toEqual({
      headline: '84%',
      renewal: 'Renews Oct 28',
      verdict: 'On pace to hit the limit Oct 27',
    });
  });
  it('stays quiet when the projection never reaches the allowance', () => {
    expect(paceCopy({ hitDay: null, renewal: '2026-10-28', usedPercent: 84 }).verdict).toBeNull();
  });
  it('states exhaustion rather than a verdict of hitting a past day', () => {
    expect(paceCopy({ hitDay: '2026-10-20', renewal: '2026-10-28', usedPercent: 130 }).verdict)
      .toBe('Limit already reached · resets Oct 28');
  });
  it('captions the rate as a percentage of the allowance per day', () => {
    expect(averagingCopy(2.8, 80)).toBe('Averaging 3.5% a day');
    expect(averagingCopy(null, 80)).toBe('No spend recorded yet');
    expect(percent(104)).toBe('104%');
  });
});

describe('chart geometry', () => {
  const grid = GEOMETRY;
  it('keeps the 100% line inside the frame with headroom above the peak', () => {
    expect(axisMax([10, 67], 80)).toBe(120);
    // A projection far past the allowance rescales rather than clipping.
    expect(axisMax([10, 250], 80)).toBeGreaterThan(250);
  });
  it('places every point inside the plot box', () => {
    const s = scales({ grid, start: '2026-09-28', end: '2026-10-28', boundary: '2026-10-23', max: 120 });
    const x0 = s.x('2026-09-28'), x1 = s.x('2026-10-28');
    expect(x0).toBeCloseTo(grid.padLeft);
    expect(x1).toBeCloseTo(grid.width - grid.padRight);
    // The floor and ceiling both stay within the padded region.
    expect(s.y(0)).toBeCloseTo(grid.height - grid.padBottom);
    expect(s.y(120)).toBeCloseTo(grid.padTop);
    // Clamps rather than drawing outside the box for out-of-window days.
    expect(s.x('2026-09-01')).toBeCloseTo(grid.padLeft);
    expect(s.x('2026-12-01')).toBeCloseTo(grid.width - grid.padRight);
  });
  it('puts the boundary at the end of the measured period', () => {
    const s = scales({ grid, start: '2026-09-28', end: '2026-10-28', boundary: '2026-10-23', max: 120 });
    expect(s.boundaryX).toBeGreaterThan(grid.padLeft);
    expect(s.boundaryX).toBeLessThan(grid.width - grid.padRight);
  });
});

describe('panel', () => {
  const mount = async (snapshot: Snapshot, extra: Record<string, unknown> = {}) => {
    const app = await loadPluginApp(() => import('./app.js'));
    return { app, slot: renderSlot(app.navPanels[0]!, { subPath: '' }, {
      settings: { tokenpassAllowanceUsd: 80 },
      rpc: { getPace: () => snapshot },
      ...extra,
    }) };
  };

  it('renders the headline, verdict, chart and legend', async () => {
    const { slot } = await mount(ok());
    expect(await slot.findByText('84%')).toBeTruthy();
    expect(slot.getByText('Renews Oct 28')).toBeTruthy();
    expect(slot.getByText('On pace to hit the limit Oct 27')).toBeTruthy();
    expect(slot.getByText('Averaging 3.5% a day')).toBeTruthy();
    // Legend names all three marks.
    expect(slot.getByText('Usage')).toBeTruthy();
    expect(slot.getByText('Forecast')).toBeTruthy();
    expect(slot.getByText('Monthly limit')).toBeTruthy();
    // The chart is one accessible image with a described summary.
    const chart = slot.getByRole('img');
    expect(chart.getAttribute('aria-label')).toContain('84%');
    // Measured (solid) and forecast (dashed) are separate stroked paths.
    const strokes = Array.from(slot.container.querySelectorAll('path[stroke]'));
    expect(strokes).toHaveLength(2);
    expect(strokes[1]!.getAttribute('stroke-dasharray')).toBe('6 5');
  });

  it('shows the projected figure in the warning tone when it exceeds the allowance', async () => {
    const { slot } = await mount(ok());
    const projected = await slot.findByText('104%');
    expect(projected.className).toContain('--warning-text');
  });

  it('refreshes on demand', async () => {
    let calls = 0;
    const app = await loadPluginApp(() => import('./app.js'));
    const slot = renderSlot(app.navPanels[0]!, { subPath: '' }, {
      settings: {},
      rpc: { getPace: () => { calls++; return ok(); } },
    });
    await slot.findByText('84%');
    fireEvent.click(slot.getByRole('button', { name: 'Refresh usage' }));
    await slot.findByText('84%');
    expect(calls).toBe(2);
  });

  it('does not blame the key for a failed read', async () => {
    const { slot } = await mount(ok({ status: 'unavailable', spentUsd: null, usedPercent: null }));
    const message = await slot.findByText(/Unable to read usage right now/i);
    // A valid key reads 403/5xx fine on another day; only 401 is a key problem.
    expect(message.textContent).not.toMatch(/re-enter|invalid key|wrong key/i);
  });

  it('walks a first-time user through setup instead of showing an empty chart', async () => {
    const { slot } = await mount(ok({ status: 'unauthenticated', spentUsd: null, usedPercent: null }));
    expect(await slot.findByText('Set up Token Pass tracking')).toBeTruthy();
    // The three settings that matter, each with where to find it.
    expect(slot.getByText(/AI Gateway → API Keys/i)).toBeTruthy();
    expect(slot.getByText(/Billing → the day of your next invoice/i)).toBeTruthy();
    expect(slot.getByText(/minus measured spend/i)).toBeTruthy();
    expect(slot.getByText(/Tools → Token Pass Pace → Settings/i)).toBeTruthy();
  });

  it('does not leak a failed RPC cause', async () => {
    const app = await loadPluginApp(() => import('./app.js'));
    const slot = renderSlot(app.navPanels[0]!, { subPath: '' }, {
      settings: {},
      rpc: { getPace: () => { throw Error('private credential'); } },
    });
    expect(await slot.findByRole('alert')).toBeTruthy();
    expect(slot.queryByText(/private credential/)).toBeNull();
  });

  it('colours the forecast key to match the line, not always as a warning', async () => {
    // Inside the allowance the forecast line stays in the success tone...
    const safe = await mount(ok({ projectedPercent: 40, hitDay: null }));
    const safeKey = (await within(safe.slot.container).findByText('Forecast')).firstElementChild!;
    expect(safeKey.className).toContain('bg-[var(--success)]');

    // ...and only turns to the warning tone once the projection crosses 100%.
    const over = await mount(ok({ projectedPercent: 104, hitDay: '2026-10-27' }));
    const overKey = (await within(over.slot.container).findByText('Forecast')).firstElementChild!;
    expect(overKey.className).toContain('bg-[var(--warning)]');
  });

  it('does not show setup steps to an install that is already working', async () => {
    const { slot } = await mount(ok());
    await slot.findByText('84%');
    expect(slot.queryByText('Set up Token Pass tracking')).toBeNull();
  });

  it('shows setup steps only when a key is missing, not on a failed read', async () => {
    const { slot } = await mount(ok({ status: 'unavailable', spentUsd: null, usedPercent: null }));
    await slot.findByText(/Unable to read usage right now/i);
    expect(slot.queryByText('Set up Token Pass tracking')).toBeNull();
  });
});
