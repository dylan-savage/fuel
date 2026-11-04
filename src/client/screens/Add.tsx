import { useMemo, useState } from 'preact/hooks';
import type { Meal, Slot } from '../../domain/diary.js';
import { defaultQuantity, snapshotOf, type FoodSnapshot, type Ingredient, type Quantity } from '../../domain/food.js';
import type { LocalDate } from '../../domain/ids.js';
import { foodKey, libraryRefs, matches, searchLocal, type LocalHit } from '../../domain/library.js';
import { itemsNutrients, recipeSnapshot, type SavedMeal } from '../../domain/reuse.js';
import { now } from '../clock.js';
import { libraryView, recentsView, savedMealsView, useIntents, useLive } from '../views.js';
import { useLogFlow, type OnLogged } from './flow.js';
import { MEAL_LABEL, count, dayTitle, kcal } from './format.js';
import { MealPicker } from './FoodSheet.js';
import { FoodRow, OnlineSection } from './search.js';
import { Icon, Segmented, TitleBar, useToast } from './ui.js';

/** The scanner pulls in the zxing glue, so it loads on the first tap, never at startup. */
const loadScan = () => import('./Scan.js');
type ScanModule = Awaited<ReturnType<typeof loadScan>>;

/** What the Add screen lists before anything is typed. */
type Shelf = 'recent' | 'recipes' | 'meals';

const SHELVES: readonly { readonly value: Shelf; readonly label: string }[] = [
  { value: 'recent', label: 'Recent' },
  { value: 'recipes', label: 'Recipes' },
  { value: 'meals', label: 'Saved meals' },
];

function SavedMealRow({ meal, onOpen, onLog }: { readonly meal: SavedMeal; readonly onOpen: () => void; readonly onLog: () => void }) {
  return (
    <li class="food-row">
      <button type="button" class="food-row-main" onClick={onOpen}>
        <span class="food-name">{meal.name}</span>
        <span class="food-detail">
          {count(meal.items.length, 'item')} · {kcal(itemsNutrients(meal.items).kcal)} kcal
        </span>
      </button>
      <button type="button" class="add-button" aria-label={`Log ${meal.name}`} onClick={onLog}>
        <Icon name="plus" />
      </button>
    </li>
  );
}

export function Add({
  slot,
  today,
  onMeal,
  onLogged,
}: {
  readonly slot: Slot;
  readonly today: LocalDate;
  readonly onMeal: (meal: Meal) => void;
  readonly onLogged: OnLogged;
}) {
  const recentList = useLive((r) => recentsView(r, { today, now: now() }), [today]);
  const library = useLive(libraryView, []);
  const meals = useLive(savedMealsView, []);
  const [query, setQuery] = useState('');
  const [shelf, setShelf] = useState<Shelf>('recent');
  const [scanner, setScanner] = useState<ScanModule | null>(null);
  const flow = useLogFlow(slot, onLogged);
  const intents = useIntents();
  const toast = useToast();
  const trimmed = query.trim();

  const local = useMemo(
    () => (trimmed === '' ? [] : searchLocal({ query: trimmed, library: library ?? { foods: [], recipes: [] }, recents: recentList ?? [], limit: 25 })),
    [trimmed, library, recentList],
  );
  const mealHits = useMemo(() => (trimmed === '' ? [] : (meals ?? []).filter((meal) => matches(meal, trimmed))), [trimmed, meals]);
  const recipes = useMemo(
    () =>
      (library?.recipes ?? [])
        .filter((recipe) => !recipe.archived)
        .map(recipeSnapshot)
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    [library],
  );
  const known = useMemo(() => libraryRefs(library?.foods ?? []), [library]);

  const logNow = (name: string, items: readonly Ingredient[]) =>
    void intents.logItems(items, slot).then(({ undo }) => toast({ text: `Logged ${name} to ${MEAL_LABEL[slot.meal]}`, undo }));

  const foodRow = (key: string, food: FoodSnapshot, quantity: Quantity) => (
    <FoodRow key={key} food={food} quantity={quantity} onOpen={() => flow.open({ kind: 'food', food, quantity })} onQuickLog={() => logNow(food.name, [{ food, quantity }])} />
  );
  const localRow = (hit: LocalHit) => foodRow(hit.key, hit.food, hit.lastQuantity ?? defaultQuantity(hit.food));
  const mealRow = (meal: SavedMeal) => (
    <SavedMealRow key={meal.id} meal={meal} onOpen={() => flow.open({ kind: 'meal', meal })} onLog={() => logNow(meal.name, meal.items)} />
  );

  return (
    <section class="screen add">
      <TitleBar title="Add food" />
      <p class="subtitle">
        {dayTitle(slot.date, today)}, {MEAL_LABEL[slot.meal]}
      </p>
      <MealPicker value={slot.meal} onChange={onMeal} />
      <div class="search">
        <input
          type="search"
          aria-label="Search foods"
          placeholder="Search foods, recipes and meals"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <button type="button" class="icon-button search-scan" aria-label="Scan" onClick={() => void loadScan().then(setScanner)}>
          <Icon name="scan" />
        </button>
      </div>

      {trimmed === '' ? (
        <>
          <div class="actions-row">
            <button type="button" onClick={() => flow.open({ kind: 'quick-add' })}>
              Quick add
            </button>
            <button type="button" onClick={() => flow.open({ kind: 'editor', seed: { kind: 'new', barcodes: [] } })}>
              New food
            </button>
          </div>
          <Segmented label="Show" options={SHELVES} value={shelf} onChange={setShelf} />
          {shelf === 'recent' &&
            (recentList !== undefined && recentList.length === 0 ? (
              <p class="empty">Foods you log show up here for one-tap logging.</p>
            ) : (
              <ul class="list" aria-label="Recent foods">
                {(recentList ?? []).slice(0, 25).map((recent) => foodRow(recent.key, recent.food, recent.lastQuantity))}
              </ul>
            ))}
          {shelf === 'recipes' && (
            <ul class="list" aria-label="Recipes">
              {recipes.map((food) => foodRow(foodKey(food), food, defaultQuantity(food)))}
              <li>
                <button type="button" class="row-button" onClick={() => flow.open({ kind: 'recipe', seed: { kind: 'new' } })}>
                  <Icon name="plus" /> New recipe
                </button>
              </li>
            </ul>
          )}
          {shelf === 'meals' &&
            (meals !== undefined && meals.length === 0 ? (
              <p class="empty">Save any meal on the Diary from its ⋯ menu, then log it here in one tap.</p>
            ) : (
              <ul class="list" aria-label="Saved meals">
                {(meals ?? []).map(mealRow)}
              </ul>
            ))}
        </>
      ) : (
        <>
          <h2 class="section-heading">Your foods</h2>
          {local.length === 0 ? <p class="empty">No match in your foods.</p> : <ul class="list" aria-label="Your foods">{local.map(localRow)}</ul>}
          {mealHits.length > 0 && (
            <>
              <h2 class="section-heading">Saved meals</h2>
              <ul class="list" aria-label="Saved meals">
                {mealHits.map(mealRow)}
              </ul>
            </>
          )}
          <OnlineSection
            query={trimmed}
            known={known}
            onOpen={(opened) =>
              opened.kind === 'food'
                ? flow.open({ kind: 'food', food: snapshotOf(opened.food), quantity: defaultQuantity(opened.food) })
                : flow.open({ kind: 'confirm', candidate: opened.candidate })
            }
          />
        </>
      )}
      {flow.sheet}
      {scanner !== null && <scanner.Scan slot={slot} onLogged={onLogged} onClose={() => setScanner(null)} />}
    </section>
  );
}
