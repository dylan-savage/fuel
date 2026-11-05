import { z } from 'zod';
import type { WeighIn } from './body.js';
import type { Workout } from './burn.js';
import { summarizeDay, type Entry } from './diary.js';
import { addDays, isMonday, mondayOf, type LocalDate, type Millis, type ProgramId, type SessionId } from './ids.js';
import { liftBook, type Lift, type LiftId, type Performance, type Target } from './lifts.js';
import { Program, ProgramDraft, plannedDay, programId, programOn, type Block, type Day, type ProgramNote, type Report, type Slot, type StandingText } from './program.js';
import { addWeightNext, skipsOf, sessionsDone, swapsOf, totalsOf, typedLine, workingSets, type Skip, type Swap } from './progress.js';
import { finishOf, sessionPhase, sessionWorkoutDraft, type Session, type SessionPhase, type TrainingNote } from './session.js';
import { isRecord, unknownFields } from './strict.js';

/**
 * Whether a change needs a reason in `changes`. Anything that can lose something does, so a
 * mistake is visible outside the model that made it. The phone renders every kind.
 */
const NEEDS_REASON = {
  'day-removed': true,
  'block-removed': true,
  'slot-removed': true,
  'cue-removed': true,
  'block-note-removed': true,
  'swaps-removed': true,
  'set-note-removed': true,
  'note-removed': true,
  'standing-removed': true,
  'prescription-changed': true,
  // It lapses later with no diff to name it, so setting it is the removal.
  'one-week': true,
  'day-added': false,
  'day-renamed': false,
  'day-weekday-changed': false,
  'day-minutes-changed': false,
  'block-added': false,
  'block-renamed': false,
  'block-note-added': false,
  'block-note-edited': false,
  'block-optional-changed': false,
  'block-rest-changed': false,
  'checklist-edited': false,
  'every-week': false,
  'slot-added': false,
  'slot-renamed': false,
  'slot-moved': false,
  'side-changed': false,
  'cue-added': false,
  'cue-edited': false,
  'swaps-added': false,
  'swaps-edited': false,
  'set-note-added': false,
  'set-note-edited': false,
  'note-added': false,
  'note-edited': false,
  'standing-added': false,
  'standing-edited': false,
  'standing-renamed': false,
  'minimum-changed': false,
  'lift-renamed': false,
  'lift-aliases-changed': false,
  'lift-key-changed': false,
} as const satisfies Readonly<Record<string, boolean>>;
export type DiffKind = keyof typeof NEEDS_REASON;

/** One difference between two versions, as plain data the tool prints and the phone renders. */
export interface DiffItem {
  readonly kind: DiffKind;
  /** The name to use in `changes`, such as slot:push/a1. */
  readonly target: string;
  readonly label: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly needsReason: boolean;
  /** The reason `changes` gives for this target. */
  readonly why: string | null;
}

type Change = Omit<DiffItem, 'needsReason' | 'why'>;
type At = Pick<Change, 'target' | 'label'>;

const blank = (text: string | undefined) => text === undefined || text.trim() === '';

function textChange(kinds: { readonly added: DiffKind; readonly removed: DiffKind; readonly edited: DiffKind }, at: At, was: string | undefined, now: string | undefined): readonly Change[] {
  const before = blank(was) ? null : (was ?? null);
  const after = blank(now) ? null : (now ?? null);
  if (before === after) return [];
  const kind = before === null ? kinds.added : after === null ? kinds.removed : kinds.edited;
  return [{ kind, ...at, before, after }];
}

const CUE_KINDS = { added: 'cue-added', removed: 'cue-removed', edited: 'cue-edited' } as const;
const STANDING_KINDS = { added: 'standing-added', removed: 'standing-removed', edited: 'standing-edited' } as const;
const BLOCK_NOTE_KINDS = { added: 'block-note-added', removed: 'block-note-removed', edited: 'block-note-edited' } as const;
const SWAPS_KINDS = { added: 'swaps-added', removed: 'swaps-removed', edited: 'swaps-edited' } as const;
const SET_NOTE_KINDS = { added: 'set-note-added', removed: 'set-note-removed', edited: 'set-note-edited' } as const;
const NOTE_KINDS = { added: 'note-added', removed: 'note-removed', edited: 'note-edited' } as const;

/** A setting has one kind however it moves, because taking it away loses nothing he wrote. */
function valueChange(kind: DiffKind, at: At, was: string | null, now: string | null): readonly Change[] {
  return was === now ? [] : [{ kind, ...at, before: was, after: now }];
}

function weekChange(at: At, was: LocalDate | undefined, now: LocalDate | undefined): readonly Change[] {
  return was === now ? [] : [{ kind: now === undefined ? 'every-week' : 'one-week', ...at, before: was ?? null, after: now ?? null }];
}

/** One-week items gone by this Monday had already lapsed by themselves. */
const liveFrom = (monday: LocalDate) => (item: { readonly onlyWeek?: LocalDate | undefined }) => item.onlyWeek === undefined || item.onlyWeek >= monday;

