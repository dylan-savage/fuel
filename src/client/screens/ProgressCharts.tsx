/** The Progress sheet's charts in inline SVG, on WeightChart's classes, axis and scrub. */
import { useState } from 'preact/hooks';
import type { LocalDate } from '../../domain/ids.js';
import { lineOf, setsLine, valueOf, type ChartMode, type LiftPoint, type LiftRange, type LiftSeries } from '../../domain/progress.js';
import type { ShowUpView } from '../views.js';
import { count, shortDate } from './format.js';
import { ticksLb } from './WeightChart.js';

const W = 340;
const grouped = (n: number) => Math.round(n).toLocaleString('en-US');

/** "73 lb", "12 reps". */
export function valueText(value: number, mode: ChartMode): string {
  return mode === 'load' ? `${grouped(value)} lb` : count(Math.round(value), 'rep');
}

/** "+10 lb", "−1 rep", "No change", to the same whole number the value shows. */
export function changeText(change: number, mode: ChartMode): string {
  const rounded = Math.round(change);
  if (rounded === 0) return 'No change';
  return `${rounded > 0 ? '+' : '−'}${valueText(Math.abs(rounded), mode)}`;
}

function scrubX(event: PointerEvent): number | null {
  const box = (event.currentTarget instanceof Element ? event.currentTarget : null)?.getBoundingClientRect();
  return box === undefined || box.width === 0 ? null : ((event.clientX - box.left) / box.width) * W;
}

const ROW_H = 12;
/** Seven sessions a week stay at full size. A week past that shrinks every block, so the card keeps its height. */
const MAX_PLOT_H = 84;
const BLOCK_W = 20;
const GAP = 2;
const AXIS_H = 18;

/** Twelve weeks of sessions, one block each, against a dotted line at the weekly minimum. */
export function ShowUpCard({ view, today }: { readonly view: ShowUpView; readonly today: LocalDate }) {
  const { weeks, minimum, done, planned, unfinished } = view;
  const [active, setActive] = useState<number | null>(null);
  const rows = Math.max(1, minimum ?? 0, ...weeks.map((week) => week.done));
  const rowH = Math.min(ROW_H, MAX_PLOT_H / rows);
  const plotH = rows * rowH;
  const baseline = plotH + GAP;
  const slot = W / weeks.length;
  const shown = active === null ? undefined : weeks[active];
  const lastIndex = weeks.length - 1;

  const scrub = (event: PointerEvent) => {
    const at = scrubX(event);
    if (at !== null) setActive(Math.min(lastIndex, Math.max(0, Math.floor(at / slot))));
  };

  return (
    <figure class="card chart-card weight-chart show-up">
      <p class="progress-head" data-testid="show-up-count">
        <strong>{planned > 0 ? `${done} of ${planned}` : done}</strong> this week
      </p>
      <p class="progress-sub" data-testid="show-up-readout">
        {shown === undefined
          ? minimum === null
            ? `Sessions each week, last ${weeks.length} weeks`
            : 'Dotted line is your weekly minimum'
          : `${active === lastIndex ? 'This week' : `Week of ${shortDate(shown.monday, today)}`}: ${count(shown.done, 'session')}`}
      </p>
      <svg
        viewBox={`0 0 ${W} ${baseline + AXIS_H}`}
        role="img"
        aria-label={`Sessions each week for ${weeks.length} weeks, oldest first: ${weeks.map((week) => week.done).join(', ')}.${minimum === null ? '' : ` The weekly minimum is ${minimum}.`}`}
        onPointerDown={scrub}
        onPointerMove={scrub}
        onPointerLeave={() => setActive(null)}
      >
        {active !== null && <rect class="show-up-active" x={active * slot + 1} y={0} width={slot - 2} height={baseline} rx={4} />}
        {weeks.map((week, i) => {
          const open = i === lastIndex && unfinished;
          return Array.from({ length: week.done }, (_, block) => (
            <rect
              key={`${week.monday}-${block}`}
              class={open ? 'show-up-block open' : 'show-up-block'}
              x={i * slot + (slot - BLOCK_W) / 2}
              y={baseline - (block + 1) * rowH + GAP}
              width={BLOCK_W}
              height={rowH - GAP}
              rx={2.5}
            />
          ));
        })}
        {minimum !== null && <line class="chart-minimum" x1={1} x2={W - 1} y1={baseline - minimum * rowH + GAP / 2} y2={baseline - minimum * rowH + GAP / 2} />}
        <g class="chart-axis">
          <text x={0} y={baseline + AXIS_H - 4}>
            {weeks[0] === undefined ? '' : shortDate(weeks[0].monday, today)}
          </text>
          <text x={W} y={baseline + AXIS_H - 4} text-anchor="end">
            This week
          </text>
        </g>
      </svg>
    </figure>
  );
}

