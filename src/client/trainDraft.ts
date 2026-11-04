/**
 * What is on the card but not yet stored: typed digits, a swap with no set under it yet, a tap on
 * the plan. One JSON value in localStorage, written on every change, because localStorage is
 * synchronous and a lock can freeze the page right after a keystroke. Never synced. Losing it costs
 * retyping one set, because every logged set is already in IndexedDB.
 *
 * A tab switch unmounts the screen, a reload restarts the app and a lock can kill the page. All
 * three come back through this one value, so there is one recovery.
 */
import { useCallback, useState } from 'preact/hooks';
import { z } from 'zod';
import { SessionId } from '../domain/ids.js';
import { LiftId, SlotId, Unit } from '../domain/lifts.js';
import { BlockId, type Step } from '../domain/program.js';
import { focusAfterSet, type LiftChoice, type SetEntry } from '../domain/session.js';
import { editable, parseNumber } from './screens/format.js';

const KEY = 'fuel:train:draft';

/** The card's fields as typed, so "92." survives until the next digit. */
export const SetForm = z.object({
  load: z.discriminatedUnion('kind', [z.object({ kind: z.literal('weight'), amount: z.string(), unit: Unit }), z.object({ kind: z.literal('bodyweight') }), z.object({ kind: z.literal('band'), label: z.string() })]),
  reps: z.discriminatedUnion('kind', [z.object({ kind: z.literal('total'), reps: z.string() }), z.object({ kind: z.literal('sides'), left: z.string(), right: z.string() })]),
  warmup: z.boolean(),
  note: z.string(),
});
export type SetForm = z.infer<typeof SetForm>;

const TrainDraft = z.object({
  sessionId: SessionId,
  focus: z.discriminatedUnion('kind', [z.object({ kind: z.literal('slot'), slotId: SlotId }), z.object({ kind: z.literal('block'), blockId: BlockId })]).optional(),
  /** Swaps chosen before their first set, by slot. */
  swaps: z.record(z.string(), z.object({ liftId: LiftId, label: z.string().min(1) })).optional(),
  /** Keyed by slot, lift and round, so typed digits cannot land on another set. */
  set: z.object({ slotId: SlotId, liftId: LiftId, round: z.number().int(), form: SetForm }).optional(),
});
export type TrainDraft = z.infer<typeof TrainDraft>;

const blankIfNull = (n: number | null) => (n === null ? '' : editable(n));

export function formOf(entry: SetEntry): SetForm {
  const { load, reps, warmup, note } = entry;
  return {
    load: load.kind === 'weight' ? { kind: 'weight', amount: blankIfNull(load.amount), unit: load.unit } : load.kind === 'band' ? { kind: 'band', label: load.label } : { kind: 'bodyweight' },
    reps: reps.kind === 'total' ? { kind: 'total', reps: blankIfNull(reps.reps) } : { kind: 'sides', left: blankIfNull(reps.left), right: blankIfNull(reps.right) },
    warmup,
    note,
  };
}

export function entryOf(form: SetForm): SetEntry {
  const { load, reps, warmup, note } = form;
  return {
    load: load.kind === 'weight' ? { kind: 'weight', amount: parseNumber(load.amount), unit: load.unit } : load,
    reps: reps.kind === 'total' ? { kind: 'total', reps: parseNumber(reps.reps) } : { kind: 'sides', left: parseNumber(reps.left), right: parseNumber(reps.right) },
    warmup,
    note,
  };
}

/** What he has typed for this very set, if anything. */
export function typedFor(draft: TrainDraft, step: Step, lift: LiftChoice): SetForm | undefined {
  const { set } = draft;
  return set !== undefined && set.slotId === step.slot.id && set.round === step.round && set.liftId === lift.liftId ? set.form : undefined;
}

/** What stays after a set: swaps on other slots, and a jump into an optional block. The set's lift is now on its performance. */
export function afterLog(draft: TrainDraft, step: Step): TrainDraft {
  const { [step.slot.id]: _logged, ...swaps } = draft.swaps ?? {};
  const focus = focusAfterSet(step);
  return { sessionId: draft.sessionId, ...(focus === undefined ? {} : { focus }), ...(Object.keys(swaps).length === 0 ? {} : { swaps }) };
}

export function withSwap(draft: TrainDraft, step: Step, lift: LiftChoice): TrainDraft {
  const { set: _typed, ...rest } = draft;
  return { ...rest, swaps: { ...draft.swaps, [step.slot.id]: { liftId: lift.liftId, label: lift.label } } };
}

/** Back to following the data, with nothing typed. */
export function withoutFocus(draft: TrainDraft): TrainDraft {
  const { focus: _focus, set: _typed, ...rest } = draft;
  return rest;
}

/** A draft for another session, or one that fails to parse, reads as empty. */
function readDraft(sessionId: SessionId): TrainDraft {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw === null ? null : TrainDraft.safeParse(JSON.parse(raw));
    if (parsed?.success === true && parsed.data.sessionId === sessionId) return parsed.data;
  } catch {
    // Storage off or the value unreadable: nothing typed survives, and every stored set still does.
  }
  return { sessionId };
}

export function useTrainDraft(sessionId: SessionId): readonly [TrainDraft, (next: TrainDraft) => void] {
  const [draft, setDraft] = useState(() => readDraft(sessionId));
  const save = useCallback((next: TrainDraft) => {
    setDraft(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Storage off or full: the card still works, and only a reload loses the digits.
    }
  }, []);
  return [draft, save];
}