function prescription(slot: Slot): string {
  const { sets, reps, perSide, load } = slot.target;
  const range = reps.min === reps.max ? `${reps.max}` : `${reps.min}-${reps.max}`;
  return [slot.liftId, `${sets} x ${range}`, ...(perSide === undefined ? [] : ['per side']), ...(load === undefined || load === 'weight' ? [] : [load])].join(' ');
}

const swapList = (slot: Slot) => (slot.swaps ?? []).map((swap) => `${swap.label} (${swap.liftId})`).join(', ');

const SIDE_WORDS: Readonly<Record<NonNullable<Target['perSide']>, string>> = { 'left-first': 'left first', 'right-first': 'right first', either: 'either side first' };

function slotChanges(day: Day, was: Slot, now: Slot): readonly Change[] {
  const path = `${day.key}/${was.id}`;
  const label = `${day.label} / ${was.label}`;
  const changes: Change[] = [];
  if (prescription(was) !== prescription(now)) changes.push({ kind: 'prescription-changed', target: `prescription:${path}`, label, before: prescription(was), after: prescription(now) });
  if (was.label !== now.label) changes.push({ kind: 'slot-renamed', target: `slot:${path}`, label, before: was.label, after: now.label });
  // Going per side or back is already a changed prescription.
  if (was.target.perSide !== undefined && now.target.perSide !== undefined && was.target.perSide !== now.target.perSide) changes.push({ kind: 'side-changed', target: `side:${path}`, label, before: SIDE_WORDS[was.target.perSide], after: SIDE_WORDS[now.target.perSide] });
  changes.push(...textChange(CUE_KINDS, { target: `cue:${path}`, label }, was.cue, now.cue));
  changes.push(...textChange(SET_NOTE_KINDS, { target: `set-note:${path}`, label }, was.setPrompt, now.setPrompt));
  changes.push(...textChange(SWAPS_KINDS, { target: `swaps:${path}`, label }, swapList(was), swapList(now)));
  const swapIds = new Set([...(was.swaps ?? []), ...(now.swaps ?? [])].map((swap) => swap.liftId));
  for (const liftId of swapIds) {
    const cueOf = (slot: Slot) => slot.swaps?.find((swap) => swap.liftId === liftId)?.cue;
    changes.push(...textChange(CUE_KINDS, { target: `cue:${path}/${liftId}`, label: `${label} / ${liftId}` }, cueOf(was), cueOf(now)));
  }
  return changes;
}

/** What a day holds at a date. A slot is known by its id within the day, so moving it between blocks does not read as removing it. */
function dayContents(day: Day, monday: LocalDate) {
  const blocks = day.blocks.filter(liveFrom(monday));
  const slots = new Map(blocks.flatMap((block) => (block.kind === 'lifts' ? block.slots.map((slot) => [slot.id, { slot, block }] as const) : [])));
  return { blocks: new Map(blocks.map((block) => [block.id, block])), slots };
}

const blockName = (block: Block) => block.title ?? block.id;
const blockLabel = (day: Day, block: Block) => `${day.label} / ${blockName(block)}`;

function blockChanges(day: Day, was: Block, now: Block): readonly Change[] {
  const at = (name: string): At => ({ target: `${name}:${day.key}/${was.id}`, label: blockLabel(day, was) });
  const need = (block: Block) => (block.optional === true ? 'optional' : 'required');
  const rest = (block: Block) => (block.kind === 'lifts' && block.restSeconds !== undefined ? `${block.restSeconds}s` : null);
  const moves = (block: Block) => (block.kind === 'checklist' ? block.items.join(', ') : null);
  return [
    ...valueChange('block-renamed', at('block'), blockName(was), blockName(now)),
    ...textChange(BLOCK_NOTE_KINDS, at('block-note'), was.note, now.note),
    ...valueChange('block-optional-changed', at('optional'), need(was), need(now)),
    ...weekChange(at('only-week'), was.onlyWeek, now.onlyWeek),
    ...valueChange('block-rest-changed', at('rest'), rest(was), rest(now)),
    ...valueChange('checklist-edited', at('moves'), moves(was), moves(now)),
  ];
}

const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function daySettingChanges(was: Day, now: Day): readonly Change[] {
  const at = (name: string): At => ({ target: `${name}:${was.key}`, label: now.label });
  const weekday = (day: Day) => (day.weekday === undefined ? null : (WEEKDAY_NAMES[day.weekday - 1] ?? null));
  const length = (day: Day) => (day.minutes === undefined ? null : `${day.minutes} min`);
  return [
    ...valueChange('day-renamed', { target: `day:${was.key}`, label: was.label }, was.label, now.label),
    ...valueChange('day-weekday-changed', at('weekday'), weekday(was), weekday(now)),
    ...valueChange('day-minutes-changed', at('minutes'), length(was), length(now)),
  ];
}

