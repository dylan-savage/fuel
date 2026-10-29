import { useState } from 'preact/hooks';
import { MEALS, entryNutrients, type Entry, type Meal } from '../../domain/diary.js';
import { remainingKcal } from '../../domain/goals.js';
import { addDays, type LocalDate } from '../../domain/ids.js';
import { MACROS, type Macro } from '../../domain/nutrients.js';
import { dayView, useIntents, useLive, type DayView } from '../views.js';
import { FoodSheet } from './FoodSheet.js';
import { MEAL_LABEL, amount, dayTitle, kcal, quantityLabel } from './format.js';
import { Icon, useToast } from './ui.js';
import { Waiting } from './Waiting.js';

const MACRO_LABEL: Readonly<Record<Macro, string>> = { protein: 'Protein', carbs: 'Carbs', fat: 'Fat' };

const fraction = (part: number, whole: number) => (whole <= 0 ? 0 : Math.min(1, Math.max(0, part / whole)));

function Summary({ day, onGoal }: { readonly day: DayView; readonly onGoal: () => void }) {
  const { totals } = day.summary;
  const { budget } = day;
  if (budget === null) {
    return (
      <div class="card summary">
        <p class="summary-main">
          <strong data-testid="kcal-eaten">{kcal(totals.sum.kcal)}</strong> kcal eaten
        </p>
        <button type="button" class="row-button" onClick={onGoal}>
          Set a goal to see what is left
        </button>
      </div>
    );
  }
  const left = remainingKcal(budget, totals);
  return (
    <div class="card summary">
      <div class="summary-top">
        <div>
          <p class="summary-label">{left >= 0 ? 'Remaining' : 'Over'}</p>
          <p class={left >= 0 ? 'summary-big' : 'summary-big over'}>
            <strong data-testid="kcal-remaining">{kcal(Math.abs(left))}</strong> kcal
          </p>
        </div>
        <p class="summary-equation">
          <span data-testid="kcal-target">{kcal(budget.kcal)}</span> goal
          <br />− <span data-testid="kcal-eaten">{kcal(totals.sum.kcal)}</span> food
        </p>
      </div>
      <div class="bar" role="presentation">
        <span class={left >= 0 ? '' : 'over'} style={{ width: `${fraction(totals.sum.kcal, budget.kcal) * 100}%` }} />
      </div>
      <dl class="macros">
        {MACROS.map((macro) => (
          <div key={macro} class={`macro ${macro}`}>
            <dt>{MACRO_LABEL[macro]}</dt>
            <dd>
              {totals.incomplete.has(macro) && totals.sum[macro] > 0 ? '≥ ' : ''}
              {amount(totals.sum[macro])} / {amount(budget.macros[macro])} g
            </dd>
            <div class="bar small" role="presentation">
              <span style={{ width: `${fraction(totals.sum[macro], budget.macros[macro]) * 100}%` }} />
            </div>
          </div>
        ))}
      </dl>
    </div>
  );
}

function EntryRow({ entry, onOpen }: { readonly entry: Entry; readonly onOpen: () => void }) {
  return (
    <li>
      <button type="button" class="entry-row" onClick={onOpen}>
        <span class="food-name">{entry.food.name}</span>
        <span class="food-detail">{[entry.food.brand, quantityLabel(entry.food, entry.quantity)].filter(Boolean).join(' · ')}</span>
        <span class="entry-kcal">{kcal(entryNutrients(entry).kcal)}</span>
      </button>
    </li>
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
        </div>
      </header>

      {day !== undefined && (
        <>
          <Summary day={day} onGoal={onGoal} />
          {MEALS.map((meal) => {
            const { entries, totals } = day.summary.meals[meal];
            return (
              <section class="meal" key={meal} aria-label={MEAL_LABEL[meal]}>
                <header class="meal-header">
                  <h2>{MEAL_LABEL[meal]}</h2>
                  {entries.length > 0 && <span class="meal-kcal">{kcal(totals.sum.kcal)} kcal</span>}
                </header>
                <ul class="list">
                  {entries.map((entry) => (
                    <EntryRow key={entry.id} entry={entry} onOpen={() => setEditing(entry)} />
                  ))}
                  <li>
                    <button type="button" class="row-button" onClick={() => onAdd(meal)}>
                      <Icon name="plus" /> Add to {MEAL_LABEL[meal]}
                    </button>
                  </li>
                </ul>
              </section>
            );
          })}
        </>
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
