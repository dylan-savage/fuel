import { randomUUID } from 'node:crypto';
import { LocalDate, Millis, SessionId, type ProgramId } from '../src/domain/ids.js';
import { LiftId, SlotId, performanceId, type Performance, type SetLog, type Target } from '../src/domain/lifts.js';
import { BlockId, DayKey, programId, type Block, type ChecklistBlock, type LiftsBlock, type Program, type Slot } from '../src/domain/program.js';
import type { Session } from '../src/domain/session.js';

export const day = (date: string): LocalDate => LocalDate.parse(date);
export const ms = (value: number): Millis => Millis.parse(value);
export const lift = (id: string): LiftId => LiftId.parse(id);
export const slotId = (id: string): SlotId => SlotId.parse(id);
export const blockId = (id: string): BlockId => BlockId.parse(id);
export const dayKey = (key: string): DayKey => DayKey.parse(key);
export const newSessionId = (): SessionId => SessionId.parse(randomUUID());

/** A fixed start, so a set's `at` reads as minutes into the session. */
export const T0 = 1_900_000_000_000;
export const minutes = (n: number): Millis => ms(T0 + n * 60_000);

const timed = (at: number | undefined) => (at === undefined ? {} : { at: minutes(at) });

export const lb = (amount: number, reps: number, at?: number): SetLog => ({ load: { kind: 'weight', amount, unit: 'lb' }, reps: { kind: 'total', reps }, ...timed(at) });
export const kg = (amount: number, reps: number, at?: number): SetLog => ({ load: { kind: 'weight', amount, unit: 'kg' }, reps: { kind: 'total', reps }, ...timed(at) });
export const bw = (reps: number, at?: number): SetLog => ({ load: { kind: 'bodyweight' }, reps: { kind: 'total', reps }, ...timed(at) });
export const band = (label: string, reps: number, at?: number): SetLog => ({ load: { kind: 'band', label }, reps: { kind: 'total', reps }, ...timed(at) });
export const sides = (amount: number, left: number, right: number, at?: number): SetLog => ({ load: { kind: 'weight', amount, unit: 'lb' }, reps: { kind: 'sides', left, right }, ...timed(at) });
export const warm = (set: SetLog): SetLog => ({ ...set, warmup: true });

export const target = (sets: number, min: number, max: number, extra: Partial<Target> = {}): Target => ({ sets, reps: { min, max }, ...extra });

export function slot(id: string, liftName: string, sets: number, extra: Partial<Slot> = {}): Slot {
  return { id: slotId(id), liftId: lift(liftName), label: liftName, target: target(sets, 8, 10), ...extra };
}

export function liftsBlock(id: string, slots: readonly Slot[], extra: Partial<LiftsBlock> = {}): LiftsBlock {
  return { kind: 'lifts', id: blockId(id), slots: [...slots], ...extra };
}

export function checklist(id: string, extra: Partial<ChecklistBlock> = {}): ChecklistBlock {
  return { kind: 'checklist', id: blockId(id), items: ['Arm circles', 'Hip openers'], ...extra };
}

export function program(effectiveFrom: string, days: readonly { readonly key: string; readonly blocks: readonly Block[] }[], extra: Partial<Program> = {}): Program {
  const date = day(effectiveFrom);
  const lifts = [...new Set(days.flatMap((d) => d.blocks).flatMap((b) => (b.kind === 'lifts' ? b.slots.flatMap((s) => [s.liftId, ...(s.swaps ?? []).map((o) => o.liftId)]) : [])))];
  return {
    id: programId(date),
    effectiveFrom: date,
    days: days.map((d) => ({ key: dayKey(d.key), label: `Day ${d.key}`, blocks: [...d.blocks] })),
    lifts: lifts.map((id) => ({ id, name: id, aliases: [] })),
    notes: [],
    standing: [],
    changes: [],
    publishedAt: ms(T0),
    ...extra,
  };
}

export function session(extra: Partial<Session> = {}): Session {
  return { id: newSessionId(), date: day('2030-03-04'), day: { key: dayKey('push'), label: 'Push' }, startedAt: minutes(0), ...extra };
}

export function performance(input: {
  readonly lift: string;
  readonly sets: readonly SetLog[];
  readonly session?: SessionId;
  readonly date?: string;
  readonly slot?: string;
  readonly target?: Target;
  readonly planned?: string;
  readonly label?: string;
  readonly note?: string;
}): Performance {
  const sessionId = input.session ?? newSessionId();
  const liftId = lift(input.lift);
  const slotOf = input.slot === undefined ? undefined : slotId(input.slot);
  return {
    id: performanceId(sessionId, slotOf, liftId),
    sessionId,
    date: day(input.date ?? '2030-03-04'),
    liftId,
    label: input.label ?? input.lift,
    sets: [...input.sets],
    ...(slotOf === undefined ? {} : { slotId: slotOf }),
    ...(input.planned === undefined ? {} : { plannedLiftId: lift(input.planned) }),
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(input.note === undefined ? {} : { note: input.note }),
  };
}

export const pinned = (date: string): ProgramId => programId(day(date));