/**
 * A removed day or block already names what was inside it, so one reason covers its slots. A block
 * that changes kind under one id holds nothing the old one did, so it reads as one gone and one new.
 */
function dayChanges(wasDay: Day, nowDay: Day, monday: LocalDate): readonly Change[] {
  const was = dayContents(wasDay, monday);
  const now = dayContents(nowDay, monday);
  const changes: Change[] = [...daySettingChanges(wasDay, nowDay)];
  for (const [id, block] of was.blocks) {
    const next = now.blocks.get(id);
    if (next?.kind === block.kind) changes.push(...blockChanges(nowDay, block, next));
    else changes.push({ kind: 'block-removed', target: `block:${wasDay.key}/${id}`, label: blockLabel(wasDay, block), before: blockName(block), after: null });
  }
  for (const [id, block] of now.blocks) {
    if (was.blocks.get(id)?.kind !== block.kind) changes.push({ kind: 'block-added', target: `block:${nowDay.key}/${id}`, label: blockLabel(nowDay, block), before: null, after: blockName(block) });
  }
  for (const [id, { slot, block }] of was.slots) {
    const next = now.slots.get(id);
    if (next !== undefined) {
      if (next.block.id !== block.id) changes.push({ kind: 'slot-moved', target: `slot:${nowDay.key}/${id}`, label: `${nowDay.label} / ${slot.label}`, before: blockName(block), after: blockName(next.block) });
      changes.push(...slotChanges(nowDay, slot, next.slot));
    } else if (now.blocks.get(block.id)?.kind === block.kind) changes.push({ kind: 'slot-removed', target: `slot:${wasDay.key}/${id}`, label: `${wasDay.label} / ${slot.label}`, before: prescription(slot), after: null });
  }
  for (const [id, { slot, block }] of now.slots) {
    if (!was.slots.has(id) && was.blocks.get(block.id)?.kind === block.kind) changes.push({ kind: 'slot-added', target: `slot:${nowDay.key}/${id}`, label: `${nowDay.label} / ${slot.label}`, before: null, after: prescription(slot) });
  }
  return changes;
}

function standingChanges(was: readonly StandingText[], now: readonly StandingText[]): readonly Change[] {
  const keys = new Set([...was, ...now].map((text) => text.key));
  return [...keys].flatMap((key) => {
    const before = was.find((text) => text.key === key);
    const after = now.find((text) => text.key === key);
    const target = `standing:${key}`;
    return [...textChange(STANDING_KINDS, { target, label: after?.title ?? before?.title ?? key }, before?.text, after?.text), ...(before === undefined || after === undefined ? [] : valueChange('standing-renamed', { target, label: before.title }, before.title, after.title))];
  });
}

const noteWords = ({ title, text }: ProgramNote) => (title === undefined ? text : `${title}: ${text}`);

/** A note has no id. Unchanged words match, and what is left pairs up in order as edits, so only a shorter list reads as a loss. */
function notePairs(was: readonly ProgramNote[], now: readonly ProgramNote[]): readonly (readonly [ProgramNote | undefined, ProgramNote | undefined])[] {
  const has = (notes: readonly ProgramNote[], note: ProgramNote) => notes.find((other) => noteWords(other) === noteWords(note));
  const gone = was.filter((note) => has(now, note) === undefined);
  const fresh = now.filter((note) => has(was, note) === undefined);
  return [...was.map((note) => [note, has(now, note)] as const).filter(([, match]) => match !== undefined), ...Array.from({ length: Math.max(gone.length, fresh.length) }, (_, i) => [gone[i], fresh[i]] as const)];
}

/** The label is where the note sits, never its words, because a day's note or a later week's must not show early. */
function noteChanges(before: Program, after: ProgramDraft, monday: LocalDate): readonly Change[] {
  const scopeOf = (note: ProgramNote): string => note.day ?? 'week';
  const inScope = (notes: readonly ProgramNote[], scope: string) => notes.filter(liveFrom(monday)).filter((note) => scopeOf(note) === scope);
  const days = [...after.days, ...before.days];
  return [...new Set([...before.notes, ...after.notes].map(scopeOf))].flatMap((scope) => {
    const label = scope === 'week' ? 'the week' : (days.find((day) => day.key === scope)?.label ?? scope);
    return notePairs(inScope(before.notes, scope), inScope(after.notes, scope)).flatMap(([was, now], i): readonly Change[] => {
      const name = `${scope}/${i + 1}`;
      const words = (note: ProgramNote | undefined) => (note === undefined ? undefined : noteWords(note));
      return [...textChange(NOTE_KINDS, { target: `note:${name}`, label }, words(was), words(now)), ...(was === undefined || now === undefined ? [] : weekChange({ target: `only-week:note:${name}`, label: `A note on ${label}` }, was.onlyWeek, now.onlyWeek))];
    });
  });
}

