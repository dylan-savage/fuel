import { z } from 'zod';
import { LocalDate, Millis, ProgramId, mondayOf } from './ids.js';
import { Lift, LiftId, SlotId, Target } from './lifts.js';

const KEY = /^[a-z0-9-]+$/;

export const DayKey = z.string().regex(KEY).max(24).brand<'DayKey'>();
export type DayKey = z.infer<typeof DayKey>;

export const BlockId = z.string().min(1).max(40).brand<'BlockId'>();
export type BlockId = z.infer<typeof BlockId>;

const cue = z.string().max(1000);

/** A lift a slot may be swapped to. Its cue replaces the slot's on the card. */
export const SwapOption = z.looseObject({ liftId: LiftId, label: z.string().min(1).max(80), cue: cue.optional() });
export type SwapOption = z.infer<typeof SwapOption>;

export const Slot = z.looseObject({
  id: SlotId,
  liftId: LiftId,
  /** The plan's name for it. A renamed slot or variation keeps its liftId under a new label. */
  label: z.string().min(1).max(80),
  target: Target,
  swaps: z.array(SwapOption).optional(),
  cue: cue.optional(),
  /** Labels a per-set note field. */
  setPrompt: z.string().max(80).optional(),
});
export type Slot = z.infer<typeof Slot>;

const blockFields = {
  id: BlockId,
  title: z.string().max(80).optional(),
  /** Text shown under the title. */
  note: z.string().max(1000).optional(),
  /** Off the suggested path: nextUp never walks into it, and leaving it undone is not a skip. */
  optional: z.literal(true).optional(),
  /** A Monday. The block exists in that week only, so it lapses with no write. */
  onlyWeek: LocalDate.optional(),
};

/** Straight sets, supersets and ab blocks are one kind, because they differ only in slot count. */
export const LiftsBlock = z.looseObject({
  kind: z.literal('lifts'),
  ...blockFields,
  slots: z.array(Slot).min(1),
  /** After each full round: after every set when straight, after the last slot when a superset. */
  restSeconds: z.number().int().nonnegative().max(900).optional(),
});
export type LiftsBlock = z.infer<typeof LiftsBlock>;

export const ChecklistBlock = z.looseObject({ kind: z.literal('checklist'), ...blockFields, items: z.array(z.string().min(1).max(200)).min(1) });
export type ChecklistBlock = z.infer<typeof ChecklistBlock>;

/** Opens the existing workout logger. */
export const CardioBlock = z.looseObject({ kind: z.literal('cardio'), ...blockFields });
export type CardioBlock = z.infer<typeof CardioBlock>;

export const Block = z.discriminatedUnion('kind', [LiftsBlock, ChecklistBlock, CardioBlock]);
export type Block = z.infer<typeof Block>;

export const Day = z.looseObject({
  /** Stable across versions. Sessions name it. */
  key: DayKey,
  label: z.string().min(1).max(40),
  /** 1 is Monday. Orders the list and picks the suggestion, and never binds. */
  weekday: z.number().int().min(1).max(7).optional(),
  minutes: z.number().int().positive().max(300).optional(),
  blocks: z.array(Block).min(1),
});
export type Day = z.infer<typeof Day>;

/** A callout at the top of the week, or on one day's preview when it names that day. */
export const ProgramNote = z.looseObject({ title: z.string().max(80).optional(), text: z.string().min(1).max(6000), onlyWeek: LocalDate.optional(), day: DayKey.optional() });
export type ProgramNote = z.infer<typeof ProgramNote>;

/** Rules, plans and sources that outlast any one week. `key` follows the text across versions. */
export const StandingText = z.looseObject({ key: z.string().regex(KEY).max(40), title: z.string().min(1).max(80), text: z.string().max(10_000) });
export type StandingText = z.infer<typeof StandingText>;

export const Report = z.looseObject({ title: z.string().max(80).optional(), text: z.string().min(1).max(20_000) });
export type Report = z.infer<typeof Report>;

const notBlank = /\S/;

/** Why a removal or a changed prescription was meant. `target` is the name programDiff gives it. */
export const ProgramChange = z.looseObject({ target: z.string().regex(notBlank).max(160), why: z.string().regex(notBlank).max(1000) });
export type ProgramChange = z.infer<typeof ProgramChange>;

export function programId(effectiveFrom: LocalDate): ProgramId {
  return ProgramId.parse(`p:${effectiveFrom}`);
}

const ProgramFields = z.looseObject({
  id: ProgramId,
  effectiveFrom: LocalDate,
  days: z.array(Day).min(1),
  /** The catalog. It only grows, so a slot can never fork a history through a typo. */
  lifts: z.array(Lift),
  /** Sessions a week he aims not to fall below. */
  weeklyMinimum: z.number().int().min(1).max(14).optional(),
  notes: z.array(ProgramNote),
  standing: z.array(StandingText),
  report: Report.optional(),
  changes: z.array(ProgramChange),
  publishedAt: Millis,
});

