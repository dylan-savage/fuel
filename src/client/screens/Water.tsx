import { useState } from 'preact/hooks';
import { ML_PER_FL_OZ, Water } from '../../domain/habits.js';
import type { LocalDate } from '../../domain/ids.js';
import { useIntents, useLive, waterView, type WaterView } from '../views.js';
import { amount, dayPhrase, flOz, parseNumber, timeOfDay } from './format.js';
import { Icon, NumberField, Row, Sheet, Stat, useToast } from './ui.js';

const DRINK_OZ = [8, 12, 16, 24] as const;

function WaterSheet({ date, today, view, onClose }: { readonly date: LocalDate; readonly today: LocalDate; readonly view: WaterView; readonly onClose: () => void }) {
  const intents = useIntents();
  const toast = useToast();
  const [other, setOther] = useState('');
  const parsed = parseNumber(other);
  /** A drink the mini will accept, else null. */
  const otherOz = parsed !== null && Water.shape.ml.safeParse(parsed * ML_PER_FL_OZ).success ? parsed : null;
  const add = (oz: number) => void intents.addWater(oz * ML_PER_FL_OZ, date).then((undo) => toast({ text: `Added ${amount(oz)} fl oz of water`, undo }));

  return (
    <Sheet title={date === today ? 'Water' : `Water, ${dayPhrase(date, today)}`} onClose={onClose} closeLabel="Done">
      <div class="card">
        <p class="hero-line">
          <strong data-testid="water-sheet-total">{flOz(view.totalMl)}</strong> of {flOz(view.goalMl)} fl oz
        </p>
        <div class="bar small water" role="presentation">
          <span style={{ width: `${Math.min(1, view.totalMl / view.goalMl) * 100}%` }} />
        </div>
      </div>
      <div class="pills">
        {DRINK_OZ.map((oz) => (
          <button type="button" class="pill" key={oz} aria-label={`Add ${oz} fl oz of water`} onClick={() => add(oz)}>
            +{oz} oz
          </button>
        ))}
      </div>
      <div class="group">
        <NumberField label="Other amount" unit="fl oz" value={other} onInput={setOther} placeholder="16.9" invalid={other.trim() !== '' && otherOz === null} />
      </div>
      {otherOz !== null && (
        <div class="sheet-actions">
          <button
            type="button"
            class="primary"
            onClick={() => {
              add(otherOz);
              setOther('');
            }}
          >
            Add {amount(otherOz)} fl oz
          </button>
        </div>
      )}
      {view.drinks.length > 0 && (
        <>
          <h4 class="section-heading">Drinks</h4>
          <ul class="list" aria-label="Drinks">
            {view.drinks.map((drink) => (
              <li class="split-row" key={drink.id}>
                <Row name={`${flOz(drink.ml)} fl oz`} end={timeOfDay(drink.loggedAt)} />
                <button
                  type="button"
                  class="icon-button remove"
                  aria-label={`Remove ${flOz(drink.ml)} fl oz at ${timeOfDay(drink.loggedAt)}`}
                  onClick={() => void intents.deleteWater(drink.id).then((undo) => toast({ text: 'Removed a drink', undo }))}
                >
                  <Icon name="close" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Sheet>
  );
}

/** The day's water as one number, opening the sheet that logs it. */
export function WaterStat({ date, today }: { readonly date: LocalDate; readonly today: LocalDate }) {
  const view = useLive((r) => waterView(r, date), [date]);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Stat
        label="Water"
        value={
          view === undefined ? (
            '–'
          ) : (
            <>
              <span data-testid="water-total">{flOz(view.totalMl)}</span> oz
            </>
          )
        }
        onClick={() => setOpen(true)}
      />
      {open && view !== undefined && <WaterSheet date={date} today={today} view={view} onClose={() => setOpen(false)} />}
    </>
  );
}