/** A lift can only leave as an alias of another, or a publish refuses it, so the lift taking it in names the change. A new lift shows through the slot naming it, and here only when it joins histories or the board. */
function liftChanges(was: readonly Lift[], now: readonly Lift[]): readonly Change[] {
  const otherNames = (lift: Lift | undefined) => lift?.aliases.toSorted().join(', ') || null;
  const keyLift = (lift: Lift | undefined) => (lift?.key === true ? 'key lift' : null);
  return now.flatMap((lift): readonly Change[] => {
    const at = { target: `lift:${lift.id}`, label: lift.name };
    const before = was.find((other) => other.id === lift.id);
    return [...(before === undefined ? [] : valueChange('lift-renamed', { ...at, label: before.name }, before.name, lift.name)), ...valueChange('lift-aliases-changed', at, otherNames(before), otherNames(lift)), ...valueChange('lift-key-changed', at, keyLift(before), keyLift(lift))];
  });
}

/**
 * What a version changes from the one before it. Blocks and notes that lapsed before the new
 * version's week are not losses, because they had already gone by themselves.
 */
export function programDiff(before: Program | null, after: ProgramDraft): readonly DiffItem[] {
  if (before === null) return [];
  const monday = mondayOf(after.effectiveFrom);
  const liveDays = (days: readonly Day[]) => days.filter((day) => dayContents(day, monday).blocks.size > 0);
  const was = liveDays(before.days);
  const now = liveDays(after.days);
  const changes: Change[] = [
    ...was.flatMap((wasDay): readonly Change[] => {
      const nowDay = now.find((day) => day.key === wasDay.key);
      return nowDay === undefined ? [{ kind: 'day-removed', target: `day:${wasDay.key}`, label: wasDay.label, before: wasDay.label, after: null }] : dayChanges(wasDay, nowDay, monday);
    }),
    ...now.filter((day) => !was.some((other) => other.key === day.key)).map((day): Change => ({ kind: 'day-added', target: `day:${day.key}`, label: day.label, before: null, after: day.label })),
    ...standingChanges(before.standing, after.standing),
    ...noteChanges(before, after, monday),
    ...valueChange('minimum-changed', { target: 'weekly-minimum', label: 'Weekly minimum' }, before.weeklyMinimum?.toString() ?? null, after.weeklyMinimum?.toString() ?? null),
    ...liftChanges(before.lifts, after.lifts),
  ];
  return changes.map((change) => ({
    ...change,
    needsReason: NEEDS_REASON[change.kind],
    why: after.changes.find((c) => c.target === change.target)?.why ?? null,
  }));
}

/** The coach's week on the phone, derived from which versions took effect in it, never stored. */
export type CoachWeek =
  | { readonly kind: 'quiet' }
  | {
      readonly kind: 'checked-in';
      readonly at: Millis;
      readonly report: Report | null;
      /** Every version of the week against the one before it, each with its own reasons. Nothing for a first version. */
      readonly changes: readonly DiffItem[];
    };

/**
 * `thisWeek` holds the versions that took effect this week so far, oldest first, and `before` the
 * one they followed. A draft starts with no report, so a mid-week fix would otherwise blank the
 * report Monday's version brought.
 */
export function coachWeek(before: Program | null, thisWeek: readonly Program[]): CoachWeek {
  const latest = thisWeek.at(-1);
  if (latest === undefined) return { kind: 'quiet' };
  const reporting = thisWeek.findLast((version) => version.report !== undefined) ?? latest;
  return {
    kind: 'checked-in',
    at: reporting.publishedAt,
    report: reporting.report ?? null,
    changes: thisWeek.flatMap((version, i) => programDiff(thisWeek[i - 1] ?? before, version)),
  };
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => (isRecord(inner) ? Object.fromEntries(Object.entries(inner).toSorted(([a], [b]) => a.localeCompare(b))) : inner));
}

/** Same plan, whatever the stamp and key order, so a repeat publish answers unchanged. */
export function sameContent(a: ProgramDraft, b: ProgramDraft): boolean {
  const content = ({ id: _id, publishedAt: _publishedAt, ...rest }: ProgramDraft) => canonical(rest);
  return content(a) === content(b);
}

export type ProblemCode = 'shape' | 'unknown-field' | 'frozen' | 'back-dated' | 'duplicate-id' | 'unknown-lift' | 'unknown-day' | 'alias-conflict' | 'catalog-drop' | 'bad-only-week' | 'unexplained';

export interface Problem {
  readonly code: ProblemCode;
  readonly path: string;
  readonly message: string;
}

/** Strict, so a misspelled field fails instead of vanishing, and every problem comes back at once. */
export function parseProgramDraft(raw: unknown): { readonly ok: true; readonly draft: ProgramDraft } | { readonly ok: false; readonly problems: readonly Problem[] } {
  const parsed = ProgramDraft.safeParse(raw);
  const problems: readonly Problem[] = [
    ...unknownFields(ProgramDraft, raw).map((path): Problem => ({ code: 'unknown-field', path, message: 'no such field' })),
    ...(parsed.error?.issues ?? []).map((issue): Problem => ({ code: 'shape', path: z.core.toDotPath(issue.path), message: issue.message })),
  ];
  return parsed.success && problems.length === 0 ? { ok: true, draft: parsed.data } : { ok: false, problems };
}

