import { useState } from 'preact/hooks';
import { BodyKg, type Projection, type WeeklyRate } from '../../domain/body.js';
import { KG_PER_LB } from '../../domain/goals.js';
import { LocalDate } from '../../domain/ids.js';
import { bodyView, useIntents, useLive, weighInsView, type BodyView } from '../views.js';
import { dayPhrase, dayTitle, lb, lbField, lbPerWeek, parseNumber, shortDate } from './format.js';
import { ExpandRow, NumberField, Row, Segmented, Sheet, Stat, useKeyboardAvoidance, useToast } from './ui.js';
import { RANGES, WeightChart, type RangeDays } from './WeightChart.js';

/** Up to this many weigh-ins listed under the chart. */
const HISTORY_ROWS = 60;

function rateText(rate: WeeklyRate): string {
  return rate.kind === 'rate' ? lbPerWeek(rate.kgPerWeek) : 'No rate yet';
}

function projectionText(projection: Exclude<Projection, { kind: 'no-goal' }>, today: LocalDate): { readonly value: string; readonly detail: string } {
  switch (projection.kind) {
    case 'not-enough-data':
      return { value: 'Not enough data', detail: 'Needs two weeks of trend and 7 weigh-ins in the last 14 days.' };
    case 'reached':
      return { value: 'Reached', detail: 'Your trend is at your goal weight.' };
    case 'steady':
      return { value: 'Holding steady', detail: 'Your trend is barely moving.' };
    case 'away':
      return { value: 'Moving away', detail: 'Your trend is heading away from your goal.' };
    case 'on-course':
      return { value: shortDate(projection.date, today), detail: 'When your trend reaches your goal at this rate.' };
  }
}

/**
 * The weigh-in entry: a date and one number on the decimal keypad. A day has one weigh-in,
 * so saving on a day that has one replaces it. The field shows the picked day's reading
 * until Dylan types, so a prefilled number never follows him to another day.
 */
export function WeighInSheet({ date, today, onClose }: { readonly date: LocalDate; readonly today: LocalDate; readonly onClose: () => void }) {
  useKeyboardAvoidance();
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
  const hint = day === null ? 'Pick a day up to today.' : existing === undefined ? null : `Replaces ${dayPhrase(day, today)}'s ${lb(existing.kg)} lb.`;

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
      {hint !== null && <p class={day === null ? 'hint warn' : 'hint'}>{hint}</p>}
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

/** The goal weight and when the trend reaches it. With no goal weight, the way to set one. */
function GoalRows({ view, today, onGoal }: { readonly view: BodyView; readonly today: LocalDate; readonly onGoal: () => void }) {
  const { goalKg, projection } = view;
  if (goalKg === undefined || projection.kind === 'no-goal') {
    return (
      <ul class="list" aria-label="Goal">
        <li>
          <Row name="Set a goal weight" chevron onClick={onGoal} />
        </li>
      </ul>
    );
  }
  const projected = projectionText(projection, today);
  return (
    <ul class="list" aria-label="Goal">
      <li>
        <Row name="Goal weight" end={`${lb(goalKg)} lb`} />
      </li>
      <li>
        <ExpandRow name="Projected" end={<span data-testid="projection">{projected.value}</span>}>
          <p>{projected.detail}</p>
        </ExpandRow>
      </li>
    </ul>
  );
}

/** The weight screen: trend, rate, the chart, goal projection and every weigh-in. A new weigh-in starts on `date`, or today from a day still to come. */
export function WeightSheet({ date, today, onClose, onGoal }: { readonly date: LocalDate; readonly today: LocalDate; readonly onClose: () => void; readonly onGoal: () => void }) {
  const view = useLive((r) => bodyView(r, today), [today]);
  const [days, setDays] = useState<RangeDays>(30);
  const [entry, setEntry] = useState<LocalDate | null>(null);

  return (
    <Sheet title="Weight" onClose={onClose} closeLabel="Done">
      {view !== undefined && (
        <>
          <div class="card">
            <WeightChart series={view.series} goalKg={view.goalKg} days={days} today={today} trendKg={view.trendKg} rate={view.trendKg === undefined ? 'No weigh-ins yet' : rateText(view.rate)} />
            {view.weighIns.length > 0 && (
              <Segmented
                quiet
                label="Chart range"
                options={RANGES.map((r) => ({ value: String(r.days), label: r.label }))}
                value={String(days)}
                onChange={(value) => setDays(RANGES.find((r) => String(r.days) === value)?.days ?? 30)}
              />
            )}
          </div>
          <div class="sheet-actions">
            <button type="button" class="primary" onClick={() => setEntry(date <= today ? date : today)}>
              Weigh in
            </button>
          </div>
          <GoalRows view={view} today={today} onGoal={onGoal} />
          {view.weighIns.length > 0 && (
            <>
              <h4 class="section-heading">Weigh-ins</h4>
              <ul class="list" aria-label="Weigh-ins">
                {view.weighIns.slice(0, HISTORY_ROWS).map((w) => (
                  <li key={w.id}>
                    <Row name={dayTitle(w.date, today)} end={`${lb(w.kg)} lb`} onClick={() => setEntry(w.date)} />
                  </li>
                ))}
              </ul>
            </>
          )}
          {entry !== null && <WeighInSheet date={entry} today={today} onClose={() => setEntry(null)} />}
        </>
      )}
    </Sheet>
  );
}

/** The day's trend weight as one number, opening the sheet that holds the weigh-in. */
export function WeightStat({ date, today, onGoal }: { readonly date: LocalDate; readonly today: LocalDate; readonly onGoal: () => void }) {
  const view = useLive((r) => bodyView(r, date), [date]);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Stat
        label="Weight"
        value={
          view?.trendKg === undefined ? (
            '–'
          ) : (
            <>
              <span data-testid="day-trend">{lb(view.trendKg)}</span> lb
            </>
          )
        }
        onClick={() => setOpen(true)}
      />
      {open && (
        <WeightSheet
          date={date}
          today={today}
          onClose={() => setOpen(false)}
          onGoal={() => {
            setOpen(false);
            onGoal();
          }}
        />
      )}
    </>
  );
}
