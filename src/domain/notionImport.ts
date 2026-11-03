/**
 * The one-time Notion import. Dated for deletion: the cutover unit removes this file, its route
 * and scripts/reconcile-history.mjs, because nothing else uses them.
 *
 * Input is .private/training/import/notion-history.json, which git ignores. A Claude session with
 * the Notion tools produces it from two reads: day pages into `weeks`, and the Progress, All Weeks
 * and Body Weight databases copied verbatim. The second read is the check on the first. EXPORT.md
 * beside that file holds the steps and the rules for reading a page.
 */
import { z } from 'zod';
import { LocalDate, addDays } from './ids.js';
import { LiftId, Target, Unit } from './lifts.js';
import { BlockId, DayKey } from './program.js';
import { totalsOf, type ExerciseTotals } from './progress.js';

const Text = z.string().min(1);
const repCount = z.number().int().nonnegative();

/** Strict at every depth, against the repo's stored shapes, because a model writes this file and a misspelled field must fail. */
const NotionLoad = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('weight'), amount: z.number().positive(), unit: Unit }),
  z.strictObject({ kind: z.literal('bodyweight') }),
  z.strictObject({ kind: z.literal('band'), label: Text }),
]);

const NotionReps = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('total'), reps: repCount }), z.strictObject({ kind: z.literal('sides'), left: repCount, right: repCount })]);

/** Only what he typed. No warm-up flag and no time, which Notion never recorded, so every set reads as a working set. */
const NotionSet = z.strictObject({ load: NotionLoad, reps: NotionReps, note: Text.optional() });
type NotionSet = z.infer<typeof NotionSet>;

const NotionTarget = z.strictObject({
  sets: Target.shape.sets,
  reps: z.strictObject({ min: repCount, max: repCount }),
  perSide: Target.shape.perSide,
  load: Target.shape.load,
});

const NotionExercise = z.strictObject({
  /** The name of what he really did. */
  done: Text,
  /** The name the page planned, when he did something else or renamed it. */
  planned: Text.optional(),
  target: NotionTarget.optional(),
  sets: z.array(NotionSet).min(1),
  note: Text.optional(),
});

const NotionDay = z.strictObject({
  /** The page's title, which is also Progress's Day. */
  label: Text,
  key: DayKey,
  /** 1 is Monday. */
  weekday: z.number().int().min(1).max(7),
  date: LocalDate,
  pageId: Text,
  /** Notion's last edit of the page. A hint at the real day, and how a re-export spots a changed page. */
  pageEditedAt: z.iso.datetime(),
  morningWeightLb: z.number().positive().optional(),
  checked: z.array(BlockId).optional(),
  note: Text.optional(),
  exercises: z.array(NotionExercise),
  /** Required exercises the page planned with nothing logged. */
  skipped: z.array(z.strictObject({ planned: Text, note: Text.optional() })),
});

const ProgressRow = z.strictObject({
  entry: Text,
  exercise: Text,
  day: Text,
  monday: LocalDate,
  topLb: z.number().nullable(),
  volume: z.number().nullable(),
  e1rm: z.number().nullable(),
  reps: z.string(),
  keyLift: z.boolean(),
});
type ProgressRow = z.infer<typeof ProgressRow>;

const WaiverField = z.enum(['topLb', 'volume', 'e1rm', 'no-logged-sets', 'no-progress-row', 'sessions-done', 'body-weight']);
type WaiverField = z.infer<typeof WaiverField>;

const Waiver = z.strictObject({
  /** A finding's `row`, exactly. */
  row: Text,
  field: WaiverField,
  reason: Text,
});
type Waiver = z.infer<typeof Waiver>;

function namesIn(history: { readonly weeks: readonly { readonly days: readonly z.infer<typeof NotionDay>[] }[]; readonly progress: readonly ProgressRow[] }): readonly string[] {
  const onPages = history.weeks.flatMap((week) => week.days.flatMap((day) => [...day.exercises.flatMap((e) => [e.done, ...(e.planned === undefined ? [] : [e.planned])]), ...day.skipped.map((skip) => skip.planned)]));
  return [...onPages, ...history.progress.map((row) => row.exercise)];
}

