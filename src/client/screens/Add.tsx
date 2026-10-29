import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Meal, Slot } from '../../domain/diary.js';
import { defaultQuantity, nutrientsFor, snapshotOf, type FoodSnapshot, type Quantity, type SearchHit } from '../../domain/food.js';
import { searchLocal, type LocalHit } from '../../domain/library.js';
import { lookupFood, searchFoods, type Online } from '../api.js';
import { now } from '../clock.js';
import type { LocalDate } from '../../domain/ids.js';
import { foodWithBarcode, libraryView, recentsView, useIntents, useLive, useRead } from '../views.js';
import { useLogFlow, type OnLogged } from './flow.js';
import { BASIS_LABEL, MEAL_LABEL, amount, dayTitle, kcal, quantityLabel } from './format.js';
import { MealPicker } from './FoodSheet.js';
import { Icon, TitleBar, useToast } from './ui.js';

type OnlineResults =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'done'; readonly hits: readonly SearchHit[] }
  | { readonly kind: 'failed'; readonly reason: Extract<Online<never>, { ok: false }>['reason'] };

/** External results for the query, debounced, with every in-flight request cancelled by the next. */
function useOnlineSearch(query: string): OnlineResults {
  const [results, setResults] = useState<OnlineResults>({ kind: 'idle' });
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults({ kind: 'idle' });
      return;
    }
    setResults({ kind: 'loading' });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchFoods(q, controller.signal)
        .then((result) => setResults(result.ok ? { kind: 'done', hits: result.value } : { kind: 'failed', reason: result.reason }))
        .catch(() => undefined);
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  return results;
}

function FoodRow({
  food,
  quantity,
  onOpen,
  onQuickLog,
}: {
  readonly food: FoodSnapshot;
  readonly quantity: Quantity;
  readonly onOpen: () => void;
  readonly onQuickLog: () => void;
}) {
  return (
    <li class="food-row">
      <button type="button" class="food-row-main" onClick={onOpen}>
        <span class="food-name">{food.name}</span>
        <span class="food-detail">
          {[food.brand, quantityLabel(food, quantity), `${kcal(nutrientsFor(food, quantity).kcal)} kcal`].filter(Boolean).join(' · ')}
        </span>
      </button>
      <button type="button" class="add-button" aria-label={`Log ${food.name}`} onClick={onQuickLog}>
        <Icon name="plus" />
      </button>
    </li>
  );
}

const FAILED_TEXT: Readonly<Record<Extract<OnlineResults, { kind: 'failed' }>['reason'], string>> = {
  offline: 'Online results unavailable. The mini cannot be reached.',
  unavailable: 'Online results unavailable right now.',
  bad_response: 'Online results unavailable right now.',
};

