/**
 * The sheets that end in a diary entry, as one state machine shared by the Add and Scan
 * screens: log a known food, confirm an external one, create one by hand, or quick add.
 */
import { useCallback, useState } from 'preact/hooks';
import type { Meal, Slot } from '../../domain/diary.js';
import { defaultQuantity, snapshotOf, type FoodCandidate, type FoodSnapshot, type Quantity } from '../../domain/food.js';
import type { Logged } from '../intents.js';
import { useIntents, useRead } from '../views.js';
import { ConfirmSheet } from './ConfirmSheet.js';
import { FoodEditor, type EditorSeed } from './FoodEditor.js';
import { FoodSheet } from './FoodSheet.js';
import { MEAL_LABEL } from './format.js';
import { QuickAddSheet } from './QuickAdd.js';

export type Flow =
  | { readonly kind: 'closed' }
  | { readonly kind: 'food'; readonly food: FoodSnapshot; readonly quantity: Quantity }
  | { readonly kind: 'confirm'; readonly candidate: FoodCandidate }
  | { readonly kind: 'editor'; readonly seed: EditorSeed }
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

  let sheet = null;
  switch (flow.kind) {
    case 'closed':
      break;
    case 'food': {
      const { food } = flow;
      const origin = food.origin;
      const editFood =
        origin.kind === 'food'
          ? {
              onEditFood: () =>
                void read((r) => r.get('food', origin.id)).then((library) => {
                  if (library) setFlow({ kind: 'editor', seed: { kind: 'edit', food: library } });
                }),
            }
          : {};
      sheet = (
        <FoodSheet
          food={food}
          initial={flow.quantity}
          meal={slot.meal}
          mode={{ kind: 'log', onLog: (quantity, meal) => void intents.logItems([{ food, quantity }], at(meal)).then(logged(food.name, meal)) }}
          onClose={close}
          {...editFood}
        />
      );
      break;
    }
    case 'confirm':
      sheet = (
        <ConfirmSheet
          candidate={flow.candidate}
          meal={slot.meal}
          onConfirm={(candidate, quantity, meal) =>
            void intents.importAndLog(candidate, quantity, at(meal)).then((result) => {
              if (result.ok) logged(candidate.name, meal)(result.logged);
            })
          }
          onClose={close}
        />
      );
      break;
    case 'editor':
      sheet = (
        <FoodEditor seed={flow.seed} onSaved={(food) => setFlow({ kind: 'food', food: snapshotOf(food), quantity: defaultQuantity(food) })} onClose={close} />
      );
      break;
    case 'quick-add':
      sheet = (
        <QuickAddSheet meal={slot.meal} onLog={(item, meal) => void intents.logItems([item], at(meal)).then(logged(item.food.name, meal))} onClose={close} />
      );
      break;
  }
  return { open: setFlow, sheet };
}
