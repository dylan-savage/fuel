import type { Meal } from '../../domain/diary.js';
import type { Ingredient } from '../../domain/food.js';
import { itemsNutrients, type SavedMeal } from '../../domain/reuse.js';
import { useIntents } from '../views.js';
import { MEAL_LABEL, foodRowParts } from './format.js';
import { FoodHeading, NutritionPreview } from './FoodSheet.js';
import { Row, Sheet, useToast } from './ui.js';

/** Food lines of a bundle (a saved meal, a recipe, a meal to copy): name, amount and kcal. */
export function ItemList({ items, label }: { readonly items: readonly Ingredient[]; readonly label: string }) {
  return (
    <ul class="list foods" aria-label={label}>
      {items.map((item, i) => (
        <li key={i}>
          <Row {...foodRowParts(item.food, item.quantity)} />
        </li>
      ))}
    </ul>
  );
}

/** A saved meal's items and totals, logged together into the meal already chosen. */
export function SavedMealSheet({ meal, slotMeal, onLog, onClose }: { readonly meal: SavedMeal; readonly slotMeal: Meal; readonly onLog: () => void; readonly onClose: () => void }) {
  const intents = useIntents();
  const toast = useToast();
  return (
    <Sheet title="Saved meal" onClose={onClose}>
      <FoodHeading food={meal} />
      <NutritionPreview nutrients={itemsNutrients(meal.items)} />
      <ItemList items={meal.items} label={`${meal.name} items`} />
      <div class="sheet-actions">
        <button type="button" class="primary" onClick={onLog}>
          Log to {MEAL_LABEL[slotMeal]}
        </button>
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
