import { useState } from 'preact/hooks';
import type { EditedRef, Refresh } from '../../domain/reuse.js';
import { useIntents, useRead, usesView } from '../views.js';
import { count } from './format.js';
import { Alert, useToast } from './ui.js';

/** "2 recipes and 1 saved meal". */
function usesText(uses: Refresh): string {
  return [
    ...(uses.recipes.length > 0 ? [count(uses.recipes.length, 'recipe')] : []),
    ...(uses.meals.length > 0 ? [count(uses.meals.length, 'saved meal')] : []),
  ].join(' and ');
}

/** A saved edit waiting on "also update these?", and what runs once it is answered. */
interface Asking {
  readonly ref: EditedRef;
  readonly name: string;
  readonly uses: Refresh;
  readonly then: () => void;
}

/**
 * Call `saved` after a food or recipe is saved. When recipes or saved meals hold an older
 * snapshot of it, `prompt` asks "also update 2 recipes and 1 saved meal?" and updates them
 * only on yes. Either way `then` runs once, after the answer.
 */
export function useUpdatePrompt() {
  const intents = useIntents();
  const read = useRead();
  const toast = useToast();
  const [asking, setAsking] = useState<Asking | null>(null);

  const saved = async (ref: EditedRef, name: string, then: () => void) => {
    const uses = await read((r) => usesView(r, ref));
    if (uses.recipes.length + uses.meals.length > 0) {
      setAsking({ ref, name, uses, then });
      return;
    }
    toast({ text: `Saved ${name}` });
    then();
  };

  const answer = (update: boolean) => {
    if (asking === null) return;
    setAsking(null);
    if (!update) {
      toast({ text: `Saved ${asking.name}` });
      asking.then();
      return;
    }
    void intents.updateUsesOf(asking.ref).then(({ undo }) => {
      toast({ text: `Saved ${asking.name} and updated ${usesText(asking.uses)}`, undo });
      asking.then();
    });
  };

  const prompt =
    asking === null ? null : (
      <Alert
        title={`Also update ${usesText(asking.uses)}?`}
        message={`They still use the old ${asking.name}. Days you already logged stay as they are.`}
        actions={[
          { label: 'Update', preferred: true, onClick: () => answer(true) },
          { label: 'Not now', onClick: () => answer(false) },
        ]}
        onCancel={() => answer(false)}
      />
    );

  return { saved, prompt };
}