function duplicateProblems(ids: readonly string[], path: string, what: string): readonly Problem[] {
  return ids.flatMap((id, i) => (ids.indexOf(id) === i ? [] : [{ code: 'duplicate-id', path: `${path}[${i}]`, message: `${what} ${id} appears twice` }]));
}

function idProblems(draft: ProgramDraft): readonly Problem[] {
  return [
    ...duplicateProblems(draft.days.map((day) => day.key), 'days', 'day'),
    ...duplicateProblems(draft.lifts.map((lift) => lift.id), 'lifts', 'lift'),
    ...duplicateProblems(draft.standing.map((text) => text.key), 'standing', 'standing text'),
    ...draft.days.flatMap((day, d) => [
      ...duplicateProblems(day.blocks.map((block) => block.id), `days[${d}].blocks`, 'block'),
      // Slots share one id space per day, because a performance names its slot within a session.
      ...duplicateProblems(day.blocks.flatMap((block) => (block.kind === 'lifts' ? block.slots.map((slot) => slot.id) : [])), `days[${d}].slots`, 'slot'),
    ]),
  ];
}

function liftProblems(draft: ProgramDraft): readonly Problem[] {
  const book = liftBook(draft.lifts);
  return draft.days.flatMap((day, d) =>
    day.blocks.flatMap((block, b) => {
      if (block.kind !== 'lifts') return [];
      return block.slots.flatMap((slot, s) => {
        const path = `days[${d}].blocks[${b}].slots[${s}]`;
        const named = [
          { id: slot.liftId, at: `${path}.liftId` },
          ...(slot.swaps ?? []).map((swap, i) => ({ id: swap.liftId, at: `${path}.swaps[${i}].liftId` })),
        ];
        return named.filter(({ id }) => !book.has(id)).map(({ id, at }): Problem => ({ code: 'unknown-lift', path: at, message: `${id} is not in the lift catalog` }));
      });
    }),
  );
}

/** A note naming a day the version lacks would never show anywhere, which is a quiet drop. */
function noteDayProblems(draft: ProgramDraft): readonly Problem[] {
  const days = new Set(draft.days.map((day) => day.key));
  return draft.notes.flatMap((note, n) => (note.day === undefined || days.has(note.day) ? [] : [{ code: 'unknown-day', path: `notes[${n}].day`, message: `${note.day} is not a day in this version` }]));
}

function catalogIds(lifts: ProgramDraft['lifts']): readonly LiftId[] {
  return lifts.flatMap((lift) => [lift.id, ...lift.aliases]);
}

function aliasProblems(draft: ProgramDraft, before: Program | null): readonly Problem[] {
  const liftIds = new Set(draft.lifts.map((lift) => lift.id));
  const claimed = new Set<LiftId>();
  const conflicts = draft.lifts.flatMap((lift, l) =>
    lift.aliases.flatMap((alias, a): readonly Problem[] => {
      const path = `lifts[${l}].aliases[${a}]`;
      if (liftIds.has(alias)) return [{ code: 'alias-conflict', path, message: `${alias} is also a lift, so ${lift.id} would chain or claim itself` }];
      if (claimed.has(alias)) return [{ code: 'alias-conflict', path, message: `${alias} is claimed twice` }];
      claimed.add(alias);
      return [];
    }),
  );
  const known = new Set(catalogIds(draft.lifts));
  const dropped = catalogIds(before?.lifts ?? [])
    .filter((id) => !known.has(id))
    .map((id): Problem => ({ code: 'catalog-drop', path: 'lifts', message: `${id} was in the catalog before, and the catalog only grows` }));
  return [...conflicts, ...dropped];
}

function onlyWeekProblems(draft: ProgramDraft): readonly Problem[] {
  const firstWeek = mondayOf(draft.effectiveFrom);
  const check = (week: LocalDate | undefined, path: string): readonly Problem[] => {
    if (week === undefined) return [];
    if (!isMonday(week)) return [{ code: 'bad-only-week', path, message: `${week} is not a Monday` }];
    return week < firstWeek ? [{ code: 'bad-only-week', path, message: `${week} is before this version's week, ${firstWeek}` }] : [];
  };
  return [...draft.days.flatMap((day, d) => day.blocks.flatMap((block, b) => check(block.onlyWeek, `days[${d}].blocks[${b}].onlyWeek`))), ...draft.notes.flatMap((note, n) => check(note.onlyWeek, `notes[${n}].onlyWeek`))];
}

export type PublishVerdict =
  | { readonly status: 'valid'; readonly program: Program; readonly diff: readonly DiffItem[] }
  /** The version already holds this content. */
  | { readonly status: 'unchanged'; readonly id: ProgramId }
  | { readonly status: 'frozen'; readonly id: ProgramId; readonly earliestEffectiveFrom: LocalDate; readonly problems: readonly Problem[] }
  | { readonly status: 'invalid'; readonly problems: readonly Problem[] };