/**
 * In effect from effectiveFrom until the next version, following g:<effectiveFrom>. It freezes
 * when its date arrives and a session pins its id, so a session's plan cannot move under it.
 * Only the coach tool writes this kind, so no pending phone write can beat it.
 */
export const Program = ProgramFields.refine((p) => p.id === programId(p.effectiveFrom), 'a program id is p:<effectiveFrom>');
export type Program = z.infer<typeof Program>;

/** What Claude writes, which is parsed strictly. The tool stamps the id and the time. */
export const ProgramDraft = ProgramFields.omit({ id: true, publishedAt: true });
export type ProgramDraft = z.infer<typeof ProgramDraft>;

/** The latest version on or before a date. */
export function programOn(programs: readonly Program[], date: LocalDate): Program | undefined {
  let best: Program | undefined;
  for (const program of programs) {
    if (program.effectiveFrom <= date && (best === undefined || program.effectiveFrom > best.effectiveFrom)) best = program;
  }
  return best;
}

function liveIn(item: { readonly onlyWeek?: LocalDate | undefined }, monday: LocalDate): boolean {
  return item.onlyWeek === undefined || item.onlyWeek === monday;
}

/** A day as it will be done on one date. */
export interface PlannedDay {
  readonly key: DayKey;
  readonly label: string;
  readonly minutes: number | undefined;
  readonly blocks: readonly Block[];
}

/**
 * The one read of a plan: every screen and the coach call this, so one-week items have one
 * rule. Undefined when the day is not in the version, or only holds one-week blocks of other
 * weeks.
 */
export function plannedDay(program: Program, key: DayKey, date: LocalDate): PlannedDay | undefined {
  const day = program.days.find((d) => d.key === key);
  if (day === undefined) return undefined;
  const monday = mondayOf(date);
  const blocks = day.blocks.filter((block) => liveIn(block, monday));
  return blocks.length === 0 ? undefined : { key: day.key, label: day.label, minutes: day.minutes, blocks };
}

/** The notes at the top of that week. A note naming a day waits on that day's preview. */
export function notesFor(program: Program, date: LocalDate): readonly ProgramNote[] {
  const monday = mondayOf(date);
  return program.notes.filter((note) => note.day === undefined && liveIn(note, monday));
}

/** The notes on one day's preview that week. */
export function dayNotesFor(program: Program, key: DayKey, date: LocalDate): readonly ProgramNote[] {
  const monday = mondayOf(date);
  return program.notes.filter((note) => note.day === key && liveIn(note, monday));
}

/** One set's place in a block. */
export interface Step {
  readonly block: LiftsBlock;
  readonly slot: Slot;
  /** 1-based. Warm-ups never count as rounds. */
  readonly round: number;
  /** The last slot of its round, so the block's rest follows it. */
  readonly endsRound: boolean;
}

/** A block runs to its largest set count. */
export function roundsOf(block: LiftsBlock): number {
  return Math.max(...block.slots.map((slot) => slot.target.sets));
}

/**
 * A1, A2, rest, A1, A2, rest. Rounds run to the largest set count and a slot leaves once its
 * sets are used, so a 2-set slot in a 3-round superset needs no special case. Straight sets
 * are the one-slot case.
 */
export function stepsOf(block: LiftsBlock): readonly Step[] {
  return Array.from({ length: roundsOf(block) }, (_, i) => i + 1).flatMap((round) => {
    const inRound = block.slots.filter((slot) => slot.target.sets >= round);
    return inRound.map((slot, i) => ({ block, slot, round, endsRound: i === inRound.length - 1 }));
  });
}

/** One block as a day reads. */
export interface DayPart {
  readonly block: Block;
  /** Set on a lifts block of more than one slot. `letter` counts the supersets the day reads through. */
  readonly superset: { readonly letter: string; readonly rounds: number } | null;
}

/** A day in the order it reads, optional blocks last, since nextUp never walks into them. */
export function dayParts(day: PlannedDay): readonly DayPart[] {
  const ordered = day.blocks.toSorted((a, b) => Number(a.optional === true) - Number(b.optional === true));
  const supersets = ordered.filter((block) => block.kind === 'lifts' && block.slots.length > 1);
  return ordered.map((block) => {
    const at = supersets.indexOf(block);
    return { block, superset: block.kind === 'lifts' && at >= 0 ? { letter: String.fromCharCode(65 + at), rounds: roundsOf(block) } : null };
  });
}
