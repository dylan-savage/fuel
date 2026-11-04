/** The sheets that end in a diary entry, as one state machine shared by the Add and Scan screens. */
import { useCallback, useState } from 'preact/hooks';
import type { Meal, Slot } from '../../domain/diary.js';
import { defaultQuantity, snapshotOf, type FoodCandidate, type FoodSnapshot, type Quantity } from '../../domain/food.js';
import { recipeSnapshot, type SavedMeal } from '../../domain/reuse.js';
import type { Logged } from '../intents.js';
import { useIntents, useRead } from '../views.js';
import { ConfirmSheet } from './ConfirmSheet.js';
import { FoodEditor, type EditorSeed } from './FoodEditor.js';
import { FoodSheet, LogAction, type SheetLink } from './FoodSheet.js';
import { MEAL_LABEL } from './format.js';
import { QuickAddSheet } from './QuickAdd.js';
import { RecipeBuilder, type RecipeSeed } from './RecipeBuilder.js';
import { SavedMealSheet } from './SavedMealSheet.js';

export type Flow =
  | { readonly kind: 'closed' }
  | { readonly kind: 'food'; readonly food: FoodSnapshot; readonly quantity: Quantity }
  | { readonly kind: 'confirm'; readonly candidate: FoodCandidate }
  | { readonly kind: 'editor'; readonly seed: EditorSeed }
  | { readonly kind: 'recipe'; readonly seed: RecipeSeed }
  | { readonly kind: 'meal'; readonly meal: SavedMeal }
  | { readonly kind: 'quick-add' };

/** Called after a sheet logs something, with the toast text and the undo. */
export type OnLogged = (text: string, logged: Logged) => void;

export function useLogFlow(slot: Slot, onLogged: OnLogged) {
  const [flow, setFlow] = useState<Flow>({ kind: 'closed' });
  const intents = useIntents();
  const read = useRead();
  const close = useCallback(() => setFlow({ kind: 'closed' }), []);
  const logged = (name: string, meal: Meal) => (result: Logged) => {
    setFlow({ kind: 'closed' });
    onLogged(`Logged ${name} to ${MEAL_LABEL[meal]}`, result);
  };
  const at = (meal: Meal): Slot => ({ date: slot.date, meal });

  /** "Edit food" or "Edit recipe" under the log sheet, for whatever the snapshot came from. */
  const editLink = (food: FoodSnapshot): SheetLink | undefined => {
    const { origin } = food;
    switch (origin.kind) {
      case 'adhoc':
        return undefined;
      case 'food':
        return {
          label: 'Edit food',
          onClick: () =>
            void read((r) => r.get('food', origin.id)).then((library) => {
              if (library) setFlow({ kind: 'editor', seed: { kind: 'edit', food: library } });
            }),
        };
      case 'recipe':
        return {
          label: 'Edit recipe',
          onClick: () =>
            void read((r) => r.get('recipe', origin.id)).then((recipe) => {
              if (recipe) setFlow({ kind: 'recipe', seed: { kind: 'edit', recipe } });
            }),
        };
    }
  };

  let sheet = null;
  switch (flow.kind) {
    case 'closed':
      break;
    case 'food': {
      const { food } = flow;
      const link = editLink(food);
      sheet = (
        <FoodSheet
          food={food}
          initial={flow.quantity}
          meal={slot.meal}
          mode={{ kind: 'log', onLog: (quantity, meal) => void intents.logItems([{ food, quantity }], at(meal)).then(logged(food.name, meal)) }}
          onClose={close}
          {...(link === undefined ? {} : { link })}
        />
      );
      break;
    }
    case 'confirm':
      sheet = (
        <ConfirmSheet
          candidate={flow.candidate}
          onClose={close}
          action={(confirmed) => (
            <LogAction
              meal={slot.meal}
              label={(meal) => `Add to library and log to ${MEAL_LABEL[meal]}`}
              disabled={confirmed === null}
              onLog={(meal) => {
                if (confirmed === null) return;
                void intents.importAndLog(confirmed.candidate, confirmed.quantity, at(meal)).then((result) => {
                  if (result.ok) logged(confirmed.candidate.name, meal)(result.logged);
                });
              }}
            />
          )}
        />
      );
      break;
    case 'editor':
      sheet = (
        <FoodEditor seed={flow.seed} onSaved={(food) => setFlow({ kind: 'food', food: snapshotOf(food), quantity: defaultQuantity(food) })} onClose={close} />
      );
      break;
    case 'recipe':
      sheet = (
        <RecipeBuilder
          seed={flow.seed}
          onSaved={(recipe) => {
            const food = recipeSnapshot(recipe);
            setFlow({ kind: 'food', food, quantity: defaultQuantity(food) });
          }}
          onClose={close}
        />
      );
      break;
    case 'meal': {
      const saved = flow.meal;
      sheet = <SavedMealSheet meal={saved} slotMeal={slot.meal} onLog={(meal) => void intents.logItems(saved.items, at(meal)).then(logged(saved.name, meal))} onClose={close} />;
      break;
    }
    case 'quick-add':
      sheet = (
        <QuickAddSheet meal={slot.meal} onLog={(item, meal) => void intents.logItems([item], at(meal)).then(logged(item.food.name, meal))} onClose={close} />
      );
      break;
  }
  return { open: setFlow, sheet };
}