export const NotionHistory = z
  .strictObject({
    capturedAt: LocalDate,
    /** Stated once, because every session's date rests on it. */
    dateAssumption: Text,
    /** Every name in any source to its lift, so a name that reaches Progress as another is visible. */
    names: z.record(Text, LiftId),
    weeks: z.array(z.strictObject({ monday: LocalDate, days: z.array(NotionDay) })),
    progress: z.array(ProgressRow),
    weekRows: z.array(z.strictObject({ week: Text, monday: LocalDate, current: z.boolean(), sessionsDone: z.number().int().nonnegative(), notes: z.string().nullable() })),
    bodyWeight: z.array(z.strictObject({ entry: Text, date: LocalDate, lb: z.number().positive() })),
    waivers: z.array(Waiver),
  })
  .superRefine((history, ctx) => {
    for (const name of new Set(namesIn(history))) {
      if (history.names[name] === undefined) ctx.addIssue({ code: 'custom', path: ['names'], message: `no lift for "${name}"` });
    }
    for (const week of history.weeks) {
      for (const day of week.days) {
        const expected = addDays(week.monday, day.weekday - 1);
        if (day.date !== expected) ctx.addIssue({ code: 'custom', path: ['weeks'], message: `${day.label} of ${week.monday} is dated ${day.date}, expected ${expected}` });
        const slots = [...day.exercises.map((e) => history.names[e.planned ?? e.done]), ...day.skipped.map((skip) => history.names[skip.planned])];
        for (const slot of new Set(slots)) {
          if (slot !== undefined && slots.indexOf(slot) !== slots.lastIndexOf(slot)) ctx.addIssue({ code: 'custom', path: ['weeks'], message: `${day.label} of ${week.monday} plans ${slot} twice, so a document would overwrite another` });
        }
      }
    }
  });
export type NotionHistory = z.infer<typeof NotionHistory>;

function liftOf(names: NotionHistory['names'], name: string): LiftId {
  const id = names[name];
  if (id === undefined) throw new Error(`no lift for "${name}", which NotionHistory refuses`);
  return id;
}

export interface Finding {
  /** "<monday> <day> <lift>" for a Progress row, the Monday for a week, the date for a weigh-in. */
  readonly row: string;
  readonly field: WaiverField;
  readonly notion: string;
  readonly computed: string;
  /** Why it stands waived. Null while it stands. */
  readonly waiver: string | null;
}

export interface Reconciliation {
  readonly progressRows: number;
  /** Progress rows that agree on every total. */
  readonly matched: number;
  /** Progress rows that disagree, every disagreement waived. */
  readonly waivedRows: number;
  readonly findings: readonly Finding[];
  readonly standing: readonly Finding[];
  /** Waivers naming nothing that disagrees, so a re-export whose rows now agree cannot carry an old excuse forward. */
  readonly staleWaivers: readonly Waiver[];
  readonly clean: boolean;
}

/**
 * Progress rounded est. 1RM and volume to whole pounds on most rows, so half a pound of either
 * is rounding. It copied top weight, so top weight gets no slack.
 */
const TOTAL_FIELDS: readonly { readonly field: 'topLb' | 'volume' | 'e1rm'; readonly tolerance: number; readonly computed: (totals: ExerciseTotals) => number | null }[] = [
  { field: 'topLb', tolerance: 0, computed: (totals) => totals.topLb },
  { field: 'volume', tolerance: 0.5, computed: (totals) => totals.volumeLb },
  { field: 'e1rm', tolerance: 0.5, computed: (totals) => totals.e1rmLb },
];

const FLOAT_SLACK = 1e-9;

function agree(a: number | null, b: number | null, tolerance: number): boolean {
  return a === null || b === null ? a === b : Math.abs(a - b) <= tolerance + FLOAT_SLACK;
}

function shown(value: number | null | undefined): string {
  return value === null || value === undefined ? 'blank' : `${Math.round(value * 100) / 100}`;
}

function rowKey(monday: LocalDate, day: string, lift: LiftId): string {
  return `${monday} ${day} ${lift}`;
}

/** Every exercise he logged, keyed like its Progress row. Two slots under one lift on one day read as one row, as they do in Progress. */
function loggedRows(history: NotionHistory): ReadonlyMap<string, readonly NotionSet[]> {
  const rows = new Map<string, readonly NotionSet[]>();
  for (const week of history.weeks) {
    for (const day of week.days) {
      for (const exercise of day.exercises) {
        const key = rowKey(week.monday, day.label, liftOf(history.names, exercise.done));
        rows.set(key, [...(rows.get(key) ?? []), ...exercise.sets]);
      }
    }
  }
  return rows;
}

