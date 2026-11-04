import { useState } from 'preact/hooks';
import { ML_PER_FL_OZ, Water } from '../../domain/habits.js';
import type { LocalDate } from '../../domain/ids.js';
import { useIntents, useLive, waterView, type WaterView } from '../views.js';
import { amount, dayTitle, flOz, parseNumber, timeOfDay } from './format.js';
import { Icon, NumberField, Ring, Sheet, useToast } from './ui.js';

/** A glass and a bottle. */
const TILE_OZ = [8, 16] as const;
const SHEET_OZ = [8, 12, 16, 24] as const;

function useAddWater(date: LocalDate) {
  const intents = useIntents();
  const toast = useToast();
  return (oz: number) => void intents.addWater(oz * ML_PER_FL_OZ, date).then((undo) => toast({ text: `Added ${amount(oz)} fl oz of water`, undo }));
}

function WaterSheet({ date, today, view, onClose }: { readonly date: LocalDate; readonly today: LocalDate; readonly view: WaterView; readonly onClose: () => void }) {
  const intents = useIntents();
  const toast = useToast();
  const add = useAddWater(date);
  const [other, setOther] = useState('');
  const parsed = parseNumber(other);
  /** A drink the mini will accept, else null. */
  const otherOz = parsed !== null && Water.shape.ml.safeParse(parsed * ML_PER_FL_OZ).success ? parsed : null;

  return (
    <Sheet title="Water" onClose={onClose}>
      <div class="hero">
        <Ring size={184} fraction={view.totalMl / view.goalMl} tone="water">
          <span class="hero-label">{dayTitle(date, today)}</span>
          <strong class="hero-value">{flOz(view.totalMl)}</strong>
          <span class="hero-sub">of {flOz(view.goalMl)} fl oz</span>
        </Ring>
      </div>
      <div class="pills">
        {SHEET_OZ.map((oz) => (
          <button type="button" class="pill" key={oz} aria-label={`Add ${oz} fl oz of water`} onClick={() => add(oz)}>
            +{oz} oz
          </button>
        ))}
      </div>
      <div class="group">
        <NumberField label="Other amount" unit="fl oz" value={other} onInput={setOther} placeholder="16.9" invalid={other.trim() !== '' && otherOz === null} />
      </div>
      <div class="sheet-actions">
        <button
          type="button"
          class="primary"
          disabled={otherOz === null}
          onClick={() => {
            if (otherOz === null) return;
            add(otherOz);
            setOther('');
          }}
        >
          Add {otherOz === null ? 'water' : `${amount(otherOz)} fl oz`}
        </button>
      </div>
      <h4 class="section-heading">Drinks</h4>
      {view.drinks.length === 0 ? (
        <p class="empty">No water logged yet.</p>
      ) : (
        <ul class="list" aria-label="Drinks">
          {view.drinks.map((drink) => (
            <li class="food-row" key={drink.id}>
              <span class="drink">
                <span>{flOz(drink.ml)} fl oz</span>
                <span class="food-detail">{timeOfDay(drink.loggedAt)}</span>
              </span>
              <button
                type="button"
                class="text-button remove"
                aria-label={`Remove ${flOz(drink.ml)} fl oz at ${timeOfDay(drink.loggedAt)}`}
                onClick={() => void intents.deleteWater(drink.id).then((undo) => toast({ text: 'Removed a drink', undo }))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <p class="hint">Change the daily goal on the Goal screen.</p>
    </Sheet>
  );
}

/** Today's water at a glance: a ring toward the goal and one-tap drinks. */
export function WaterTile({ date, today }: { readonly date: LocalDate; readonly today: LocalDate }) {
  const view = useLive((r) => waterView(r, date), [date]);
  const add = useAddWater(date);
  const [open, setOpen] = useState(false);
  if (view === undefined) return <section class="card tile" aria-label="Water" />;

  return (
    <section class="card tile" aria-label="Water">
      <button type="button" class="tile-main" onClick={() => setOpen(true)}>
        <Ring size={52} fraction={view.totalMl / view.goalMl} tone="water">
          <Icon name="drop" />
        </Ring>
        <span class="tile-text">
          <span class="tile-title">Water</span>
          <span class="tile-value">
            <strong data-testid="water-total">{flOz(view.totalMl)}</strong>
            <small> / {flOz(view.goalMl)} oz</small>
          </span>
        </span>
      </button>
      <div class="pills">
        {TILE_OZ.map((oz) => (
          <button type="button" class="pill" key={oz} aria-label={`Add ${oz} fl oz of water`} onClick={() => add(oz)}>
            +{oz} oz
          </button>
        ))}
      </div>
      {open && <WaterSheet date={date} today={today} view={view} onClose={() => setOpen(false)} />}
    </section>
  );
}
