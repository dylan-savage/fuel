import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { defaultQuantity, missingCore, nutrientsFor, type FoodCandidate, type FoodSnapshot, type Quantity } from '../../domain/food.js';
import { CORE_KEYS, NUTRIENTS, type CoreKey, type PartialNutrients } from '../../domain/nutrients.js';
import { BASIS_LABEL, amount, parseNumber } from './format.js';
import { NutritionPreview, useQuantityPicker } from './FoodSheet.js';
import { NumberField, Sheet, TextField } from './ui.js';

const SOURCE_LABEL: Readonly<Record<FoodCandidate['source']['kind'], string>> = {
  off: 'Open Food Facts',
  usda: 'USDA FoodData Central',
  user: 'you',
  ai: 'AI',
};

const coreLabel = (key: CoreKey) => NUTRIENTS.find((n) => n.key === key)?.label ?? key;
const coreUnit = (key: CoreKey) => NUTRIENTS.find((n) => n.key === key)?.unit ?? '';

/** The edited candidate and the amount picked, once every core nutrient is known. */
export interface Confirmed {
  readonly candidate: FoodCandidate;
  readonly quantity: Quantity;
}

/**
 * Review an external food before it enters the library: fix the name, fill in any core
 * nutrient the source left out and pick an amount. `action` ends the sheet, such as logging
 * it to a meal or adding it to a recipe; it gets null until the food is complete.
 */
export function ConfirmSheet({
  candidate,
  action,
  onClose,
}: {
  readonly candidate: FoodCandidate;
  readonly action: (confirmed: Confirmed | null) => ComponentChildren;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState(candidate.name);
  const [brand, setBrand] = useState(candidate.brand ?? '');
  /** Only what Dylan typed. An untouched field keeps the source's exact value, not its display rounding. */
  const [typed, setTyped] = useState<Readonly<Partial<Record<CoreKey, string>>>>({});

  const nutrients: PartialNutrients = { ...candidate.nutrients };
  for (const key of CORE_KEYS) {
    const text = typed[key];
    if (text === undefined) continue;
    const value = parseNumber(text);
    if (value !== null && value >= 0) nutrients[key] = value;
    else delete nutrients[key];
  }
  const shownCore = (key: CoreKey) => {
    const source = candidate.nutrients[key];
    return typed[key] ?? (source === undefined ? '' : String(Math.round(source * 10) / 10));
  };
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
      <h4 class="section-heading">Per {BASIS_LABEL[candidate.unit]}</h4>
      <div class="group">
        {CORE_KEYS.map((key) => (
          <NumberField
            key={key}
            label={coreLabel(key)}
            unit={coreUnit(key)}
            value={shownCore(key)}
            placeholder="Required"
            invalid={missing.includes(key)}
            onInput={(value) => setTyped({ ...typed, [key]: value })}
          />
        ))}
      </div>
      {extras.length > 0 && <p class="extras">{extras.map((n) => `${n.label} ${amount(nutrients[n.key] ?? 0)} ${n.unit}`).join(' · ')}</p>}
      <NutritionPreview nutrients={snapshot && quantity ? nutrientsFor(snapshot, quantity) : null} />
      {picker}
      {missing.length > 0 && <p class="hint">Add {missing.map(coreLabel).join(', ').toLowerCase()} from the label to save this food.</p>}
      {action(missing.length === 0 && quantity !== null ? { candidate: edited, quantity } : null)}
    </Sheet>
  );
}