export function Add({
  slot,
  today,
  onMeal,
  onLogged,
  onScan,
}: {
  readonly slot: Slot;
  readonly today: LocalDate;
  readonly onMeal: (meal: Meal) => void;
  readonly onLogged: OnLogged;
  readonly onScan: () => void;
}) {
  const recentList = useLive((r) => recentsView(r, { today, now: now() }), [today]);
  const library = useLive(libraryView, []);
  const [query, setQuery] = useState('');
  const [opening, setOpening] = useState<string | null>(null);
  const flow = useLogFlow(slot, onLogged);
  const intents = useIntents();
  const read = useRead();
  const toast = useToast();
  const online = useOnlineSearch(query);
  const trimmed = query.trim();

  const local = useMemo(
    () => (trimmed === '' ? [] : searchLocal({ query: trimmed, library: library ?? [], recents: recentList ?? [], limit: 25 })),
    [trimmed, library, recentList],
  );
  const known = useMemo(() => new Set((library ?? []).flatMap((f) => f.barcodes)), [library]);

  const quickLog = (food: FoodSnapshot, quantity: Quantity) =>
    void intents.logItems([{ food, quantity }], slot).then(({ undo }) => toast({ text: `Logged ${food.name} to ${MEAL_LABEL[slot.meal]}`, undo }));

  const openHit = async (hit: SearchHit, key: string) => {
    if (hit.ref.kind === 'gtin') {
      const { gtin } = hit.ref;
      const food = await read((r) => foodWithBarcode(r, gtin));
      if (food !== undefined && !food.archived) {
        flow.open({ kind: 'food', food: snapshotOf(food), quantity: defaultQuantity(food) });
        return;
      }
    }
    setOpening(key);
    const result = await lookupFood(hit.ref);
    setOpening(null);
    flow.open({ kind: 'confirm', candidate: result.ok && result.value.kind === 'found' ? result.value.candidate : hit.candidate });
  };

  const localRow = (hit: LocalHit) => {
    const quantity = hit.lastQuantity ?? defaultQuantity(hit.food);
    return (
      <FoodRow
        key={hit.key}
        food={hit.food}
        quantity={quantity}
        onOpen={() => flow.open({ kind: 'food', food: hit.food, quantity })}
        onQuickLog={() => quickLog(hit.food, quantity)}
      />
    );
  };

  const external = online.kind === 'done' ? online.hits.filter((hit) => hit.ref.kind !== 'gtin' || !known.has(hit.ref.gtin)) : [];

  return (
    <section class="screen add">
      <TitleBar title="Add food" />
      <p class="subtitle">
        {dayTitle(slot.date, today)}, {MEAL_LABEL[slot.meal]}
      </p>
      <MealPicker value={slot.meal} onChange={onMeal} />
      <div class="search">
        <input
          type="search"
          aria-label="Search foods"
          placeholder="Search foods"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </div>

      {trimmed === '' ? (
        <>
          <div class="actions-row">
            <button type="button" onClick={() => flow.open({ kind: 'quick-add' })}>
              Quick add
            </button>
            <button type="button" onClick={() => flow.open({ kind: 'editor', seed: { kind: 'new', barcodes: [] } })}>
              New food
            </button>
            <button type="button" onClick={onScan}>
              Scan
            </button>
          </div>
          <h2 class="section-title">Recent</h2>
          {recentList !== undefined && recentList.length === 0 ? (
            <p class="empty">Foods you log show up here for one-tap logging.</p>
          ) : (
            <ul class="list" aria-label="Recent foods">
              {(recentList ?? []).slice(0, 25).map((recent) => localRow({ key: recent.key, food: recent.food, lastQuantity: recent.lastQuantity }))}
            </ul>
          )}
        </>
      ) : (
        <>
          <h2 class="section-title">Your foods</h2>
          {local.length === 0 ? <p class="empty">No match in your foods.</p> : <ul class="list" aria-label="Your foods">{local.map(localRow)}</ul>}
          <h2 class="section-title">Online</h2>
          {online.kind === 'loading' && <p class="empty">Searching…</p>}
          {online.kind === 'failed' && <p class="empty">{FAILED_TEXT[online.reason]}</p>}
          {online.kind === 'done' && external.length === 0 && <p class="empty">No online results.</p>}
          {external.length > 0 && (
            <ul class="list" aria-label="Online results">
              {external.map((hit, i) => {
                const key = `${hit.ref.kind}:${hit.ref.kind === 'gtin' ? hit.ref.gtin : hit.ref.fdcId}:${i}`;
                const energy = hit.candidate.nutrients.kcal;
                return (
                  <li class="food-row" key={key}>
                    <button type="button" class="food-row-main" disabled={opening !== null} onClick={() => void openHit(hit, key)}>
                      <span class="food-name">{hit.candidate.name}</span>
                      <span class="food-detail">
                        {opening === key
                          ? 'Loading…'
                          : [hit.candidate.brand, energy === undefined ? 'kcal unknown' : `${amount(energy)} kcal per ${BASIS_LABEL[hit.candidate.unit]}`]
                              .filter(Boolean)
                              .join(' · ')}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {flow.sheet}
    </section>
  );
}