/** A new version may start today, unless today's version already exists and so is frozen. */
export function earliestEffectiveFrom(versions: readonly Program[], today: LocalDate): LocalDate {
  return versions.some((version) => version.effectiveFrom === today) ? addDays(today, 1) : today;
}

/**
 * Everything that refuses a draft, reported together so one fix round is enough. Frozen is a
 * calendar rule rather than a look at sessions, which is what protects a session started offline
 * that the mini has not heard of.
 */
export function checkPublish(raw: unknown, versions: readonly Program[], at: { readonly today: LocalDate; readonly now: Millis }): PublishVerdict {
  const parsed = parseProgramDraft(raw);
  if (!parsed.ok) return { status: 'invalid', problems: parsed.problems };
  const { draft } = parsed;
  const id = programId(draft.effectiveFrom);
  const existing = versions.find((version) => version.id === id);
  if (existing !== undefined && sameContent(existing, draft)) return { status: 'unchanged', id };

  const before = programOn(versions, addDays(draft.effectiveFrom, -1)) ?? null;
  const diff = programDiff(before, draft);
  const earliest = earliestEffectiveFrom(versions, at.today);
  const frozen: readonly Problem[] = existing !== undefined && draft.effectiveFrom <= at.today ? [{ code: 'frozen', path: 'effectiveFrom', message: `${id} has been in effect since ${draft.effectiveFrom}. Publish a new version from ${earliest} or later` }] : [];
  const problems: readonly Problem[] = [
    ...frozen,
    ...(draft.effectiveFrom < at.today ? [{ code: 'back-dated' as const, path: 'effectiveFrom', message: `${draft.effectiveFrom} is before today, ${at.today}` }] : []),
    ...idProblems(draft),
    ...liftProblems(draft),
    ...noteDayProblems(draft),
    ...aliasProblems(draft, before),
    ...onlyWeekProblems(draft),
    ...diff.filter((item) => item.needsReason && item.why === null).map((item): Problem => ({ code: 'unexplained', path: 'changes', message: `${item.kind} ${item.label}: name target "${item.target}" in changes with a reason` })),
  ];
  if (frozen.length > 0) return { status: 'frozen', id, earliestEffectiveFrom: earliest, problems };
  if (problems.length > 0) return { status: 'invalid', problems };
  return { status: 'valid', program: Program.parse({ ...draft, id, publishedAt: at.now }), diff };
}

export const SNAPSHOT_WEEKS = 6;

/** A document with the revision it arrived at, because only arrival order shows that an offline session came in late. */
export interface Arrived<T> {
  readonly doc: T;
  readonly rev: number;
}

export interface TrainDocs {
  /** The newest rev any program took, a tombstone's included, so a publish can tell the plan moved since this read. */
  readonly programRev: number;
  readonly programs: readonly Arrived<Program>[];
  readonly sessions: readonly Arrived<Session>[];
  readonly performances: readonly Arrived<Performance>[];
  readonly trainingNotes: readonly TrainingNote[];
  readonly weighIns: readonly WeighIn[];
  readonly entries: readonly Entry[];
  readonly workouts: readonly Workout[];
}

export interface SnapshotExercise {
  readonly liftId: LiftId;
  readonly label: string;
  /** Working sets as typed, such as "30/45/50 lb x 11/10/9". */
  readonly sets: string;
  readonly warmups: number;
  readonly topLb: number | null;
  readonly volumeLb: number | null;
  readonly e1rmLb: number | null;
  readonly addWeightNext: boolean;
  readonly swappedFrom: LiftId | null;
}

export interface SnapshotSession {
  readonly id: SessionId;
  readonly date: LocalDate;
  readonly day: string | null;
  readonly phase: SessionPhase;
  readonly minutes: number | null;
  readonly exercises: readonly SnapshotExercise[];
  readonly skips: readonly Skip[];
  readonly swaps: readonly Swap[];
  /** It reached the mini after the last report, so the coach has not read it yet. */
  readonly newSinceLastReport: boolean;
}

export interface SnapshotNote {
  readonly date: LocalDate;
  readonly source: 'session' | 'skip' | 'exercise' | 'set' | 'training';
  /** The exercise or slot it is about. */
  readonly about: string | null;
  readonly text: string;
}

export interface SnapshotDiet {
  readonly daysLogged: number;
  readonly averageKcal: number | null;
  readonly averageProtein: number | null;
  /** At least one day had a food with no protein listed, so the average is a lower bound. */
  readonly proteinIsLowerBound: boolean;
}

export interface SnapshotWeighIns {
  readonly readings: readonly { readonly date: LocalDate; readonly kg: number }[];
  readonly averageKg: number | null;
}

