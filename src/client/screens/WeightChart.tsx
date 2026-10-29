/** The weight chart: scale weigh-ins as dots and the trend as a line, in inline SVG. */
import { useState } from 'preact/hooks';
import type { TrendPoint } from '../../domain/body.js';
import { KG_PER_LB } from '../../domain/goals.js';
import { addDays, type LocalDate } from '../../domain/ids.js';
import { dayTitle, lb, shortDate } from './format.js';

export const RANGES = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
] as const;
export type RangeDays = (typeof RANGES)[number]['days'];

const W = 340;
const H = 190;
const PLOT = { left: 4, right: W - 40, top: 10, bottom: H - 24 } as const;
/** Dense ranges get smaller dots so a year of daily weigh-ins stays legible. */
const DOT_R: Readonly<Record<RangeDays, number>> = { 30: 4, 90: 3, 365: 2 };
const STEPS_LB = [0.5, 1, 2, 5, 10, 20, 50] as const;

/** Round tick values in lb covering [lo, hi], at most five of them. */
function ticksLb(lo: number, hi: number): number[] {
  const mid = (lo + hi) / 2;
  const [low, high] = hi - lo < 2 ? [mid - 1, mid + 1] : [lo, hi];
  const step = STEPS_LB.find((s) => (high - low) / s <= 4) ?? 100;
  const first = Math.floor(low / step) * step;
  const count = Math.ceil(high / step) - Math.floor(low / step);
  return Array.from({ length: count + 1 }, (_, i) => first + i * step);
}

const toLb = (kg: number) => kg / KG_PER_LB;

export function WeightChart({
  series,
  goalKg,
  days,
  today,
}: {
  readonly series: readonly TrendPoint[];
  readonly goalKg: number | undefined;
  readonly days: RangeDays;
  readonly today: LocalDate;
}) {
  const [active, setActive] = useState<number | null>(null);
  const start = addDays(today, -(days - 1));
  const points = series.filter((p) => p.date >= start);
  if (points.filter((p) => p.scaleKg !== null).length < 2) {
    return <p class="empty chart-empty">Weigh in on a few more days to draw the chart.</p>;
  }

  const values = points.flatMap((p) => (p.scaleKg === null ? [toLb(p.trendKg)] : [toLb(p.trendKg), toLb(p.scaleKg)]));
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const goalLb = goalKg === undefined ? undefined : toLb(goalKg);
  /** The goal line shows only when it sits near the data, so a far goal never flattens the trend. */
  const showGoal = goalLb !== undefined && goalLb >= lo - (hi - lo) * 0.5 - 1 && goalLb <= hi + (hi - lo) * 0.5 + 1;
  const ticks = ticksLb(Math.min(lo, showGoal ? goalLb : lo), Math.max(hi, showGoal ? goalLb : hi));
  const bottomLb = ticks[0] ?? lo;
  const topLb = ticks.at(-1) ?? hi;

  const x = (i: number) => PLOT.left + (points.length === 1 ? 0 : (i / (points.length - 1)) * (PLOT.right - PLOT.left));
  const y = (pounds: number) => PLOT.top + ((topLb - pounds) / (topLb - bottomLb)) * (PLOT.bottom - PLOT.top);
  const trendPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(toLb(p.trendKg)).toFixed(1)}`).join('');
  const shown = points[active ?? points.length - 1];
  const middle = points[Math.floor((points.length - 1) / 2)];

  const scrub = (event: PointerEvent) => {
    const box = (event.currentTarget instanceof Element ? event.currentTarget : null)?.getBoundingClientRect();
    if (box === undefined || box.width === 0) return;
    const at = ((event.clientX - box.left) / box.width) * W;
    const i = Math.round(((at - PLOT.left) / (PLOT.right - PLOT.left)) * (points.length - 1));
    setActive(Math.min(points.length - 1, Math.max(0, i)));
  };

  return (
    <figure class="weight-chart" aria-label={`Weight over ${RANGES.find((r) => r.days === days)?.label ?? `${days} days`}`}>
      {shown !== undefined && (
        <p class="chart-readout" data-testid="chart-readout">
          <strong>{lb(shown.trendKg)} lb</strong> trend
          {shown.scaleKg !== null && (
            <>
              {' · '}
              <strong>{lb(shown.scaleKg)} lb</strong> scale
            </>
          )}
          <span class="chart-readout-date">{dayTitle(shown.date, today)}</span>
        </p>
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Trend from ${lb(points[0]?.trendKg ?? 0)} to ${lb(points.at(-1)?.trendKg ?? 0)} lb. Every reading is in the weigh-in list below.`}
        onPointerDown={scrub}
        onPointerMove={scrub}
        onPointerLeave={() => setActive(null)}
      >
        {ticks.map((t) => (
          <g key={t} class="chart-grid">
            <line x1={PLOT.left} x2={PLOT.right} y1={y(t)} y2={y(t)} />
            <text x={W - 2} y={y(t)} dy="0.35em" text-anchor="end">
              {t.toLocaleString('en-US', { maximumFractionDigits: 1 })}
            </text>
          </g>
        ))}
        {showGoal && (
          <g class="chart-goal">
            <line x1={PLOT.left} x2={PLOT.right} y1={y(goalLb)} y2={y(goalLb)} />
          </g>
        )}
        {points.map((p, i) =>
          p.scaleKg === null ? null : <circle key={p.date} class="chart-dot" cx={x(i)} cy={y(toLb(p.scaleKg))} r={DOT_R[days]} />,
        )}
        <path class="chart-trend" d={trendPath} />
        {active !== null && <line class="chart-cursor" x1={x(active)} x2={x(active)} y1={PLOT.top} y2={PLOT.bottom} />}
        <g class="chart-axis">
          <text x={PLOT.left} y={H - 6}>
            {points[0] === undefined ? '' : shortDate(points[0].date, today)}
          </text>
          {middle !== undefined && points.length > 6 && (
            <text x={x(Math.floor((points.length - 1) / 2))} y={H - 6} text-anchor="middle">
              {shortDate(middle.date, today)}
            </text>
          )}
          <text x={PLOT.right} y={H - 6} text-anchor="end">
            {shortDate(today, today)}
          </text>
        </g>
      </svg>
      <figcaption class="chart-legend">
        <span>
          <i class="key-dot" /> Scale
        </span>
        <span>
          <i class="key-line" /> Trend
        </span>
        {showGoal && (
          <span>
            <i class="key-line goal" /> Goal {goalLb.toLocaleString('en-US', { maximumFractionDigits: 1 })} lb
          </span>
        )}
      </figcaption>
    </figure>
  );
}

/** The last 30 days of trend as a small line, for the Today tile. */
export function TrendSpark({ series }: { readonly series: readonly TrendPoint[] }) {
  const points = series.slice(-30);
  if (points.length < 2) return null;
  const kg = points.map((p) => p.trendKg);
  const lo = Math.min(...kg);
  const span = Math.max(...kg) - lo || 1;
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${((i / (points.length - 1)) * 96 + 2).toFixed(1)},${(30 - ((p.trendKg - lo) / span) * 26).toFixed(1)}`).join('');
  return (
    <svg class="spark" viewBox="0 0 100 32" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
