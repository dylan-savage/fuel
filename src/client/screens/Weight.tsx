import { useState } from 'preact/hooks';
import { BodyKg, type Projection, type WeeklyRate } from '../../domain/body.js';
import { KG_PER_LB } from '../../domain/goals.js';
import { LocalDate } from '../../domain/ids.js';
import { bodyView, useIntents, useLive, weighInsView, type BodyView } from '../views.js';
import { dayPhrase, dayTitle, lb, lbField, lbPerWeek, parseNumber, shortDate } from './format.js';
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
 * so saving on a day that has one replaces it. The field shows the picked day's reading
 * until Dylan types, so a prefilled number never follows him to another day.
 */
export function WeighInSheet({ date, today, onClose }: { readonly date: LocalDate; readonly today: LocalDate; readonly onClose: () => void }) {
  const intents = useIntents();
  const toast = useToast();
  const weighIns = useLive((r) => weighInsView(r), []);
  const [dayText, setDayText] = useState<string>(date);
  const [typed, setTyped] = useState<string | null>(null);
  if (weighIns === undefined) return null;

  const picked = LocalDate.safeParse(dayText);
  const day = picked.success && picked.data <= today ? picked.data : null;
  const existing = day === null ? undefined : weighIns.find((w) => w.date === day);
  const text = typed ?? (existing === undefined ? '' : lbField(existing.kg));
  const [latest] = weighIns;
  const pounds = parseNumber(text);
  const kg = pounds === null ? null : pounds * KG_PER_LB;
  const valid = day !== null && kg !== null && BodyKg.safeParse(kg).success;
  const hint =
    day === null
      ? 'Pick a day up to today.'
      : existing === undefined
        ? 'One weigh-in a day. Your trend smooths out the daily swings.'
        : `This replaces ${dayPhrase(day, today)}'s ${lb(existing.kg)} lb.`;

  return (
    <Sheet title="Weigh-in" onClose={onClose}>
      <div class="group">
        <label class={day === null ? 'field invalid' : 'field'}>
          <span class="field-label">Date</span>
          <input type="date" value={dayText} max={today} onInput={(event) => setDayText(event.currentTarget.value)} />
        </label>
        <NumberField
          label="Weight"
          unit="lb"
          value={text}
          onInput={setTyped}
          placeholder={latest === undefined ? '180.0' : lbField(latest.kg)}
          invalid={text.trim() !== '' && (kg === null || !BodyKg.safeParse(kg).success)}
          autoFocus
        />
      </div>
      <p class={day === null ? 'hint warn' : 'hint'}>{hint}</p>
      <div class="sheet-actions">
        <button
          type="button"
          class="primary"
          disabled={!valid}
          onClick={() => {
            if (!valid) return;
            onClose();
            const when = day === today ? '' : ` for ${dayPhrase(day, today)}`;
            void intents.logWeight(kg, day).then((undo) => toast({ text: `Weighed in at ${lb(kg)} lb${when}`, undo }));
          }}
        >
          Save weigh-in
        </button>
        {day !== null && existing !== undefined && (
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
          <h4 class="section-heading">Weigh-ins</h4>
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
          {entry !== null && <WeighInSheet date={entry} today={today} onClose={() => setEntry(null)} />}
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
      {weighing && <WeighInSheet date={date} today={today} onClose={() => setWeighing(false)} />}
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