const SPARK_W = 72;
const SPARK_H = 30;
/** A wobble of a few percent has to stay flat, so a stuck lift reads as stuck. */
const SPARK_MIN_SHARE = 0.25;

/** A key lift's small line. Nothing with one value, because one point is not a line. */
export function BoardSpark({ values }: { readonly values: readonly number[] }) {
  if (values.length < 2) return null;
  const hi = Math.max(...values);
  const lo = Math.min(...values);
  const span = Math.max(hi - lo, hi * SPARK_MIN_SHARE);
  const mid = (hi + lo) / 2;
  const d = values
    .map((value, i) => {
      const x = 2 + (i / (values.length - 1)) * (SPARK_W - 4);
      const y = SPARK_H / 2 - ((value - mid) / span) * (SPARK_H - 4);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join('');
  return (
    <svg class="board-spark" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const H = 186;
const PLOT = { left: 8, right: W - 48, top: 26, bottom: H - 22 } as const;
/** The band under the plot that holds "swapped" labels, there only when one shows. */
const SWAP_BAND = 16;
/** Wide enough that two "swapped" labels never touch. */
const SWAP_LABEL_W = 52;
const RANGE_WORDS: Readonly<Record<LiftRange, string>> = { '3m': 'in the last 3 months', '1y': 'in the last year', all: 'so far' };

const dayNumber = (date: LocalDate) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

/** Newest first, so the label a reader looks for survives when ticks crowd. */
function labelledSwaps(xs: readonly number[]): readonly number[] {
  const kept: number[] = [];
  for (const x of xs.toSorted((a, b) => b - a)) {
    if (kept.every((other) => Math.abs(other - x) >= SWAP_LABEL_W)) kept.push(x);
  }
  return kept;
}

/** Keeps an end-anchored or start-anchored label inside the plot. */
const anchorAt = (x: number, halfWidth: number) => (x + halfWidth > PLOT.right + 8 ? 'end' : x - halfWidth < 0 ? 'start' : 'middle');

function headline(point: LiftPoint, mode: ChartMode) {
  const value = valueOf(point, mode);
  if (value === null) return <strong>No est. 1RM</strong>;
  return mode === 'load' ? (
    <>
      <strong>{valueText(value, mode)}</strong> est. 1RM
    </>
  ) : (
    <>
      <strong>{valueText(value, mode)}</strong> best set
    </>
  );
}

/**
 * The lift's headline over its chart. The headline is the scrub readout: a touch puts that session's
 * number, date, sets as typed and volume in its place, so nothing is said twice.
 */
export function LiftCard({
  series,
  range,
  latest,
  latestMode,
  today,
}: {
  readonly series: LiftSeries;
  readonly range: LiftRange;
  readonly latest: LiftPoint | null;
  readonly latestMode: ChartMode;
  readonly today: LocalDate;
}) {
  const [active, setActive] = useState<number | null>(null);
  const { points, mode, best, swaps } = series;
  const line = lineOf(series);
  const scrubbed = active === null ? undefined : points[active];
  const shown = scrubbed ?? latest;
  const shownMode = scrubbed === undefined ? latestMode : mode;

  const days = [...points, ...swaps].map((item) => dayNumber(item.date));
  const firstDay = Math.min(...days);
  const lastDay = Math.max(...days);
  const x = (date: LocalDate) => PLOT.left + (lastDay === firstDay ? 0 : ((dayNumber(date) - firstDay) / (lastDay - firstDay)) * (PLOT.right - PLOT.left));

  const values = points.flatMap((point) => (mode === 'load' ? [point.totals.e1rmLb, point.totals.topLb] : [point.bestReps])).flatMap((value) => value ?? []);
  const ticks = values.length === 0 ? [] : ticksLb(Math.min(...values), Math.max(...values), 1);
  const bottom = ticks[0] ?? 0;
  const top = ticks.at(-1) ?? 1;
  const y = (value: number) => PLOT.top + ((top - value) / (top - bottom)) * (PLOT.bottom - PLOT.top);

  const path = line.map((point, i) => `${i === 0 ? 'M' : 'L'}${x(point.date).toFixed(1)},${y(point.value).toFixed(1)}`).join('');
  const swapXs = swaps.map((swap) => x(swap.date));
  const swapLabels = labelledSwaps(swapXs);
  const axisY = PLOT.bottom + (swapLabels.length > 0 ? SWAP_BAND : 0) + 16;
  const height = axisY + 6;
  const dotR = points.length > 60 ? 2 : points.length > 24 ? 3 : 4;
  const lastDate = [...points, ...swaps].map((item) => item.date).toSorted().at(-1);

  const scrub = (event: PointerEvent) => {
    const at = scrubX(event);
    if (at === null) return;
    let nearest = 0;
    points.forEach((point, i) => {
      const from = points[nearest];
      if (from !== undefined && Math.abs(x(point.date) - at) < Math.abs(x(from.date) - at)) nearest = i;
    });
    setActive(nearest);
  };

  return (
    <div class="card chart-card lift-card">
      <figure class="weight-chart">
        <p class="progress-head" data-testid="lift-head">
          {shown === null ? <strong>No sessions yet</strong> : headline(shown, shownMode)}
        </p>
        {shown !== null && (
          <p class="progress-sub lift-readout" data-testid="chart-readout">
            {shortDate(shown.date, today)} · {setsLine(shown.sets)}
            {scrubbed !== undefined && scrubbed.totals.volumeLb !== null && ` · ${grouped(scrubbed.totals.volumeLb)} lb volume`}
          </p>
        )}
        {line.length < 2 ? (
          shown !== null && (
            <p class="empty chart-empty" data-testid="lift-chart-empty">
              {line.length === 0 ? `No sessions ${RANGE_WORDS[range]}.` : `Only one ${points.length > 1 ? 'weighted session' : 'session'} ${RANGE_WORDS[range]}, so there is no line yet.`}
            </p>
          )
        ) : (
          <>
            <svg
              viewBox={`0 0 ${W} ${height}`}
              role="img"
              data-testid="lift-chart"
              aria-label={`${mode === 'load' ? 'Est. 1RM' : 'Best reps'} from ${valueText(line[0]?.value ?? 0, mode)} to ${valueText(line.at(-1)?.value ?? 0, mode)}. Every session is in the list below.`}
              onPointerDown={scrub}
              onPointerMove={scrub}
              onPointerLeave={() => setActive(null)}
            >
              {ticks.map((tick) => (
                <g key={tick} class="chart-grid">
                  <line x1={PLOT.left} x2={PLOT.right} y1={y(tick)} y2={y(tick)} />
                  <text x={W - 2} y={y(tick)} dy="0.35em" text-anchor="end">
                    {tick.toLocaleString('en-US')}
                  </text>
                </g>
              ))}
              {swapXs.map((at, i) => (
                <line key={i} class="chart-swap" x1={at} x2={at} y1={PLOT.bottom - 5} y2={PLOT.bottom + 5} />
              ))}
              {swapLabels.map((at) => (
                <text key={at} class="chart-swap-label" x={at} y={PLOT.bottom + SWAP_BAND} text-anchor={anchorAt(at, SWAP_LABEL_W / 2)}>
                  swapped
                </text>
              ))}
              {mode === 'load' &&
                points.map((point) => (point.totals.topLb === null ? null : <circle key={point.date} class="chart-dot" cx={x(point.date)} cy={y(point.totals.topLb)} r={dotR} />))}
              <path class="chart-trend" d={path} />
              {best !== null && (
                <g class="chart-best">
                  <circle cx={x(best.date)} cy={y(best.value)} r={Math.max(6, dotR + 3)} />
                  <text x={x(best.date)} y={y(best.value) - 11} text-anchor={anchorAt(x(best.date), 26)}>
                    Best {grouped(best.value)}
                  </text>
                </g>
              )}
              {scrubbed !== undefined && <line class="chart-cursor" x1={x(scrubbed.date)} x2={x(scrubbed.date)} y1={PLOT.top} y2={PLOT.bottom} />}
              <g class="chart-axis">
                <text x={PLOT.left} y={axisY}>
                  {points[0] === undefined ? '' : shortDate(points[0].date, today)}
                </text>
                <text x={PLOT.right} y={axisY} text-anchor="end">
                  {lastDate === undefined ? '' : shortDate(lastDate, today)}
                </text>
              </g>
            </svg>
            {mode === 'load' && (
              <figcaption class="chart-legend">
                <span>
                  <i class="key-dot" /> Top weight
                </span>
                <span>
                  <i class="key-line" /> Est. 1RM
                </span>
              </figcaption>
            )}
          </>
        )}
      </figure>
    </div>
  );
}
