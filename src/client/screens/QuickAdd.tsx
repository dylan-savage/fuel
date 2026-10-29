import { useState } from 'preact/hooks';
import type { Meal } from '../../domain/diary.js';
import { quickAddItem, type Ingredient } from '../../domain/food.js';
import { MACROS, type Nutrients } from '../../domain/nutrients.js';
import { MEAL_LABEL, parseNumber } from './format.js';
import { MealPicker } from './FoodSheet.js';
import { NumberField, Sheet, TextField } from './ui.js';

const MACRO_LABEL = { protein: 'Protein', carbs: 'Carbs', fat: 'Fat' } as const;

/** A one-off item with only kcal required, such as a restaurant meal. Macros are optional. */
export function QuickAddSheet({
  meal: initialMeal,
  onLog,
  onClose,
}: {
  readonly meal: Meal;
  readonly onLog: (item: Ingredient, meal: Meal) => void;
  readonly onClose: () => void;
}) {
  const [label, setLabel] = useState('');
  const [energy, setEnergy] = useState('');
  const [macros, setMacros] = useState({ protein: '', carbs: '', fat: '' });
  const [meal, setMeal] = useState(initialMeal);

  const kcal = parseNumber(energy);
  const nutrients: Nutrients | null = kcal !== null && kcal > 0 ? { kcal } : null;
  for (const macro of MACROS) {
    const value = parseNumber(macros[macro]);
    if (nutrients !== null && value !== null && value >= 0) nutrients[macro] = value;
  }

  return (
    <Sheet title="Quick add" onClose={onClose}>
      <div class="group">
        <TextField label="What" value={label} onInput={setLabel} placeholder="Quick add" />
        <NumberField label="Calories" unit="kcal" value={energy} onInput={setEnergy} placeholder="Required" />
      </div>
      <div class="group">
        {MACROS.map((macro) => (
          <NumberField
            key={macro}
            label={MACRO_LABEL[macro]}
            unit="g"
            value={macros[macro]}
            placeholder="Optional"
            onInput={(value) => setMacros({ ...macros, [macro]: value })}
          />
        ))}
      </div>
      <MealPicker value={meal} onChange={setMeal} />
      <div class="sheet-actions">
        <button type="button" class="primary" disabled={nutrients === null} onClick={() => nutrients && onLog(quickAddItem(label, nutrients), meal)}>
          Log to {MEAL_LABEL[meal]}
        </button>
      </div>
    </Sheet>
  );
}
