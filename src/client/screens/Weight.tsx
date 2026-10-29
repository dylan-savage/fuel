import { useState } from 'preact/hooks';
import { BodyKg, type Projection, type WeeklyRate, type WeighIn } from '../../domain/body.js';
import { KG_PER_LB } from '../../domain/goals.js';
import { LocalDate } from '../../domain/ids.js';
import { bodyView, useIntents, useLive, type BodyView } from '../views.js';
import { dayPhrase, dayTitle, lb, lbPerWeek, parseNumber, shortDate } from './format.js';
import { Icon, NumberField, Segmented, Sheet, useToast } from './ui.js';
import { RANGES, TrendSpark, WeightChart, type RangeDays } from './WeightChart.js';

/** Up to this many weigh-ins listed under the chart. */
const HISTORY_ROWS = 60;

function rateText(rate: WeeklyRate): string {
  return rate.kind === 'rate' ? lbPerWeek(rate.kgPerWeek) : 'Not enough data for a rate yet';
}

function projectionText(projection: Projection, today: LocalDate): { readonly value: string; readonly detail: string } {
  switch (projection.kind) {
    case 'no-goal':
      return { value: '–', detail: 'Set a goal weight to see when you will reach it.' };
    case 'not-enough-data':
      return { value: 'Not enough data', detail: 'The rate needs two weeks of trend and 7 weigh-ins in the last 14 days.' };
    case 'reached':
      return { value: 'Reached', detail: 'Your trend is at your goal weight.' };
    case 'steady':
      return { value: 'Holding steady', detail: 'Your trend is barely moving, so there is no date to project.' };
    case 'away':
      return { value: 'Moving away', detail: 'At this rate your trend is heading away from your goal.' };
    case 'on-course':
      return { value: shortDate(projection.date, today), detail: 'When your trend reaches your goal at its current rate.' };
  }
}

/**
 * The weigh-in entry: a date and one number on the decimal keypad. A day has one weigh-in,
 * so saving on a day that has one replaces it.
 */
export function WeighInSheet({
  date,
  today,
  weighIns,
  onClose,
}: {
  readonly date: LocalDate;
  readonly today: LocalDate;
  readonly weighIns: readonly WeighIn[];
  readonly onClose: () => void;
}) {
  const intents = useIntents();
  const toast = useToast();
  const [day, setDay] = useState<LocalDate>(date);
  const existing = weighIns.find((w) => w.date === day);
  const [text, setText] = useState(existing === undefined ? '' : lb(existing.kg));
  const latest = weighIns[0];
  const pounds = parseNumber(text);
  const kg = pounds === null ? null : pounds * KG_PER_LB;
  const valid = kg !== null && BodyKg.safeParse(kg).success;

  const pickDay = (value: string) => {
    const parsed = LocalDate.safeParse(value);
    if (!parsed.success || parsed.data > today) return;
    setDay(parsed.data);
    const other = weighIns.find((w) => w.date === parsed.data);
    if (other !== undefined) setText(lb(other.kg));
  };

  return (
    <Sheet title="Weigh-in" onClose={onClose}>
      <div class="group">
        <label class="field">
          <span class="field-label">Date</span>
          <input type="date" value={day} max={today} onInput={(event) => pickDay(event.currentTarget.value)} />
        </label>
        <NumberField
          label="Weight"
          unit="lb"
          value={text}
          onInput={setText}
          placeholder={latest === undefined ? '180.0' : lb(latest.kg)}
          invalid={text.trim() !== '' && !valid}
          autoFocus
        />
      </div>
      <p class="hint">{existing === undefined ? 'One weigh-in a day. Your trend smooths out the daily swings.' : `This replaces ${dayPhrase(day, today)}'s ${lb(existing.kg)} lb.`}</p>
      <div class="sheet-actions">
        <button
          type="button"
          class="primary"
          disabled={!valid}
          onClick={() => {
            if (kg === null || !valid) return;
            onClose();
            void intents.logWeight(kg, day).then((undo) => toast({ text: `Weighed in at ${lb(kg)} lb`, undo }));
          }}
        >
          Save weigh-in
        </button>
        {existing !== undefined && (
          <button
            type="button"
            class="destructive"
            onClick={() => {
              onClose();
              void intents.deleteWeighIn(day).then((undo) => toast({ text: `Deleted ${dayPhrase(day, today)}'s weigh-in`, undo }));
            }}
          >
            Delete weigh-in
          </button>
        )}
      </div>
    </Sheet>
  );
}

