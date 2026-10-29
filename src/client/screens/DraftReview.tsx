/**
 * What AI found, as rows Dylan can change before anything is logged: the amount, which food
 * each row logs as (the AI's estimate or one of his own), and whether it stays at all.
 * Confirming logs every row in one commit.
 */
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
  /** What he can log it as besides the estimate, the model's match first. */
  readonly choices: readonly LocalHit[];
  /** The key of his food it logs as, or null for the AI's estimate. */
  readonly pick: string | null;
  /** In the picked food's unit. Null while the amount field is not a number. */
  readonly quantity: Quantity | null;
}

const picked = (row: Pick<Row, 'choices' | 'pick'>): LocalHit | null => row.choices.find((c) => c.key === row.pick) ?? null;

/** A row on `pick`, at the amount the draft describes in that food's terms. */
function rowOn(row: Omit<Row, 'pick' | 'quantity'>, pick: string | null): Row {
  const choice = picked({ choices: row.choices, pick });
  return { ...row, pick: choice?.key ?? null, quantity: draftItem(row.draft, choice).quantity };
}

function itemOf(row: Row): Ingredient | null {
  if (row.quantity === null) return null;
  return { food: draftItem(row.draft, picked(row)).food, quantity: row.quantity };
}

const ESTIMATE = 'estimate';

function DraftRow({
  row,
  onPick,
  onQuantity,
  onRemove,
}: {
  readonly row: Row;
  readonly onPick: (pick: string | null) => void;
  readonly onQuantity: (quantity: Quantity | null) => void;
  readonly onRemove: () => void;
}) {
  const { draft } = row;
  const suggested = draftItem(draft, picked(row));
  const { food } = suggested;
  const { picker } = useQuantityPicker(food, row.quantity ?? suggested.quantity, onQuantity);
  const energy = row.quantity === null ? null : nutrientsFor(food, row.quantity).kcal;
  const source = row.pick === null ? (draft.confidence === 'low' ? 'AI estimate, rough' : 'AI estimate') : 'Your food';

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
              aria-checked={(row.pick ?? ESTIMATE) === option.key}
              onClick={() => onPick(option.key === ESTIMATE ? null : option.key)}
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
  // Each row starts on the food the model matched, when he still has it.
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
              key={`${row.id}:${row.pick ?? ESTIMATE}`}
              row={row}
              onPick={(pick) => change(row.id, (r) => rowOn(r, pick))}
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

/** Opens once his foods are read, so each row can start on the food the model matched. */
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