type Disagreement = Omit<Finding, 'waiver'>;

function disagreementsOf(row: ProgressRow, key: string, sets: readonly NotionSet[] | undefined): readonly Disagreement[] {
  if (sets === undefined) return [{ row: key, field: 'no-logged-sets', notion: row.reps, computed: 'no sets' }];
  const totals = totalsOf(sets);
  return TOTAL_FIELDS.flatMap(({ field, tolerance, computed }) => {
    const value = computed(totals);
    return agree(row[field], value, tolerance) ? [] : [{ row: key, field, notion: shown(row[field]), computed: shown(value) }];
  });
}

/** Both directions at once: a key either side lacks disagrees too. */
function sideBySide(field: WaiverField, notion: ReadonlyMap<string, number>, computed: ReadonlyMap<string, number>): readonly Disagreement[] {
  return [...new Set([...notion.keys(), ...computed.keys()])].toSorted().flatMap((row) => {
    const a = notion.get(row);
    const b = computed.get(row);
    return a === b ? [] : [{ row, field, notion: shown(a), computed: shown(b) }];
  });
}

function loggedDays(week: NotionHistory['weeks'][number]): readonly NotionHistory['weeks'][number]['days'][number][] {
  return week.days.filter((day) => day.exercises.length > 0);
}

/** A day with any logged set is a session, which is the weekly routine's own rule for Sessions done. */
function sessionDisagreements(history: NotionHistory): readonly Disagreement[] {
  return sideBySide('sessions-done', new Map(history.weekRows.map((row) => [row.monday, row.sessionsDone])), new Map(history.weeks.map((week) => [week.monday, loggedDays(week).length])));
}

function bodyWeightDisagreements(history: NotionHistory): readonly Disagreement[] {
  const typed = history.weeks.flatMap((week) => week.days.flatMap((day) => (day.morningWeightLb === undefined ? [] : [[day.date, day.morningWeightLb] as const])));
  return sideBySide('body-weight', new Map(history.bodyWeight.map((row) => [row.date, row.lb])), new Map(typed));
}

const waiverKey = (row: string, field: WaiverField): string => `${row}|${field}`;

/**
 * Recomputes every Progress row through the phone's own totalsOf and reports both directions,
 * sessions done per week, and weigh-ins. A disagreement stands until a waiver names its row and
 * field. Nothing here adjusts a number to make a row pass.
 */
export function reconcile(history: NotionHistory): Reconciliation {
  const logged = loggedRows(history);
  const rowKeys = new Map(history.progress.map((row) => [row, rowKey(row.monday, row.day, liftOf(history.names, row.exercise))]));
  const inProgress = new Set(rowKeys.values());
  const onRows = [...rowKeys].map(([row, key]) => ({ key, found: disagreementsOf(row, key, logged.get(key)) }));
  const disagreements: readonly Disagreement[] = [
    ...onRows.flatMap((row) => row.found),
    ...[...logged.keys()].filter((key) => !inProgress.has(key)).map((row): Disagreement => ({ row, field: 'no-progress-row', notion: 'no row', computed: 'logged sets' })),
    ...sessionDisagreements(history),
    ...bodyWeightDisagreements(history),
  ];
  const reasons = new Map(history.waivers.map((waiver) => [waiverKey(waiver.row, waiver.field), waiver.reason]));
  const findings = disagreements.map((found): Finding => ({ ...found, waiver: reasons.get(waiverKey(found.row, found.field)) ?? null }));
  const standing = findings.filter((found) => found.waiver === null);
  const standingRows = new Set(standing.map((found) => found.row));
  const disagreed = onRows.filter((row) => row.found.length > 0);
  const known = new Set(disagreements.map((found) => waiverKey(found.row, found.field)));
  const staleWaivers = history.waivers.filter((waiver) => !known.has(waiverKey(waiver.row, waiver.field)));
  return {
    progressRows: history.progress.length,
    matched: history.progress.length - disagreed.length,
    waivedRows: disagreed.filter((row) => !standingRows.has(row.key)).length,
    findings,
    standing,
    staleWaivers,
    clean: standing.length === 0 && staleWaivers.length === 0,
  };
}
