import { useEffect, useState } from 'preact/hooks';
import { entryNutrients, mealAt } from '../../domain/diary.js';
import { quickAddItem } from '../../domain/food.js';
import { localDate } from '../clock.js';
import type { Undo } from '../intents.js';
import { dayView, useIntents, useLive } from '../views.js';

const kcal = (n: number) => Math.round(n).toLocaleString();

export function Today() {
  const date = localDate();
  const day = useLive((r) => dayView(r, date), [date])?.summary;
  const intents = useIntents();
  const [undo, setUndo] = useState<{ readonly label: string; readonly run: Undo } | null>(null);

  useEffect(() => {
    if (undo === null) return;
    const timer = setTimeout(() => setUndo(null), 6000);
    return () => clearTimeout(timer);
  }, [undo]);

  if (day === undefined) return null;
  return (
    <section class="today">
      <p class="total">
        <strong data-testid="kcal-total">{kcal(day.totals.sum.kcal)}</strong> kcal today
      </p>
      <QuickAdd
        onAdd={(label, energy) => intents.logItems([quickAddItem(label, { kcal: energy })], { date, meal: mealAt(new Date().getHours()) })}
      />
      <ul class="entries">
        {day.entries.map((entry) => (
          <li key={entry.id}>
            <span class="name">{entry.food.name}</span>
            <span class="kcal">{kcal(entryNutrients(entry).kcal)}</span>
            <button
              class="delete"
              aria-label={`Delete ${entry.food.name}`}
              onClick={() => void intents.deleteEntry(entry.id).then((run) => setUndo({ label: entry.food.name, run }))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {undo && (
        <div class="toast" role="status">
          Deleted {undo.label}
          <button
            onClick={() => {
              setUndo(null);
              void undo.run();
            }}
          >
            Undo
          </button>
        </div>
      )}
    </section>
  );
}

function QuickAdd({ onAdd }: { readonly onAdd: (label: string, kcal: number) => Promise<unknown> }) {
  const [label, setLabel] = useState('');
  const [energy, setEnergy] = useState('');
  const value = Number(energy);
  const valid = energy.trim() !== '' && Number.isFinite(value) && value > 0;

  return (
    <form
      class="quick-add"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        void onAdd(label, value);
        setLabel('');
        setEnergy('');
      }}
    >
      <input aria-label="What" placeholder="Quick add" value={label} onInput={(e) => setLabel(e.currentTarget.value)} />
      <input
        aria-label="kcal"
        placeholder="kcal"
        inputMode="decimal"
        value={energy}
        onInput={(e) => setEnergy(e.currentTarget.value)}
      />
      <button type="submit" disabled={!valid}>
        Add
      </button>
    </form>
  );
}
