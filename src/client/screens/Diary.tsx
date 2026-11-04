import { useState } from 'preact/hooks';
import { MEALS, type Entry, type Meal } from '../../domain/diary.js';
import { remainingKcal } from '../../domain/goals.js';
import { addDays, type LocalDate } from '../../domain/ids.js';
import { MACROS } from '../../domain/nutrients.js';
import { dayView, useIntents, useLive, type DayView } from '../views.js';
import { DiaryMenu, type MenuTarget } from './DiaryMenu.js';
import { FastStat } from './Fasting.js';
import { FoodSheet } from './FoodSheet.js';
import { MACRO_LABEL, MEAL_LABEL, amount, dayTitle, foodRowParts, kcal } from './format.js';
import { DaySection, Icon, Row, useToast } from './ui.js';
import { Waiting } from './Waiting.js';
import { WaterStat } from './Water.js';
import { WeightStat } from './Weight.js';
import { WorkoutsSection } from './Workouts.js';

const fraction = (part: number, whole: number) => (whole <= 0 ? 0 : Math.min(1, Math.max(0, part / whole)));

function Summary({ day, onGoal }: { readonly day: DayView; readonly onGoal: () => void }) {
  const { totals } = day.summary;
  const { budget } = day;
  if (budget === null) {
    return (
      <div class="card summary">
        <p class="hero-line">
          <strong data-testid="kcal-eaten">{kcal(totals.sum.kcal)}</strong> eaten
        </p>
        <button type="button" class="text-button" onClick={onGoal}>
          Set a goal
        </button>
      </div>
    );
  }
  const left = remainingKcal(budget, totals);
  return (
    <div class="card summary">
      <div class="summary-top">
        <p class="hero-line">
          <strong data-testid="kcal-remaining">{kcal(Math.abs(left))}</strong> {left >= 0 ? 'left' : 'over'}
        </p>
        <p class="detail">
          <span data-testid="kcal-eaten">{kcal(totals.sum.kcal)}</span> of <span data-testid="kcal-target">{kcal(budget.kcal)}</span>
          <span class="sr-only"> kcal eaten</span>
        </p>
      </div>
      <div class="bar small" role="presentation">
        <span class={left >= 0 ? '' : 'over'} style={{ width: `${fraction(totals.sum.kcal, budget.kcal) * 100}%` }} />
      </div>
      <dl class="macros">
        {MACROS.map((macro) => (
          <div key={macro} class={`macro ${macro}`}>
            <dt>{MACRO_LABEL[macro]}</dt>
            <dd>
              <strong>
                {totals.incomplete.has(macro) && totals.sum[macro] > 0 ? '≥ ' : ''}
                {amount(totals.sum[macro])}
              </strong>{' '}
              / {amount(budget.macros[macro])} g
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function Diary({
  date,
  today,
  onDate,
  onAdd,
  onGoal,
}: {
  readonly date: LocalDate;
  readonly today: LocalDate;
  readonly onDate: (date: LocalDate) => void;
  readonly onAdd: (meal: Meal) => void;
  readonly onGoal: () => void;
}) {
  const day = useLive((r) => dayView(r, date), [date]);
  const intents = useIntents();
  const toast = useToast();
  const [editing, setEditing] = useState<Entry | null>(null);
  const [menu, setMenu] = useState<MenuTarget | null>(null);

  return (
    <section class="screen diary">
      <header class="day-bar">
        <button type="button" class="icon-button" aria-label="Previous day" onClick={() => onDate(addDays(date, -1))}>
          <Icon name="chevronLeft" />
        </button>
        <h1>
          <button type="button" class="day-title" onClick={() => onDate(today)} aria-label={`${dayTitle(date, today)}, go to today`}>
            {dayTitle(date, today)}
          </button>
        </h1>
        <button type="button" class="icon-button" aria-label="Next day" onClick={() => onDate(addDays(date, 1))}>
          <Icon name="chevronRight" />
        </button>
        <div class="day-bar-end">
          <Waiting />
          <button type="button" class="icon-button" aria-label="Day options" onClick={() => setMenu({ kind: 'day', date })}>
            <Icon name="more" />
          </button>
        </div>
      </header>

      {day !== undefined && (
        <>
          <Summary day={day} onGoal={onGoal} />
          <div class="stats">
            <WaterStat date={date} today={today} />
            {date === today && <FastStat today={today} />}
            <WeightStat date={date} today={today} onGoal={onGoal} />
          </div>
          {MEALS.map((meal) => {
            const { entries, totals } = day.summary.meals[meal];
            return (
              <DaySection
                key={meal}
                name={MEAL_LABEL[meal]}
                total={entries.length === 0 ? null : kcal(totals.sum.kcal)}
                addLabel={`Add to ${MEAL_LABEL[meal]}`}
                onAdd={() => onAdd(meal)}
                onOpen={() => setMenu({ kind: 'meal', date, meal })}
              >
                {entries.map((entry) => (
                  <li key={entry.id}>
                    <Row {...foodRowParts(entry.food, entry.quantity)} onClick={() => setEditing(entry)} />
                  </li>
                ))}
              </DaySection>
            );
          })}
          <WorkoutsSection date={date} workouts={day.workouts} />
        </>
      )}

      {menu !== null && day !== undefined && (
        <DiaryMenu
          target={menu}
          today={today}
          entries={menu.kind === 'meal' ? day.summary.meals[menu.meal].entries : day.summary.entries}
          onClose={() => setMenu(null)}
        />
      )}

      {editing !== null && (
        <FoodSheet
          food={editing.food}
          initial={editing.quantity}
          meal={editing.meal}
          mode={{
            kind: 'edit',
            onSave: (quantity, meal) => {
              setEditing(null);
              void intents.editEntry(editing.id, { quantity, meal }).then((undo) => toast({ text: `Updated ${editing.food.name}`, undo }));
            },
            onDelete: () => {
              setEditing(null);
              void intents.deleteEntry(editing.id).then((undo) => toast({ text: `Deleted ${editing.food.name}`, undo }));
            },
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
