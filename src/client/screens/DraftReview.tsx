import { useMemo, useState } from 'preact/hooks';
import type { Meal } from '../../domain/diary.js';
import { nutrientsFor, type Ingredient, type Quantity } from '../../domain/food.js';
import type { Library, LocalHit, RecentFood } from '../../domain/library.js';
import { choicesFor, draftItem, type Draft } from '../../domain/quicklog.js';
import { itemsNutrients } from '../../domain/reuse.js';
import { localDate, now } from '../clock.js';
import { libraryView, recentsView, useLive } from '../views.js';
import { LogAction, NutritionPreview, useQuantityPicker } from './FoodSheet.js';
import { MEAL_LABEL, count, kcal } from './format.js';
import { Icon, Sheet } from './ui.js';

interface Row {
  readonly id: number;
  readonly draft: Draft;
  readonly choices: readonly LocalHit[];
  readonly ownFoodKey: string | null;
  readonly quantity: Quantity | null;
}

const ownFood = (row: Pick<Row, 'choices' | 'ownFoodKey'>): LocalHit | null => row.choices.find((c) => c.key === row.ownFoodKey) ?? null;

function rowOn(row: Omit<Row, 'ownFoodKey' | 'quantity'>, ownFoodKey: string | null): Row {
  const choice = ownFood({ choices: row.choices, ownFoodKey });
  return { ...row, ownFoodKey: choice?.key ?? null, quantity: draftItem(row.draft, choice).quantity };
}

function itemOf(row: Row): Ingredient | null {
  if (row.quantity === null) return null;
  return { food: draftItem(row.draft, ownFood(row)).food, quantity: row.quantity };
}

const ESTIMATE = 'estimate';

function DraftRow({
  row,
  onChoose,
  onQuantity,
  onRemove,
}: {
  readonly row: Row;
  readonly onChoose: (ownFoodKey: string | null) => void;
  readonly onQuantity: (quantity: Quantity | null) => void;
  readonly onRemove: () => void;
}) {
  const { draft } = row;
  const suggested = draftItem(draft, ownFood(row));
  const { food } = suggested;
  const { picker } = useQuantityPicker(food, row.quantity ?? suggested.quantity, onQuantity);
  const energy = row.quantity === null ? null : nutrientsFor(food, row.quantity).kcal;
  const source = row.ownFoodKey === null ? (draft.confidence === 'low' ? 'AI estimate, rough' : 'AI estimate') : 'Your food';

  return (
    <li class="draft-row" aria-label={draft.name}>
      <div class="draft-head">
        <span class="food-name">{food.name}</span>
        <span class="draft-kcal" data-testid="draft-kcal">
          {energy === null ? '–' : kcal(energy)} kcal
        </span>
        <button type="button" class="draft-remove" aria-label={`Remove ${draft.name}`} onClick={onRemove}>
          <Icon name="close" />
        </button>
      </div>
      <p class="food-detail">{[source, draft.amount.described].filter((s) => s !== '').join(' · ')}</p>
      {picker}
      {row.choices.length > 0 && (
        <div class="chips draft-choices" role="radiogroup" aria-label={`Log ${draft.name} as`}>
          {[{ key: ESTIMATE, label: 'AI estimate' }, ...row.choices.map((c) => ({ key: c.key, label: c.food.name }))].map((option) => (
            <button
              type="button"
              role="radio"
              key={option.key}
              aria-checked={(row.ownFoodKey ?? ESTIMATE) === option.key}
              onClick={() => onChoose(option.key === ESTIMATE ? null : option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

function Review({
  drafts,
  yours,
  meal,
  onLog,
  onClose,
}: {
  readonly drafts: readonly Draft[];
  readonly yours: { readonly recents: readonly RecentFood[]; readonly library: Library };
  readonly meal: Meal;
  readonly onLog: (items: readonly Ingredient[], meal: Meal) => void;
  readonly onClose: () => void;
}) {
  const [rows, setRows] = useState<readonly Row[]>(() => drafts.map((draft, id) => rowOn({ id, draft, choices: choicesFor(draft, yours) }, draft.match)));
  const change = (id: number, next: (row: Row) => Row) => setRows((all) => all.map((row) => (row.id === id ? next(row) : row)));
  const items = useMemo(() => rows.map(itemOf), [rows]);
  const ready = items.flatMap((item) => (item === null ? [] : [item]));
  const complete = rows.length > 0 && ready.length === rows.length;

  return (
    <Sheet title="AI quick log" onClose={onClose}>
      <p class="source-note">Check each amount. Nothing is logged until you do.</p>
      <NutritionPreview nutrients={ready.length === 0 ? null : itemsNutrients(ready)} />
      {rows.length === 0 ? (
        <p class="empty">Nothing left to log.</p>
      ) : (
        <ul class="draft-list" aria-label="Drafts">
          {rows.map((row) => (
            <DraftRow
              key={`${row.id}:${row.ownFoodKey ?? ESTIMATE}`}
              row={row}
              onChoose={(key) => change(row.id, (r) => rowOn(r, key))}
              onQuantity={(quantity) => change(row.id, (r) => ({ ...r, quantity }))}
              onRemove={() => setRows((all) => all.filter((r) => r.id !== row.id))}
            />
          ))}
        </ul>
      )}
      <LogAction meal={meal} label={(m) => `Log ${count(rows.length, 'item')} to ${MEAL_LABEL[m]}`} disabled={!complete} onLog={(m) => onLog(ready, m)} />
    </Sheet>
  );
}

export function DraftReview(props: {
  readonly drafts: readonly Draft[];
  readonly meal: Meal;
  readonly onLog: (items: readonly Ingredient[], meal: Meal) => void;
  readonly onClose: () => void;
}) {
  const today = localDate();
  const recents = useLive((r) => recentsView(r, { today, now: now() }), [today]);
  const library = useLive(libraryView, []);
  const yours = useMemo(() => (recents === undefined || library === undefined ? null : { recents, library }), [recents, library]);
  if (yours === null) return null;
  return <Review {...props} yours={yours} />;
}
