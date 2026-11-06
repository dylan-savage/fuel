/** What the lift pickers offer, and in what order. One pure function serves Swap and Add exercise, so the policy has one home. */
import { liftIdOf, type Lift, type LiftBook, type LiftId, type Muscle, type Performance } from './lifts.js';
import type { Slot } from './program.js';
import { loggedLifts } from './progress.js';
import type { LiftChoice } from './session.js';

/** How far back the pickers look for what he did on this day. */
export const PICK_WEEKS = 8;

/** What a picker chooses for. */
export type PickFor = { readonly kind: 'swap'; readonly slot: Slot; readonly current: LiftId } | { readonly kind: 'add'; readonly onDay: readonly LiftId[] };

export interface PickList {
  /** The plan's own choices and what he did here before, in that order, then lifts for the same muscles, most recently done first. Short. */
  readonly suggested: readonly LiftChoice[];
  /** Everything else, A–Z, never repeating a suggestion. */
  readonly others: readonly LiftChoice[];
  /** The search as a new lift, when it slugs and nothing offered is it. */
  readonly typed: LiftChoice | null;
}

/** How many suggestions fill up with alike lifts. The plan's own and his history are never cut, and alike lifts past this go to the rest. */
const SUGGESTED = 8;
const MAX_LABEL = 80;

/** The lifts a picker must not offer, because choosing one would change nothing. */
function leftOut(pickFor: PickFor): readonly LiftId[] {
  return pickFor.kind === 'swap' ? [pickFor.current] : pickFor.onDay;
}

/** The slot's planned lift and its listed swaps, with their plan labels. The one he is on is left out later, so the planned lift shows only once he has left it. */
function planOwn(pickFor: PickFor): readonly LiftChoice[] {
  if (pickFor.kind === 'add') return [];
  const { slot } = pickFor;
  return [{ liftId: slot.liftId, label: slot.label }, ...(slot.swaps ?? []).map(({ liftId, label }) => ({ liftId, label }))];
}

const lastTap = (p: Performance) => Math.max(...p.sets.map((set) => set.at ?? 0));

/** What he did here before, newest first: in this slot on a swap, and with no slot on an add. */
function hereBefore(pickFor: PickFor, dayHistory: readonly Performance[], book: LiftBook): readonly LiftChoice[] {
  const slotId = pickFor.kind === 'swap' ? pickFor.slot.id : undefined;
  return dayHistory
    .filter((p) => p.slotId === slotId)
    .toSorted((a, b) => b.date.localeCompare(a.date) || lastTap(b) - lastTap(a))
    .map((p) => ({ liftId: book.canonical(p.liftId), label: book.nameOf(p.liftId) ?? p.label }));
}

/** The muscles "alike" means: the slot lift's on a swap, and every lift's on the day on an add. */
function musclesFor(pickFor: PickFor, book: LiftBook): ReadonlySet<Muscle> {
  const ids = pickFor.kind === 'swap' ? [pickFor.slot.liftId] : pickFor.onDay;
  return new Set(ids.flatMap((id) => book.muscleOf(id) ?? []));
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
  const lastDone = new Map(logged.map((lift) => [lift.liftId, lift.lastDate]));
  const every: readonly LiftChoice[] = [...lifts.map((lift) => ({ liftId: lift.id, label: lift.name })), ...logged.filter((lift) => !book.has(lift.liftId)).map((lift) => ({ liftId: lift.liftId, label: lift.name }))];
  const byName = (a: LiftChoice, b: LiftChoice) => a.label.localeCompare(b.label);

  const offered = new Set(leftOut(pickFor).map((id) => book.canonical(id)));
  const fresh = (choice: LiftChoice) => {
    const id = book.canonical(choice.liftId);
    if (offered.has(id)) return false;
    offered.add(id);
    return true;
  };
  const first = [...planOwn(pickFor), ...hereBefore(pickFor, dayHistory, book)].filter(fresh);
  const muscles = musclesFor(pickFor, book);
  const isAlike = (choice: LiftChoice) => {
    const muscle = book.muscleOf(choice.liftId);
    return muscle !== undefined && muscles.has(muscle);
  };
  const alike = every
    .filter(isAlike)
    .toSorted((a, b) => (lastDone.get(b.liftId) ?? '').localeCompare(lastDone.get(a.liftId) ?? '') || byName(a, b))
    .filter(fresh);
  const room = Math.max(0, SUGGESTED - first.length);
  const suggested = [...first, ...alike.slice(0, room)];
  const others = [...alike.slice(room), ...every.filter(fresh)].toSorted(byName);

  const query = input.query.trim();
  const needle = query.toLowerCase();
  const slug = liftIdOf(query);
  const matches = (choice: LiftChoice) => query === '' || [choice.label, book.nameOf(choice.liftId) ?? ''].some((name) => name.toLowerCase().includes(needle)) || (slug !== null && book.members(choice.liftId).includes(slug));
  const typed = slug === null || offered.has(book.canonical(slug)) ? null : { liftId: slug, label: query.slice(0, MAX_LABEL) };
  return { suggested: suggested.filter(matches), others: others.filter(matches), typed };
}