export interface SnapshotWeek {
  readonly monday: LocalDate;
  readonly sessionsDone: number;
  readonly sessions: readonly SnapshotSession[];
  readonly weighIns: SnapshotWeighIns;
  readonly diet: SnapshotDiet;
}

/** Exactly what Claude reads, through the functions the phone uses. */
export interface CoachSnapshot {
  readonly today: LocalDate;
  /** What the weekly run publishes for. */
  readonly targetMonday: LocalDate;
  /** The first date a change outside the weekly run can take effect. */
  readonly earliestEffectiveFrom: LocalDate;
  /** Echoed by a publish, which answers stale if the plan has moved past it. */
  readonly basedOnRev: number;
  readonly program: Program | null;
  /** The newest report on or before today. A mid-week version holds none, and an unanswered question must not be lost with it. */
  readonly lastReport: { readonly from: LocalDate; readonly report: NonNullable<Program['report']> } | null;
  readonly upcoming: readonly Program[];
  /** The weeks asked for, oldest first, plus the week of any session that arrived late. */
  readonly weeks: readonly SnapshotWeek[];
  readonly notes: readonly SnapshotNote[];
  /** Names typed on the phone that the catalog has not placed. */
  readonly uncataloged: readonly { readonly liftId: LiftId; readonly label: string; readonly lastDone: LocalDate }[];
  readonly phoneLastSyncAt: Millis | null;
  /** The version that will hold the target Monday, ready for Claude to edit in place, so a following version published ahead is not lost to the week before it. Null with no version by then. */
  readonly draft: ProgramDraft | null;
}

/** The next Monday, or today when today is one, as on a Monday catch-up run. */
export function targetMondayOf(today: LocalDate): LocalDate {
  return isMonday(today) ? today : addDays(mondayOf(today), 7);
}

/**
 * Re-dated, with what cannot carry over removed. Only one-week items already gone by the target
 * week are removed, so a retest planned for a later week is not lost, and the draft publishes
 * with nothing to explain. `changes` explained the last version, so it starts empty.
 */
function lastReportOn(programs: readonly Program[], today: LocalDate): CoachSnapshot['lastReport'] {
  const version = programs
    .filter((p) => p.effectiveFrom <= today && p.report !== undefined)
    .toSorted((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
    .at(-1);
  return version?.report === undefined ? null : { from: version.effectiveFrom, report: version.report };
}

function draftFrom(program: Program, targetMonday: LocalDate): ProgramDraft {
  const { id: _id, publishedAt: _publishedAt, report: _report, ...rest } = program;
  const stillLive = liveFrom(targetMonday);
  return {
    ...rest,
    effectiveFrom: targetMonday,
    days: program.days.map((day) => ({ ...day, blocks: day.blocks.filter(stillLive) })).filter((day) => day.blocks.length > 0),
    notes: program.notes.filter(stillLive),
    changes: [],
  };
}

function weekDiet(entries: readonly Entry[], monday: LocalDate): SnapshotDiet {
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i))
    .map((date) => entries.filter((entry) => entry.date === date))
    .filter((dayEntries) => dayEntries.length > 0)
    .map((dayEntries) => summarizeDay(dayEntries).totals);
  const average = (read: (sum: (typeof days)[number]['sum']) => number) => (days.length === 0 ? null : days.reduce((sum, totals) => sum + read(totals.sum), 0) / days.length);
  return {
    daysLogged: days.length,
    averageKcal: average((sum) => sum.kcal),
    averageProtein: average((sum) => sum.protein),
    proteinIsLowerBound: days.some((totals) => totals.incomplete.has('protein')),
  };
}

function weekWeighIns(weighIns: readonly WeighIn[], monday: LocalDate): SnapshotWeighIns {
  const readings = weighIns
    .filter((weighIn) => mondayOf(weighIn.date) === monday)
    .toSorted((a, b) => a.date.localeCompare(b.date))
    .map((weighIn) => ({ date: weighIn.date, kg: weighIn.kg }));
  return { readings, averageKg: readings.length === 0 ? null : readings.reduce((sum, reading) => sum + reading.kg, 0) / readings.length };
}

function snapshotExercise(performance: Performance): SnapshotExercise {
  const working = workingSets(performance.sets);
  const { topLb, volumeLb, e1rmLb } = totalsOf(working);
  return {
    liftId: performance.liftId,
    label: performance.label,
    sets: typedLine(working),
    warmups: performance.sets.length - working.length,
    topLb,
    volumeLb,
    e1rmLb,
    addWeightNext: addWeightNext(performance),
    swappedFrom: performance.plannedLiftId ?? null,
  };
}

function notesOf(session: Session, performances: readonly Performance[], skips: readonly Skip[]): readonly SnapshotNote[] {
  const { date } = session;
  return [
    ...(session.note === undefined ? [] : [{ date, source: 'session' as const, about: session.day?.label ?? null, text: session.note }]),
    ...skips.flatMap((skip) => (skip.note === null ? [] : [{ date, source: 'skip' as const, about: skip.label, text: skip.note }])),
    ...performances.flatMap((p) => [
      ...(p.note === undefined ? [] : [{ date, source: 'exercise' as const, about: p.label, text: p.note }]),
      ...p.sets.flatMap((set) => (set.note === undefined ? [] : [{ date, source: 'set' as const, about: p.label, text: set.note }])),
    ]),
  ];
}

