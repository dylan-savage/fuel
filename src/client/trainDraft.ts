/**
 * What is on an exercise but not yet stored: typed digits, and a swap with no set under it yet.
 * One JSON value in localStorage, written on every change, because localStorage is synchronous and
 * a lock can freeze the page right after a keystroke. Never synced. Losing it costs retyping one
 * set, because every logged set is already in IndexedDB.
 *
 * A tab switch unmounts the screen, a reload restarts the app and a lock can kill the page. All
 * three come back through this one value, so there is one recovery.
 */
import { useCallback, useState } from 'preact/hooks';
import { z } from 'zod';
import { LocalDate } from '../domain/ids.js';
import { LiftId, Unit, type SlotId } from '../domain/lifts.js';
import { DayKey } from '../domain/program.js';
import type { DayRef, Exercise, LiftChoice, SetEntry } from '../domain/session.js';
import { editable, parseNumber } from './screens/format.js';

const KEY = 'fuel:train:draft';

/** The set's fields as typed, so "92." survives until the next digit. */
export const SetForm = z.object({
  load: z.discriminatedUnion('kind', [z.object({ kind: z.literal('weight'), amount: z.string(), unit: Unit }), z.object({ kind: z.literal('bodyweight') }), z.object({ kind: z.literal('band'), label: z.string() })]),
  reps: z.discriminatedUnion('kind', [z.object({ kind: z.literal('total'), reps: z.string() }), z.object({ kind: z.literal('sides'), left: z.string(), right: z.string() })]),
  warmup: z.boolean(),
  note: z.string(),
});
export type SetForm = z.infer<typeof SetForm>;

/** For one day on one date, with each exercise keeping its own, since he moves between them freely. */
const TrainDraft = z.object({
  key: DayKey,
  date: LocalDate,
  /** Swaps chosen before their first set, by slot. */
  swaps: z.record(z.string(), z.object({ liftId: LiftId, label: z.string().min(1) })),
  /** By exercise, each naming its lift and set, so typed digits cannot land on another set. */
  typed: z.record(z.string(), z.object({ liftId: LiftId, set: z.number().int(), form: SetForm })),
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

/** Where an exercise's typed digits live. The prefixes keep a slot id and a lift id from ever meeting. */
const slotKey = (slotId: SlotId) => `s:${slotId}`;
const typedKey = ({ slot, lift }: Exercise) => (slot === null ? `a:${lift.liftId}` : slotKey(slot.id));

/** What he has typed for this very set, if anything. */
export function typedFor(draft: TrainDraft, exercise: Exercise, set: number): SetForm | undefined {
  const typed = draft.typed[typedKey(exercise)];
  return typed?.liftId === exercise.lift.liftId && typed.set === set ? typed.form : undefined;
}

export function withTyped(draft: TrainDraft, exercise: Exercise, set: number, form: SetForm): TrainDraft {
  return { ...draft, typed: { ...draft.typed, [typedKey(exercise)]: { liftId: exercise.lift.liftId, set, form } } };
}

/** The set's lift is now on its performance, so the exercise's typed digits go, and a planned one's pre-set swap. */
export function afterLog(draft: TrainDraft, exercise: Exercise): TrainDraft {
  const { [typedKey(exercise)]: _typed, ...typed } = draft.typed;
  if (exercise.slot === null) return { ...draft, typed };
  const { [exercise.slot.id]: _swap, ...swaps } = draft.swaps;
  return { ...draft, swaps, typed };
}

export function withSwap(draft: TrainDraft, slotId: SlotId, lift: LiftChoice): TrainDraft {
  const { [slotKey(slotId)]: _typed, ...typed } = draft.typed;
  return { ...draft, swaps: { ...draft.swaps, [slotId]: { liftId: lift.liftId, label: lift.label } }, typed };
}

/** A draft for another day or date, or one that fails to parse, reads as empty. */
function readDraft({ key, date }: DayRef): TrainDraft {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw === null ? null : TrainDraft.safeParse(JSON.parse(raw));
    if (parsed?.success === true && parsed.data.key === key && parsed.data.date === date) return parsed.data;
  } catch {
    // Storage off or the value unreadable: nothing typed survives, and every stored set still does.
  }
  return { key, date, swaps: {}, typed: {} };
}

export function useTrainDraft(day: DayRef): readonly [TrainDraft, (next: TrainDraft) => void] {
  const [draft, setDraft] = useState(() => readDraft(day));
  const save = useCallback((next: TrainDraft) => {
    setDraft(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Storage off or full: the screen still works, and only a reload loses the digits.
    }
  }, []);
  return [draft, save];
}
