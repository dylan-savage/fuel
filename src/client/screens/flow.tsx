/** The sheets that end in a diary entry, as one state machine shared by the Add and Scan screens. */
import { useCallback, useState } from 'preact/hooks';
import type { Slot } from '../../domain/diary.js';
import { defaultQuantity, snapshotOf, type FoodCandidate, type FoodSnapshot, type Quantity } from '../../domain/food.js';
import { recipeSnapshot, type SavedMeal } from '../../domain/reuse.js';
import type { Logged } from '../intents.js';
import { useIntents, useRead } from '../views.js';
import { ConfirmSheet } from './ConfirmSheet.js';
import { FoodEditor, type EditorSeed } from './FoodEditor.js';
import { FoodSheet, type SheetLink } from './FoodSheet.js';
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
  const logged = (name: string) => (result: Logged) => {
    setFlow({ kind: 'closed' });
    onLogged(`Logged ${name} to ${MEAL_LABEL[slot.meal]}`, result);
  };

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
          mode={{ kind: 'log', onLog: (quantity) => void intents.logItems([{ food, quantity }], slot).then(logged(food.name)) }}
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
            <div class="sheet-actions">
              <button
                type="button"
                class="primary"
                disabled={confirmed === null}
                onClick={() => {
                  if (confirmed === null) return;
                  void intents.importAndLog(confirmed.candidate, confirmed.quantity, slot).then((result) => {
                    if (result.ok) logged(confirmed.candidate.name)(result.logged);
                  });
                }}
              >
                Log to {MEAL_LABEL[slot.meal]}
              </button>
            </div>
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
      sheet = <SavedMealSheet meal={saved} slotMeal={slot.meal} onLog={() => void intents.logItems(saved.items, slot).then(logged(saved.name))} onClose={close} />;
      break;
    }
    case 'quick-add':
      sheet = (
        <QuickAddSheet meal={slot.meal} onLog={(item) => void intents.logItems([item], slot).then(logged(item.food.name))} onClose={close} />
      );
      break;
  }
  return { open: setFlow, sheet };
}