export function snapshotOf(docs: TrainDocs, at: { readonly today: LocalDate; readonly now: Millis; readonly phoneLastSyncAt: Millis | null }, weekCount = SNAPSHOT_WEEKS): CoachSnapshot {
  const { today, now } = at;
  const programs = docs.programs.map((program) => program.doc);
  const program = programOn(programs, today) ?? null;
  const reportRevs = docs.programs.filter((version) => version.doc.report !== undefined).map((version) => version.rev);
  const lastReportRev = reportRevs.length === 0 ? null : Math.max(...reportRevs);
  const performances = docs.performances.map((row) => row.doc);
  const thisWeek = mondayOf(today);
  const firstWeek = addDays(thisWeek, -7 * (weekCount - 1));

  const reads = docs.sessions.map(({ doc: session, rev }) => {
    const own = docs.performances.filter((row) => row.doc.sessionId === session.id);
    return { session, performances: own.map((row) => row.doc), arrived: Math.max(rev, ...own.map((row) => row.rev)) };
  });
  const late = (arrived: number) => lastReportRev !== null && arrived > lastReportRev;
  const shown = reads
    .filter(({ session, arrived }) => session.date >= firstWeek || late(arrived))
    .toSorted((a, b) => a.session.date.localeCompare(b.session.date) || (a.session.startedAt ?? 0) - (b.session.startedAt ?? 0));

  const summaries = shown.map((read) => {
    const { session } = read;
    const pinned = programs.find((version) => version.id === session.programId);
    const plan = pinned === undefined || session.day === undefined ? undefined : plannedDay(pinned, session.day.key, session.date);
    const phase = sessionPhase(read, now);
    const skips = skipsOf({ session, performances: read.performances, plan, phase });
    const finishedAt = finishOf(read, now);
    const others = docs.workouts.filter((workout) => workout.date === session.date);
    const minutes = finishedAt === null ? null : (sessionWorkoutDraft({ logs: read, finishedAt, others })?.minutes ?? null);
    const summary: SnapshotSession = {
      id: session.id,
      date: session.date,
      day: session.day?.label ?? null,
      phase,
      minutes,
      exercises: read.performances.map(snapshotExercise),
      skips,
      swaps: swapsOf(read.performances),
      newSinceLastReport: lastReportRev === null || late(read.arrived),
    };
    return { summary, notes: notesOf(session, read.performances, skips) };
  });

  const regularWeeks = Array.from({ length: weekCount }, (_, i) => addDays(firstWeek, 7 * i));
  const mondays = [...new Set([...shown.map((read) => mondayOf(read.session.date)), ...regularWeeks])].toSorted((a, b) => a.localeCompare(b));
  const weeks = mondays.map((monday): SnapshotWeek => {
    const inWeek = shown.filter((read) => mondayOf(read.session.date) === monday);
    return {
      monday,
      sessionsDone: sessionsDone(
        inWeek.map((read) => read.session),
        performances,
      ).length,
      sessions: summaries.filter(({ summary }) => mondayOf(summary.date) === monday).map(({ summary }) => summary),
      weighIns: weekWeighIns(docs.weighIns, monday),
      diet: weekDiet(docs.entries, monday),
    };
  });

  const book = liftBook(program?.lifts ?? []);
  const oldestFirst = performances.filter((p) => !book.has(p.liftId)).toSorted((a, b) => a.date.localeCompare(b.date));
  const uncataloged = [...new Map(oldestFirst.map((p) => [p.liftId, { liftId: p.liftId, label: p.label, lastDone: p.date }])).values()].toSorted((a, b) => a.liftId.localeCompare(b.liftId));

  const trainingNotes = docs.trainingNotes.filter((note) => note.date >= firstWeek).map((note): SnapshotNote => ({ date: note.date, source: 'training', about: null, text: note.text }));

  const targetMonday = targetMondayOf(today);
  const holdingTarget = programOn(programs, targetMonday);
  return {
    today,
    targetMonday,
    earliestEffectiveFrom: earliestEffectiveFrom(programs, today),
    basedOnRev: docs.programRev,
    program,
    lastReport: lastReportOn(programs, today),
    upcoming: programs.filter((version) => version.effectiveFrom > today).toSorted((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)),
    weeks,
    notes: [...summaries.flatMap(({ notes }) => notes), ...trainingNotes].toSorted((a, b) => a.date.localeCompare(b.date)),
    uncataloged,
    phoneLastSyncAt: at.phoneLastSyncAt,
    draft: holdingTarget === undefined ? null : draftFrom(holdingTarget, targetMonday),
  };
}
