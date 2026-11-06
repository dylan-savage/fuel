/** What the lift pickers offer, and in what order. One pure function serves Add exercise, so the policy has one home. */
import { liftIdOf, type Lift, type LiftBook, type LiftId, type Performance } from './lifts.js';
import { loggedLifts } from './progress.js';
import type { LiftChoice } from './session.js';

/** How far back the pickers look for what he did on this day. */
export const PICK_WEEKS = 8;

/** What a picker chooses for. */
export type PickFor = { readonly kind: 'add'; readonly onDay: readonly LiftId[] };

export interface PickList {
  /** What he did here before, newest first. Short. */
  readonly suggested: readonly LiftChoice[];
  /** Everything else, A–Z, never repeating a suggestion. */
  readonly others: readonly LiftChoice[];
  /** The search as a new lift, when it slugs and nothing offered is it. */
  readonly typed: LiftChoice | null;
}

const MAX_LABEL = 80;

const lastTap = (p: Performance) => Math.max(...p.sets.map((set) => set.at ?? 0));

/** What he did here before, newest first: lifts he added to this day. */
function hereBefore(dayHistory: readonly Performance[], book: LiftBook): readonly LiftChoice[] {
  return dayHistory
    .filter((p) => p.slotId === undefined)
    .toSorted((a, b) => b.date.localeCompare(a.date) || lastTap(b) - lastTap(a))
    .map((p) => ({ liftId: book.canonical(p.liftId), label: book.nameOf(p.liftId) ?? p.label }));
}

/** The lifts a picker must not offer, because choosing one would change nothing. */
function leftOut(pickFor: PickFor): readonly LiftId[] {
  return pickFor.onDay;
}

/**
 * The choices, from the catalog and every name he has logged that the catalog has not placed,
 * once each under its canonical id. A search filters both lists by name or alias, and keeps the
 * order.
 */
export function pickList(input: {
  readonly pickFor: PickFor;
  readonly lifts: readonly Lift[];
  readonly book: LiftBook;
  /** Each lift's newest row, from newestOfEachLift. */
  readonly newest: readonly Performance[];
  /** This day's sessions in the PICK_WEEKS before the date. */
  readonly dayHistory: readonly Performance[];
  readonly query: string;
}): PickList {
  const { pickFor, lifts, book, newest, dayHistory } = input;
  const logged = loggedLifts(newest, book);
  const every: readonly LiftChoice[] = [...lifts.map((lift) => ({ liftId: lift.id, label: lift.name })), ...logged.filter((lift) => !book.has(lift.liftId)).map((lift) => ({ liftId: lift.liftId, label: lift.name }))];

  const offered = new Set(leftOut(pickFor).map((id) => book.canonical(id)));
  const fresh = (choice: LiftChoice) => {
    const id = book.canonical(choice.liftId);
    if (offered.has(id)) return false;
    offered.add(id);
    return true;
  };
  const suggested = hereBefore(dayHistory, book).filter(fresh);
  const others = every.filter(fresh).toSorted((a, b) => a.label.localeCompare(b.label));

  const query = input.query.trim();
  const needle = query.toLowerCase();
  const slug = liftIdOf(query);
  const matches = (choice: LiftChoice) => query === '' || [choice.label, book.nameOf(choice.liftId) ?? ''].some((name) => name.toLowerCase().includes(needle)) || (slug !== null && book.members(choice.liftId).includes(slug));
  const typed = slug === null || offered.has(book.canonical(slug)) ? null : { liftId: slug, label: query.slice(0, MAX_LABEL) };
  return { suggested: suggested.filter(matches), others: others.filter(matches), typed };
}
