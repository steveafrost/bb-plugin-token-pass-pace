import { useMemo, useState } from 'react';
import type { Point } from '../pass.js';
import { addDays, daysBetween } from '../pass.js';
import {
  GEOMETRY, area, axisMax, line, percent, scales, shortDate, usd,
} from '../pace.js';

/**
 * The chart is two series on one calendar axis: a solid measured line up to
 * today, then a dashed forecast to the renewal day. The forecast region is
 * hatched so the boundary reads at a glance, and both the 100% rule and the
 * forecast's final value are annotated — the reference widget's cues, which
 * tell you *when* the pass runs out without needing a tooltip.
 */
export function PaceChart({ measured, forecast, allowanceUsd, usedPercent }: {
  measured: Point[];
  forecast: Point[];
  allowanceUsd: number;
  usedPercent: number;
}) {
  const [hover, setHover] = useState<string | null>(null);

  const geometry = useMemo(() => {
    const start = measured[0]?.day ?? forecast[0]?.day;
    const end = forecast[forecast.length - 1]?.day ?? measured[measured.length - 1]?.day;
    if (!start || !end) return null;
    // Measurement stops at the last measured day; the window runs to renewal.
    const boundary = measured[measured.length - 1]?.day ?? start;
    const values = [...measured, ...forecast].map(p => p.usd);
    const max = axisMax(values, allowanceUsd);
    return { start, end, max, s: scales({ grid: GEOMETRY, start, end, boundary, max }) };
  }, [measured, forecast, allowanceUsd]);

  if (!geometry) return null;
  const { s, max, start, end } = geometry;
  const floorY = GEOMETRY.height - GEOMETRY.padBottom;
  const measuredLast = measured[measured.length - 1];
  const forecastLast = forecast[forecast.length - 1];
  const limitY = s.y(allowanceUsd);
  const over = forecastLast !== undefined && forecastLast.usd > allowanceUsd;

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${GEOMETRY.width} ${GEOMETRY.height}`}
        className="block h-auto w-full"
        role="img"
        aria-label={describe(forecast, allowanceUsd, usedPercent)}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          {/* The hatch is theme-neutral: it uses the warning tone at low opacity
              so it reads as "projected", not as a third data series. */}
          <pattern id={`hatch-${start}`} width="8" height="8" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2="0" y2="8" stroke="var(--warning)" strokeWidth="1" strokeOpacity="0.22" />
          </pattern>
          <linearGradient id={`fill-${start}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--success)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--success)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Forecast wash across the projected window. */}
        <rect
          x={s.boundaryX} y={GEOMETRY.padTop}
          width={Math.max(0, GEOMETRY.width - GEOMETRY.padRight - s.boundaryX)}
          height={floorY - GEOMETRY.padTop}
          fill={`url(#hatch-${start})`}
        />

        {/* Horizontal grid + y labels. */}
        {s.yTicks.map(tick => (
          <g key={tick}>
            <line
              x1={GEOMETRY.padLeft} x2={GEOMETRY.width - GEOMETRY.padRight}
              y1={s.y(tick)} y2={s.y(tick)}
              stroke="var(--border)" strokeWidth="1"
            />
            <text
              x={GEOMETRY.padLeft - 10} y={s.y(tick)}
              textAnchor="end" dominantBaseline="middle"
              fontSize="13" fill="var(--muted-foreground)"
            >{percent(tick / allowanceUsd * 100)}</text>
          </g>
        ))}

        {/* The 100% rule, labelled in the plot so it is unambiguous. */}
        <line
          x1={GEOMETRY.padLeft} x2={GEOMETRY.width - GEOMETRY.padRight}
          y1={limitY} y2={limitY}
          stroke="var(--muted-foreground)" strokeWidth="1.5"
          strokeDasharray="5 5" strokeOpacity="0.7"
        />

        <path d={area(measured, s, floorY)} fill={`url(#fill-${start})`} />
        <path
          d={line(measured, s)} fill="none"
          stroke="var(--success)" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round"
        />
        <path
          d={line(forecast, s)} fill="none"
          stroke={over ? 'var(--warning)' : 'var(--success)'} strokeWidth="2.5"
          strokeDasharray="6 5" strokeLinecap="round" strokeLinejoin="round"
        />

        {/* Markers: where measurement stops, and where the forecast lands. */}
        {measuredLast ? (
          <circle
            cx={s.x(measuredLast.day)} cy={s.y(measuredLast.usd)} r="5"
            fill="var(--card)" stroke="var(--success)" strokeWidth="2.5"
          />
        ) : null}
        {forecastLast ? (
          <>
            <circle
              cx={s.x(forecastLast.day)} cy={s.y(forecastLast.usd)} r="5"
              fill="var(--card)" stroke={over ? 'var(--warning)' : 'var(--success)'} strokeWidth="2.5"
            />
            <text
              x={s.x(forecastLast.day) - 6} y={s.y(forecastLast.usd) - 14}
              textAnchor="end" fontSize="14" fontWeight="600"
              fill={over ? 'var(--warning-text)' : 'var(--muted-foreground)'}
            >{percent(forecastLast.usd / allowanceUsd * 100)}</text>
          </>
        ) : null}

        {/* Month-start gridlines. Their labels live in the axis strip below,
            which is the one place the reference widget prints dates. */}
        {s.xTicks.map(tick => (
          <line
            key={tick.day}
            x1={tick.x} x2={tick.x} y1={GEOMETRY.padTop} y2={floorY}
            stroke="var(--border)" strokeWidth="1" strokeDasharray="3 4" strokeOpacity="0.55"
          />
        ))}

        {/* Hover targets, one per day, for the tooltip-free read-out. */}
        {hoverFor(hover, measured, forecast, start, end).map(point => (
          <g key={point.day}>
            <circle
              cx={s.x(point.day)} cy={s.y(point.usd)} r="4"
              fill="var(--card)" stroke={point.forecast ? 'var(--warning)' : 'var(--success)'} strokeWidth="2"
            />
          </g>
        ))}
        {/* A transparent strip per day keeps hover cheap and covers the gaps. */}
        {Array.from({ length: daysBetween(start, end) }, (_, i) => {
          const day = addDays(start, i);
          const width = (GEOMETRY.width - GEOMETRY.padLeft - GEOMETRY.padRight) / Math.max(1, daysBetween(start, end) - 1);
          return (
            <rect
              key={day}
              x={s.x(day) - width / 2} y={GEOMETRY.padTop}
              width={width} height={floorY - GEOMETRY.padTop}
              fill="transparent"
              onMouseEnter={() => setHover(day)}
            />
          );
        })}
      </svg>
      {hover === null ? null : <HoverChip day={hover} measured={measured} forecast={forecast} allowanceUsd={allowanceUsd} />}
    </figure>
  );
}

/** The hovered day's point, from whichever series owns it. */
function hoverFor(day: string | null, measured: Point[], forecast: Point[], _start: string, _end: string): Point[] {
  if (day === null) return [];
  const hit = measured.find(p => p.day === day) ?? forecast.find(p => p.day === day);
  return hit ? [hit] : [];
}

function HoverChip({ day, measured, forecast, allowanceUsd }: {
  day: string; measured: Point[]; forecast: Point[]; allowanceUsd: number;
}) {
  const point = measured.find(p => p.day === day) ?? forecast.find(p => p.day === day);
  if (!point) return null;
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{shortDate(day)}</span>
      {' · '}
      {point.forecast ? 'projected ' : 'measured '}
      {usd(point.usd)} ({percent(point.usd / allowanceUsd * 100)})
    </p>
  );
}

function describe(forecast: Point[], allowanceUsd: number, usedPercent: number): string {
  const last = forecast[forecast.length - 1];
  if (!last) return 'Token Pass usage chart';
  return `Token Pass usage this period: ${percent(usedPercent)} used, `
    + `projected ${percent(last.usd / allowanceUsd * 100)} by ${shortDate(last.day)}.`;
}
