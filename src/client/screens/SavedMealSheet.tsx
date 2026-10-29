import type { Meal } from '../../domain/diary.js';
import { nutrientsFor, type Ingredient } from '../../domain/food.js';
import { itemsNutrients, type SavedMeal } from '../../domain/reuse.js';
import { useIntents } from '../views.js';
import { MEAL_LABEL, brandOf, kcal, quantityLabel } from './format.js';
import { LogAction, NutritionPreview } from './FoodSheet.js';
import { Sheet, useToast } from './ui.js';

/** Food lines of a bundle (a saved meal, a recipe, a meal to copy): name, amount and kcal. */
export function ItemList({ items, label }: { readonly items: readonly Ingredient[]; readonly label: string }) {
  return (
    <ul class="list" aria-label={label}>
      {items.map((item, i) => (
        <li key={i}>
          <div class="entry-row">
            <span class="food-name">{item.food.name}</span>
            <span class="food-detail">{[brandOf(item.food), quantityLabel(item.food, item.quantity)].filter(Boolean).join(' · ')}</span>
            <span class="entry-kcal">{kcal(nutrientsFor(item.food, item.quantity).kcal)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** A saved meal's items and totals, logged together into any meal. */
export function SavedMealSheet({
  meal,
  slotMeal,
  onLog,
  onClose,
}: {
  readonly meal: SavedMeal;
  readonly slotMeal: Meal;
  readonly onLog: (meal: Meal) => void;
  readonly onClose: () => void;
}) {
  const intents = useIntents();
  const toast = useToast();
  return (
    <Sheet title="Saved meal" onClose={onClose}>
      <div class="food-heading">
        <h3>{meal.name}</h3>
      </div>
      <NutritionPreview nutrients={itemsNutrients(meal.items)} />
      <ItemList items={meal.items} label={`${meal.name} items`} />
      <LogAction meal={slotMeal} label={(m) => `Log to ${MEAL_LABEL[m]}`} disabled={false} onLog={onLog} />
      <div class="sheet-actions">
        <button
          type="button"
          class="destructive"
          onClick={() =>
            void intents.archiveMeal(meal.id).then((undo) => {
              toast({ text: `Deleted ${meal.name}`, undo });
              onClose();
            })
          }
        >
          Delete saved meal
        </button>
      </div>
    </Sheet>
  );
}
