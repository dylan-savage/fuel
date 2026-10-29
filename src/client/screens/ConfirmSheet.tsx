import { useState } from 'preact/hooks';
import type { Meal } from '../../domain/diary.js';
import { defaultQuantity, missingCore, nutrientsFor, type FoodCandidate, type FoodSnapshot, type Quantity } from '../../domain/food.js';
import { CORE_KEYS, NUTRIENTS, type CoreKey, type PartialNutrients } from '../../domain/nutrients.js';
import { BASIS_LABEL, MEAL_LABEL, amount, parseNumber } from './format.js';
import { MealPicker, NutritionPreview, useQuantityPicker } from './FoodSheet.js';
import { NumberField, Sheet, TextField } from './ui.js';

const SOURCE_LABEL: Readonly<Record<FoodCandidate['source']['kind'], string>> = {
  off: 'Open Food Facts',
  usda: 'USDA FoodData Central',
  user: 'you',
  ai: 'AI',
};

const coreLabel = (key: CoreKey) => NUTRIENTS.find((n) => n.key === key)?.label ?? key;
const coreUnit = (key: CoreKey) => NUTRIENTS.find((n) => n.key === key)?.unit ?? '';

/**
 * Review an external food before it enters the library: fix the name, fill in any core
 * nutrient the source left out, pick an amount, then import and log in one tap.
 */
export function ConfirmSheet({
  candidate,
  meal: initialMeal,
  onConfirm,
  onClose,
}: {
  readonly candidate: FoodCandidate;
  readonly meal: Meal;
  readonly onConfirm: (candidate: FoodCandidate, quantity: Quantity, meal: Meal) => void;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState(candidate.name);
  const [brand, setBrand] = useState(candidate.brand ?? '');
  const [core, setCore] = useState<Readonly<Record<CoreKey, string>>>(() => {
    const text = (key: CoreKey) => {
      const value = candidate.nutrients[key];
      return value === undefined ? '' : amount(value);
    };
    return { kcal: text('kcal'), protein: text('protein'), carbs: text('carbs'), fat: text('fat') };
  });
  const [meal, setMeal] = useState(initialMeal);

  const nutrients: PartialNutrients = { ...candidate.nutrients };
  for (const key of CORE_KEYS) {
    const value = parseNumber(core[key]);
    if (value !== null && value >= 0) nutrients[key] = value;
    else delete nutrients[key];
  }
  const missing = missingCore(nutrients);
  const { brand: _sourceBrand, ...rest } = candidate;
  const edited: FoodCandidate = { ...rest, name: name.trim() || candidate.name, ...(brand.trim() === '' ? {} : { brand: brand.trim() }), nutrients };

  const snapshot: FoodSnapshot | null =
    nutrients.kcal === undefined
      ? null
      : { name: edited.name, unit: edited.unit, nutrients: { ...nutrients, kcal: nutrients.kcal }, servings: edited.servings, origin: { kind: 'adhoc' } };
  const [initial] = useState(() => defaultQuantity(candidate));
  const { quantity, picker } = useQuantityPicker(candidate, initial);
  const extras = NUTRIENTS.filter((n) => !n.core && nutrients[n.key] !== undefined);

  return (
    <Sheet title="Confirm food" onClose={onClose}>
      <p class="source-note">From {SOURCE_LABEL[candidate.source.kind]}. Check it against the label.</p>
      <div class="group">
        <TextField label="Name" value={name} onInput={setName} />
        <TextField label="Brand" value={brand} onInput={setBrand} placeholder="Optional" />
      </div>
      <h4 class="group-title">Per {BASIS_LABEL[candidate.unit]}</h4>
      <div class="group">
        {CORE_KEYS.map((key) => (
          <NumberField
            key={key}
            label={coreLabel(key)}
            unit={coreUnit(key)}
            value={core[key]}
            placeholder="Required"
            invalid={missing.includes(key)}
            onInput={(value) => setCore({ ...core, [key]: value })}
          />
        ))}
      </div>
      {extras.length > 0 && <p class="extras">{extras.map((n) => `${n.label} ${amount(nutrients[n.key] ?? 0)} ${n.unit}`).join(' · ')}</p>}
      <NutritionPreview nutrients={snapshot && quantity ? nutrientsFor(snapshot, quantity) : null} />
      {picker}
      <MealPicker value={meal} onChange={setMeal} />
      <div class="sheet-actions">
        {missing.length > 0 && <p class="hint">Add {missing.map(coreLabel).join(', ').toLowerCase()} from the label to save this food.</p>}
        <button
          type="button"
          class="primary"
          disabled={missing.length > 0 || quantity === null}
          onClick={() => quantity && onConfirm(edited, quantity, meal)}
        >
          Add to library and log to {MEAL_LABEL[meal]}
        </button>
      </div>
    </Sheet>
  );
}
