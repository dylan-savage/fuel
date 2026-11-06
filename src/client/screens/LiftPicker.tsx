/** The one lift picker: suggestions with no typing, then every lift A–Z, and a search that filters both or names a new lift. */
import { useState } from 'preact/hooks';
import type { Lift, LiftBook } from '../../domain/lifts.js';
import { pickList, type PickFor } from '../../domain/picks.js';
import type { DayRef, LiftChoice } from '../../domain/session.js';
import { pickerView, useLive } from '../views.js';
import { Sheet, TextField } from './ui.js';

function ChoiceList({ label, choices, onPick }: { readonly label: string; readonly choices: readonly LiftChoice[]; readonly onPick: (choice: LiftChoice) => void }) {
  return (
    <ul class="list" aria-label={label}>
      {choices.map((choice) => (
        <li key={choice.liftId}>
          <button type="button" class="row-button swap-choice" onClick={() => onPick(choice)}>
            {choice.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function LiftPicker({
  title,
  pickFor,
  day,
  lifts,
  book,
  onPick,
  onClose,
}: {
  readonly title: string;
  readonly pickFor: PickFor;
  readonly day: DayRef;
  readonly lifts: readonly Lift[];
  readonly book: LiftBook;
  readonly onPick: (choice: LiftChoice) => void;
  readonly onClose: () => void;
}) {
  const view = useLive((r) => pickerView(r, day), [day.key, day.date]);
  const [query, setQuery] = useState('');
  if (view === undefined) return null;
  const { suggested, others, typed } = pickList({ pickFor, lifts, book, newest: view.newest, dayHistory: view.dayHistory, query });
  return (
    <Sheet title={title} onClose={onClose}>
      <div class="group swap-search">
        <TextField label="Another lift" value={query} onInput={setQuery} placeholder="Search or type a name" />
      </div>
      {suggested.length > 0 && <ChoiceList label="Suggested" choices={suggested} onPick={onPick} />}
      {others.length > 0 && (
        <>
          <h3 class="section-heading">All lifts</h3>
          <ChoiceList label="All lifts" choices={others} onPick={onPick} />
        </>
      )}
      {typed !== null && (
        <ul class="list" aria-label="New lift">
          <li>
            <button type="button" class="row-button swap-choice" onClick={() => onPick(typed)}>
              Use "{typed.label}"
            </button>
          </li>
        </ul>
      )}
    </Sheet>
  );
}
