import { useMemo, useState } from 'preact/hooks';
import { MEALS, type Meal } from '../../domain/diary.js';
import { nutrientsFor, type FoodSnapshot, type Quantity, type Serving } from '../../domain/food.js';
import { NUTRIENTS, type Nutrients } from '../../domain/nutrients.js';
import { MEAL_LABEL, UNIT_LABEL, amount, brandOf, editable, kcal, parseNumber, servingLabel } from './format.js';
import { Segmented, Sheet } from './ui.js';

const sameServing = (a: Serving, b: Serving) => a.label === b.label && a.amount === b.amount;

interface UnitChoice {
  readonly label: string;
  readonly quantity: (n: number) => Quantity;
}

/**
 * The amount picker: a number and a unit, where the units are the food's named servings plus
 * its base unit. A serving the food no longer lists still shows when the quantity carries it.
 */
export function useQuantityPicker(food: Pick<FoodSnapshot, 'unit' | 'servings'>, initial: Quantity, onChange?: (quantity: Quantity | null) => void) {
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

  const quantityOf = (unitIndex: number, value: string): Quantity | null => {
    const n = parseNumber(value);
    const choice = units[unitIndex];
    return choice !== undefined && n !== null && n > 0 ? choice.quantity(n) : null;
  };
  const quantity = quantityOf(unit, text);

  const picker = (
    <div class="quantity-picker">
      <input
        class="quantity-amount"
        aria-label="Amount"
        inputMode="decimal"
        autoComplete="off"
        value={text}
        onInput={(event) => {
          setText(event.currentTarget.value);
          onChange?.(quantityOf(unit, event.currentTarget.value));
        }}
      />
      <div class="chips" role="radiogroup" aria-label="Unit">
        {units.map((u, i) => (
          <button
            type="button"
            role="radio"
            key={u.label}
            aria-checked={i === unit}
            onClick={() => {
              setUnit(i);
              onChange?.(quantityOf(i, text));
            }}
          >
            {u.label}
          </button>
        ))}
      </div>
    </div>
  );
  return { quantity, picker };
}

/** Kcal large, then each macro, then whichever optional nutrients the food knows. */
export function NutritionPreview({ nutrients }: { readonly nutrients: Nutrients | null }) {
  return (
    <div class="preview" aria-live="polite">
      <p class="preview-kcal">
        <strong data-testid="preview-kcal">{nutrients === null ? '–' : kcal(nutrients.kcal)}</strong> kcal
      </p>
      <dl class="preview-macros">
        {NUTRIENTS.filter((n) => n.key !== 'kcal' && (n.core || nutrients?.[n.key] !== undefined)).map((n) => {
          const value = nutrients?.[n.key];
          return (
            <div key={n.key} class={n.core ? 'core' : 'extra'}>
              <dt>{n.label}</dt>
              <dd>{value === undefined ? '–' : `${amount(value)} ${n.unit}`}</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

export function FoodHeading({ food }: { readonly food: Pick<FoodSnapshot, 'name' | 'brand'> }) {
  return (
    <div class="food-heading">
      <h3>{food.name}</h3>
      {brandOf(food) !== undefined && <p>{brandOf(food)}</p>}
    </div>
  );
}

export function MealPicker({ value, onChange }: { readonly value: Meal; readonly onChange: (meal: Meal) => void }) {
  return <Segmented label="Meal" options={MEALS.map((m) => ({ value: m, label: MEAL_LABEL[m] }))} value={value} onChange={onChange} />;
}

/** The end of a log sheet: which meal, and the button that logs to it. */
export function LogAction({
  meal: initialMeal,
  label,
  disabled,
  onLog,
}: {
  readonly meal: Meal;
  readonly label: (meal: Meal) => string;
  readonly disabled: boolean;
  readonly onLog: (meal: Meal) => void;
}) {
  const [meal, setMeal] = useState(initialMeal);
  return (
    <>
      <MealPicker value={meal} onChange={setMeal} />
      <div class="sheet-actions">
        <button type="button" class="primary" disabled={disabled} onClick={() => onLog(meal)}>
          {label(meal)}
        </button>
      </div>
    </>
  );
}

/** A secondary action under a food sheet's main button, such as "Edit food". */
export interface SheetLink {
  readonly label: string;
  readonly onClick: () => void;
}

export type FoodSheetMode =
  | { readonly kind: 'log'; readonly onLog: (quantity: Quantity, meal: Meal) => void }
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
      <MealPicker value={meal} onChange={setMeal} />
      <div class="sheet-actions">
        {mode.kind === 'log' ? (
          <button type="button" class="primary" disabled={quantity === null} onClick={() => quantity && mode.onLog(quantity, meal)}>
            Log to {MEAL_LABEL[meal]}
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
