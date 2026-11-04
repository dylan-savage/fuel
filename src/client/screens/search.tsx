/** Food rows and online search, shared by the Add screen and the recipe ingredient picker. */
import { useEffect, useState } from 'preact/hooks';
import type { Food, FoodCandidate, FoodSnapshot, Quantity, SearchHit } from '../../domain/food.js';
import { inLibrary } from '../../domain/library.js';
import { lookupFood, searchFoods, type Online } from '../api.js';
import { foodWithBarcode, useRead } from '../views.js';
import { BASIS_LABEL, amount, brandOf, foodRowParts } from './format.js';
import { Icon, Row } from './ui.js';

/** A food or recipe in the amount a tap would use. The plus logs it at once, where offered. */
export function FoodRow({
  food,
  quantity,
  onOpen,
  onQuickLog,
}: {
  readonly food: FoodSnapshot;
  readonly quantity: Quantity;
  readonly onOpen: () => void;
  readonly onQuickLog?: () => void;
}) {
  const parts = foodRowParts(food, quantity);
  return (
    <li class="split-row">
      <Row {...parts} detail={food.origin.kind === 'recipe' ? `Recipe · ${parts.detail}` : parts.detail} onClick={onOpen} />
      {onQuickLog && (
        <button type="button" class="icon-button" aria-label={`Log ${food.name}`} onClick={onQuickLog}>
          <Icon name="plus" />
        </button>
      )}
    </li>
  );
}

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

const FAILED_TEXT: Readonly<Record<Extract<OnlineResults, { kind: 'failed' }>['reason'], string>> = {
  offline: 'Cannot reach the mini',
  unavailable: 'Unavailable right now',
  bad_response: 'Unavailable right now',
};

/** What an online hit opens: the library food for a barcode already imported, else a candidate to confirm. */
export type Opened = { readonly kind: 'food'; readonly food: Food } | { readonly kind: 'candidate'; readonly candidate: FoodCandidate };

const hitKey = (hit: SearchHit, i: number) => `${hit.ref.kind}:${hit.ref.kind === 'gtin' ? hit.ref.gtin : hit.ref.fdcId}:${i}`;

/**
 * The "Online" section for a query: results from the mini, minus foods already in the
 * library (they show above, with the amount last logged). A tap resolves the hit, looking it up for the servings search leaves out.
 */
export function OnlineSection({
  query,
  known,
  onOpen,
}: {
  readonly query: string;
  readonly known: ReadonlySet<string>;
  readonly onOpen: (opened: Opened) => void;
}) {
  const online = useOnlineSearch(query);
  const read = useRead();
  const [opening, setOpening] = useState<string | null>(null);
  const external = online.kind === 'done' ? online.hits.filter((hit) => !inLibrary(hit, known)) : [];

  const open = async (hit: SearchHit, key: string) => {
    if (hit.ref.kind === 'gtin') {
      const { gtin } = hit.ref;
      const food = await read((r) => foodWithBarcode(r, gtin));
      if (food !== undefined && !food.archived) {
        onOpen({ kind: 'food', food });
        return;
      }
    }
    setOpening(key);
    const result = await lookupFood(hit.ref);
    setOpening(null);
    onOpen({ kind: 'candidate', candidate: result.ok && result.value.kind === 'found' ? result.value.candidate : hit.candidate });
  };

  return (
    <>
      <h2 class="section-heading">Online</h2>
      {online.kind === 'loading' && <p class="empty">Searching…</p>}
      {online.kind === 'failed' && <p class="empty">{FAILED_TEXT[online.reason]}</p>}
      {online.kind === 'done' && external.length === 0 && <p class="empty">No results</p>}
      {external.length > 0 && (
        <ul class="list foods" aria-label="Online results">
          {external.map((hit, i) => {
            const key = hitKey(hit, i);
            const energy = hit.candidate.nutrients.kcal;
            return (
              <li key={key}>
                <Row
                  name={hit.candidate.name}
                  detail={opening === key ? 'Loading…' : [brandOf(hit.candidate), `per ${BASIS_LABEL[hit.candidate.unit]}`].filter(Boolean).join(' · ')}
                  end={energy === undefined ? '–' : amount(energy)}
                  disabled={opening !== null}
                  onClick={() => void open(hit, key)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