/** The weight screen: trend, rate, goal projection, the chart and every weigh-in. */
export function WeightSheet({ today, onClose, onGoal }: { readonly today: LocalDate; readonly onClose: () => void; readonly onGoal: () => void }) {
  const view = useLive((r) => bodyView(r, today), [today]);
  const [days, setDays] = useState<RangeDays>(30);
  const [entry, setEntry] = useState<LocalDate | null>(null);

  return (
    <Sheet title="Weight" onClose={onClose}>
      {view !== undefined && (
        <>
          <div class="weight-hero">
            <span class="hero-label">Trend weight</span>
            <strong class="hero-value" data-testid="trend-weight">
              {view.trendKg === undefined ? '–' : `${lb(view.trendKg)} lb`}
            </strong>
            <span class="hero-sub" data-testid="weekly-rate">
              {view.trendKg === undefined ? 'Weigh in to start your trend' : rateText(view.rate)}
            </span>
          </div>
          <Segmented
            label="Chart range"
            options={RANGES.map((r) => ({ value: String(r.days), label: r.label }))}
            value={String(days)}
            onChange={(value) => setDays(RANGES.find((r) => String(r.days) === value)?.days ?? 30)}
          />
          <div class="card chart-card">
            <WeightChart series={view.series} goalKg={view.goalKg} days={days} today={today} />
          </div>
          <Projected view={view} today={today} onGoal={onGoal} />
          <div class="sheet-actions">
            <button type="button" class="primary" onClick={() => setEntry(today)}>
              Weigh in
            </button>
          </div>
          <h4 class="group-title">Weigh-ins</h4>
          {view.weighIns.length === 0 ? (
            <p class="empty">No weigh-ins yet.</p>
          ) : (
            <ul class="list" aria-label="Weigh-ins">
              {view.weighIns.slice(0, HISTORY_ROWS).map((w) => (
                <li key={w.id}>
                  <button type="button" class="entry-row" onClick={() => setEntry(w.date)}>
                    <span class="food-name">{dayTitle(w.date, today)}</span>
                    <span class="entry-kcal">{lb(w.kg)} lb</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {entry !== null && <WeighInSheet date={entry} today={today} weighIns={view.weighIns} onClose={() => setEntry(null)} />}
        </>
      )}
    </Sheet>
  );
}

function Projected({ view, today, onGoal }: { readonly view: BodyView; readonly today: LocalDate; readonly onGoal: () => void }) {
  const projection = projectionText(view.projection, today);
  return (
    <>
      <dl class="body-stats card">
        <div>
          <dt>Goal weight</dt>
          <dd>{view.goalKg === undefined ? '–' : `${lb(view.goalKg)} lb`}</dd>
        </div>
        <div>
          <dt>Projected</dt>
          <dd data-testid="projection">{projection.value}</dd>
        </div>
      </dl>
      <p class="hint">{projection.detail}</p>
      {view.goalKg === undefined && (
        <button type="button" class="text-button inline" onClick={onGoal}>
          Set a goal weight
        </button>
      )}
    </>
  );
}

/** The weight at a glance on the diary: the trend that day, its rate, and a one-tap weigh-in. */
export function WeightTile({ date, today, onGoal }: { readonly date: LocalDate; readonly today: LocalDate; readonly onGoal: () => void }) {
  const view = useLive((r) => bodyView(r, date), [date]);
  const [open, setOpen] = useState(false);
  const [weighing, setWeighing] = useState(false);
  if (view === undefined) return <section class="card tile" aria-label="Weight" />;
  const weighedIn = view.weighIns[0]?.date === date ? view.weighIns[0] : undefined;

  return (
    <section class="card tile weight" aria-label="Weight">
      <button type="button" class="tile-main" onClick={() => setOpen(true)}>
        <span class="tile-icon">
          <Icon name="scale" />
        </span>
        <span class="tile-text">
          <span class="tile-title">Weight</span>
          <span class="tile-value">
            {view.trendKg === undefined ? (
              <small>No weigh-ins</small>
            ) : (
              <>
                <strong data-testid="tile-trend">{lb(view.trendKg)}</strong>
                <small> lb</small>
              </>
            )}
          </span>
          <span class="tile-detail">{view.trendKg === undefined ? 'Start your trend' : weighedIn === undefined ? rateText(view.rate) : `Scale ${lb(weighedIn.kg)} lb`}</span>
        </span>
        <TrendSpark series={view.series} />
      </button>
      {date <= today && (
        <div class="pills">
          <button type="button" class="pill" onClick={() => setWeighing(true)}>
            Weigh in
          </button>
        </div>
      )}
      {weighing && <WeighInSheet date={date} today={today} weighIns={view.weighIns} onClose={() => setWeighing(false)} />}
      {open && (
        <WeightSheet
          today={today}
          onClose={() => setOpen(false)}
          onGoal={() => {
            setOpen(false);
            onGoal();
          }}
        />
      )}
    </section>
  );
}
