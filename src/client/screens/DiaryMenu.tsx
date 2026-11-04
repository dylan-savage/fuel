import { useState } from 'preact/hooks';
import { itemOf, type Entry, type Meal, type MealSummary } from '../../domain/diary.js';
import { LocalDate, addDays } from '../../domain/ids.js';
import { dayView, useIntents, useLive } from '../views.js';
import { MEAL_LABEL, count, dayPhrase, dayTitle, kcal } from './format.js';
import { MealPicker } from './FoodSheet.js';
import { ItemList } from './SavedMealSheet.js';
import { Icon, Sheet, TextField, useToast } from './ui.js';

/** What a Diary ⋯ menu acts on: a whole day, or one meal of it. */
export type MenuTarget = { readonly kind: 'day'; readonly date: LocalDate } | { readonly kind: 'meal'; readonly date: LocalDate; readonly meal: Meal };

type Step = 'menu' | 'pick' | 'save';

const summaryText = (source: MealSummary | null | undefined) =>
  source === null || source === undefined || source.entries.length === 0
    ? 'Nothing logged'
    : `${count(source.entries.length, 'item')} · ${kcal(source.totals.sum.kcal)} kcal`;

/**
 * Copy food in from the day before or any other day, or save a meal for one-tap logging.
 * Copying a meal logs its items through logItems; copying a day keeps each entry's meal.
 */
export function DiaryMenu({
  target,
  today,
  entries,
  onClose,
}: {
  readonly target: MenuTarget;
  readonly today: LocalDate;
  /** What the target meal holds now, for "Save as a meal". */
  readonly entries: readonly Entry[];
  readonly onClose: () => void;
}) {
  const intents = useIntents();
  const toast = useToast();
  const dayBefore = addDays(target.date, -1);
  const [step, setStep] = useState<Step>('menu');
  const [fromText, setFromText] = useState<string>(dayBefore);
  /** The meal to copy from; null when the whole day is copied. */
  const [fromMeal, setFromMeal] = useState<Meal | null>(target.kind === 'meal' ? target.meal : null);
  const [name, setName] = useState(() => entries.map((e) => e.food.name).join(', '));

  const picked = LocalDate.safeParse(fromText);
  const from = step === 'pick' ? (picked.success ? picked.data : null) : dayBefore;
  const source = useLive(
    async (r) => {
      if (from === null) return null;
      const { summary } = await dayView(r, from);
      return fromMeal === null ? summary : summary.meals[fromMeal];
    },
    [from, fromMeal],
  );
  const into = target.kind === 'meal' ? MEAL_LABEL[target.meal] : dayTitle(target.date, today);
  /** Copying a day, or a meal, onto itself would only duplicate it. */
  const ontoItself = from === target.date && (target.kind === 'day' || fromMeal === target.meal);
  const toCopy = source === null || source === undefined || ontoItself ? [] : source.entries;

  const copy = async () => {
    if (from === null || toCopy.length === 0) return;
    const logged = target.kind === 'meal' ? await intents.logItems(toCopy.map(itemOf), target) : await intents.copyDay(from, target.date);
    toast({ text: `Copied ${count(logged.ids.length, 'item')} to ${into}`, undo: logged.undo });
    onClose();
  };

  const save = async () => {
    const meal = await intents.saveMeal({ name: name.trim(), items: entries.map(itemOf) });
    toast({ text: `Saved ${meal.name}. Log it from Add.` });
    onClose();
  };

  let body;
  switch (step) {
    case 'menu':
      body = (
        <>
          <h4 class="section-heading">Copy into {into}</h4>
          <div class="group">
            <button type="button" class="action-row" disabled={toCopy.length === 0} onClick={() => void copy()}>
              <span>
                {target.kind === 'meal' ? `Copy ${MEAL_LABEL[target.meal]} from ${dayPhrase(dayBefore, today)}` : `Copy all of ${dayPhrase(dayBefore, today)}`}
              </span>
              <span class="choice-detail">{summaryText(source)}</span>
            </button>
            <button type="button" class="row-button disclosure" onClick={() => setStep('pick')}>
              Copy from another day
              <Icon name="chevronRight" />
            </button>
          </div>
          {target.kind === 'meal' && (
            <div class="group spaced">
              <button type="button" class="action-row" disabled={entries.length === 0} onClick={() => setStep('save')}>
                <span>Save as a meal</span>
                <span class="choice-detail">{entries.length === 0 ? 'Nothing logged yet' : 'Log these items again in one tap'}</span>
              </button>
            </div>
          )}
        </>
      );
      break;
    case 'pick':
      body = (
        <>
          <div class="group">
            <label class="field">
              <span class="field-label">Day</span>
              <input type="date" value={fromText} onInput={(event) => setFromText(event.currentTarget.value)} />
            </label>
          </div>
          {fromMeal !== null && <MealPicker value={fromMeal} onChange={setFromMeal} />}
          <h4 class="section-heading">{ontoItself ? `Pick another ${target.kind === 'day' ? 'day' : 'day or meal'}` : summaryText(source)}</h4>
          {toCopy.length > 0 && <ItemList items={toCopy.map(itemOf)} label="To copy" />}
          <div class="sheet-actions">
            <button type="button" class="primary" disabled={toCopy.length === 0} onClick={() => void copy()}>
              Copy {count(toCopy.length, 'item')} to {into}
            </button>
          </div>
        </>
      );
      break;
    case 'save':
      body = (
        <>
          <div class="group">
            <TextField label="Name" value={name} onInput={setName} placeholder="Usual breakfast" />
          </div>
          <h4 class="section-heading">{count(entries.length, 'item')}</h4>
          <ItemList items={entries.map(itemOf)} label="In this meal" />
          <div class="sheet-actions">
            <button type="button" class="primary" disabled={name.trim() === '' || entries.length === 0} onClick={() => void save()}>
              Save meal
            </button>
          </div>
        </>
      );
      break;
  }

  const title: Readonly<Record<Step, string>> = { menu: into, pick: 'Copy from another day', save: 'Save as a meal' };
  return (
    <Sheet title={title[step]} onClose={onClose}>
      {body}
    </Sheet>
  );
}
