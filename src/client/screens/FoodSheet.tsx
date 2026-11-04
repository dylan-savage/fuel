import { useMemo, useState } from 'preact/hooks';
import { MEALS, type Meal } from '../../domain/diary.js';
import { nutrientsFor, type FoodSnapshot, type Quantity, type Serving } from '../../domain/food.js';
import { NUTRIENTS, type Nutrients } from '../../domain/nutrients.js';
import { MEAL_LABEL, UNIT_LABEL, amount, brandOf, editable, kcal, macrosLine, parseNumber, servingLabel } from './format.js';
import { Icon, Segmented, Sheet } from './ui.js';

const sameServing = (a: Serving, b: Serving) => a.label === b.label && a.amount === b.amount;

interface UnitChoice {
  readonly label: string;
  readonly quantity: (n: number) => Quantity;
}

/**
 * The amount picker: a number and a unit, where the units are the food's named servings plus
 * its base unit. A serving the food no longer lists still shows when the quantity carries it.
 */
export function useQuantityPicker(food: Pick<FoodSnapshot, 'unit' | 'servings'>, initial: Quantity) {
  const units = useMemo((): UnitChoice[] => {
    const servings = [...food.servings];
    if (initial.kind === 'serving' && !servings.some((s) => sameServing(s, initial.serving))) servings.unshift(initial.serving);
    return [
      ...servings.map((serving) => ({ label: servingLabel(food.unit, serving), quantity: (count: number): Quantity => ({ kind: 'serving', serving, count }) })),
      { label: UNIT_LABEL[food.unit], quantity: (n: number): Quantity => ({ kind: 'amount', amount: n }) },
    ];
  }, [food, initial]);

  const initialUnit = initial.kind === 'serving' ? Math.max(0, units.findIndex((u) => u.label === servingLabel(food.unit, initial.serving))) : units.length - 1;
  const [unit, setUnit] = useState(initialUnit);
  const [text, setText] = useState(editable(initial.kind === 'serving' ? initial.count : initial.amount));

  const n = parseNumber(text);
  const choice = units[unit];
  const quantity = choice !== undefined && n !== null && n > 0 ? choice.quantity(n) : null;

  const picker = (
    <div class="quantity-picker">
      <input class="quantity-amount" aria-label="Amount" inputMode="decimal" autoComplete="off" value={text} onInput={(event) => setText(event.currentTarget.value)} />
      <div class="chips" role="radiogroup" aria-label="Unit">
        {units.map((u, i) => (
          <button type="button" role="radio" key={u.label} aria-checked={i === unit} onClick={() => setUnit(i)}>
            {u.label}
          </button>
        ))}
      </div>
    </div>
  );
  return { quantity, picker };
}

/** Kcal and each macro on one line. A tap opens whichever other nutrients the food knows. */
export function NutritionPreview({ nutrients }: { readonly nutrients: Nutrients | null }) {
  const extras = NUTRIENTS.filter((n) => !n.core && nutrients?.[n.key] !== undefined);
  return (
    <details class="card nutrition" aria-live="polite">
      <summary>
        <span class="nutrition-line">
          <span class="hero-line">
            <strong data-testid="preview-kcal">{nutrients === null ? '–' : kcal(nutrients.kcal)}</strong> kcal
          </span>
          <span class="detail">{macrosLine(nutrients)}</span>
        </span>
        {extras.length > 0 && <Icon name="chevronRight" />}
      </summary>
      {extras.length > 0 && <p class="detail nutrition-extras">{extras.map((n) => `${n.label} ${amount(nutrients?.[n.key] ?? 0)} ${n.unit}`).join(' · ')}</p>}
    </details>
  );
}

export function FoodHeading({ food }: { readonly food: Pick<FoodSnapshot, 'name' | 'brand'> }) {
  return (
    <div class="sheet-heading">
      <h3>{food.name}</h3>
      {brandOf(food) !== undefined && <p class="detail">{brandOf(food)}</p>}
    </div>
  );
}

export function MealPicker({ value, onChange }: { readonly value: Meal; readonly onChange: (meal: Meal) => void }) {
  return <Segmented label="Meal" options={MEALS.map((m) => ({ value: m, label: MEAL_LABEL[m] }))} value={value} onChange={onChange} />;
}

/** A secondary action under a food sheet's main button, such as "Edit food". */
export interface SheetLink {
  readonly label: string;
  readonly onClick: () => void;
}

/** Logging goes to the meal already chosen. Editing an entry can also move it to another. */
export type FoodSheetMode =
  | { readonly kind: 'log'; readonly onLog: (quantity: Quantity) => void }
  | { readonly kind: 'edit'; readonly onSave: (quantity: Quantity, meal: Meal) => void; readonly onDelete: () => void };

/** Log a food, or change an entry's amount and meal, with the nutrients updating as you type. */
export function FoodSheet({
  food,
  initial,
  meal: initialMeal,
  mode,
  link,
  onClose,
}: {
  readonly food: FoodSnapshot;
  readonly initial: Quantity;
  readonly meal: Meal;
  readonly mode: FoodSheetMode;
  readonly link?: SheetLink;
  readonly onClose: () => void;
}) {
  const { quantity, picker } = useQuantityPicker(food, initial);
  const [meal, setMeal] = useState(initialMeal);
  const nutrients = quantity === null ? null : nutrientsFor(food, quantity);

  return (
    <Sheet title={mode.kind === 'log' ? 'Log food' : 'Edit entry'} onClose={onClose}>
      <FoodHeading food={food} />
      <NutritionPreview nutrients={nutrients} />
      {picker}
      {mode.kind === 'edit' && <MealPicker value={meal} onChange={setMeal} />}
      <div class="sheet-actions">
        {mode.kind === 'log' ? (
          <button type="button" class="primary" disabled={quantity === null} onClick={() => quantity && mode.onLog(quantity)}>
            Log to {MEAL_LABEL[initialMeal]}
          </button>
        ) : (
          <>
            <button type="button" class="primary" disabled={quantity === null} onClick={() => quantity && mode.onSave(quantity, meal)}>
              Save
            </button>
            <button type="button" class="destructive" onClick={mode.onDelete}>
              Delete entry
            </button>
          </>
        )}
        {link && (
          <button type="button" class="text-button" onClick={link.onClick}>
            {link.label}
          </button>
        )}
      </div>
    </Sheet>
  );
}
