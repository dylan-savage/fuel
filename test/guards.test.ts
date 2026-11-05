/**
 * Mistakes a new kind or field could make, turned into failures. A plain z.object loses data
 * because the server stores parser output, and a new required field stops sync on any phone
 * still holding an older document.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseProgramDraft } from '../src/domain/coach.js';
import { KINDS, KIND_NAMES, parseDoc, type Kind } from '../src/domain/kinds.js';
import { isRecord } from '../src/domain/strict.js';

/** Schema types that cannot hold an object. Anything else must be walked, or the walker throws. */
const LEAVES: ReadonlySet<string> = new Set(['string', 'number', 'boolean', 'literal', 'enum', 'custom', 'unknown']);

/** Every path whose object does not keep unknown fields: z.object drops them and z.strictObject refuses them. */
function closedObjects(schema: z.core.$ZodType, path = 'doc'): readonly string[] {
  if (schema instanceof z.ZodObject) {
    const fields = Object.entries<z.core.$ZodType>(schema.shape).flatMap(([key, field]) => closedObjects(field, `${path}.${key}`));
    return schema.def.catchall instanceof z.ZodUnknown ? fields : [path, ...fields];
  }
  if (schema instanceof z.ZodArray) return closedObjects(schema.element, `${path}[]`);
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodNonOptional) return closedObjects(schema.unwrap(), path);
  if (schema instanceof z.ZodUnion) return schema.options.flatMap((option, i) => closedObjects(option, `${path}|${i}`));
  if (LEAVES.has(schema._zod.def.type)) return [];
  throw new Error(`closedObjects cannot look inside a ${schema._zod.def.type} at ${path}. Teach it, so nothing hides there.`);
}

describe('closedObjects', () => {
  const nested = (inner: z.ZodType) => z.looseObject({ blocks: z.array(z.discriminatedUnion('kind', [z.looseObject({ kind: z.literal('a'), detail: inner.optional() })])) });

  it('finds a z.object or z.strictObject under an optional, an array and a union', () => {
    expect(closedObjects(nested(z.object({ x: z.string() })))).toEqual(['doc.blocks[]|0.detail']);
    expect(closedObjects(nested(z.strictObject({ x: z.string() })))).toEqual(['doc.blocks[]|0.detail']);
    expect(closedObjects(nested(z.looseObject({ x: z.string() })))).toEqual([]);
  });

  it('sees through a refinement', () => {
    expect(closedObjects(z.object({ x: z.string() }).refine(() => true))).toEqual(['doc']);
  });

  it('refuses a schema type it cannot look inside', () => {
    expect(() => closedObjects(z.record(z.string(), z.object({})))).toThrow(/record/);
  });
});

type Path = readonly (string | number)[];

/** Every object inside a JSON value, by path, the root included. */
function objectPaths(value: unknown, path: Path = []): readonly Path[] {
  if (Array.isArray(value)) return value.flatMap((item: unknown, i) => objectPaths(item, [...path, i]));
  if (!isRecord(value)) return [];
  return [path, ...Object.entries(value).flatMap(([key, field]) => objectPaths(field, [...path, key]))];
}

/** A copy of the value with a stray field added to the object at `path`. */
function withStray(value: unknown, path: Path): unknown {
  const [head, ...rest] = path;
  if (Array.isArray(value)) return value.map((item: unknown, i) => (i === head ? withStray(item, rest) : item));
  if (!isRecord(value)) return value;
  if (head === undefined) return { ...value, strayField: 1 };
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, key === head ? withStray(field, rest) : field]));
}

const UUID_A = '0b1e6c7a-3f2d-4e5a-8b9c-0d1e2f3a4b5c';
const UUID_B = '1c2f7d8b-4a3e-4f6b-9cad-1e2f3a4b5c6d';
const SNAPSHOT = {
  name: 'Soup',
  brand: 'Acme',
  unit: 'g',
  nutrients: { kcal: 40, protein: 2, carbs: 5, fat: 1, fiber: 1, sugar: 2, sodium: 300 },
  servings: [{ label: '1 cup', amount: 249 }],
  origin: { kind: 'food', id: UUID_A },
};
const INGREDIENT = { food: SNAPSHOT, quantity: { kind: 'serving', serving: { label: '1 cup', amount: 249 }, count: 1.5 } };

const PROGRAM_SAMPLE = {
  effectiveFrom: '2030-03-04',
  weeklyMinimum: 3,
  days: [
    {
      key: 'push',
      label: 'Mon, Push',
      weekday: 1,
      minutes: 60,
      blocks: [
        { kind: 'checklist', id: 'warm', title: 'Warm up', note: 'Easy.', items: ['Arm circles'] },
        {
          kind: 'lifts',
          id: 'a',
          title: 'Superset A',
          restSeconds: 90,
          slots: [
            {
              id: 'a1',
              liftId: 'bench-press',
              label: 'Bench press',
              cue: 'Pause on the chest.',
              setPrompt: 'Any pinch?',
              target: { sets: 3, reps: { min: 8, max: 10 }, perSide: 'left-first', load: 'weight' },
              swaps: [{ liftId: 'incline-press', label: 'Incline press', cue: 'Elbows in.' }],
            },
          ],
        },
        { kind: 'cardio', id: 'zone', optional: true, onlyWeek: '2030-03-04' },
      ],
    },
  ],
  lifts: [
    { id: 'bench-press', name: 'Bench press', aliases: ['barbell-bench'], key: true },
    { id: 'incline-press', name: 'Incline press', aliases: [] },
  ],
  notes: [{ title: 'This week', text: 'Deload.', onlyWeek: '2030-03-04' }, { text: 'Start light.', day: 'push' }],
  standing: [{ key: 'rules', title: 'Rules', text: 'Stop two reps short.' }],
  report: { title: 'Week 1', text: 'A good start.' },
  changes: [{ target: 'slot:push/a2', why: 'The machine is gone.' }],
};

/**
 * Documents exactly as a phone may already hold them. Keyed by kind, so a new kind fails tsc
 * until it has one. Typed as unknown on purpose, so a schema change cannot silently carry a
 * sample along. If one stops parsing, change the schema, not the sample: make the new field
 * optional.
 */
const FROZEN_SAMPLES: { readonly [K in Kind]: unknown } = {
  food: {
    id: UUID_A,
    name: 'Soup',
    brand: 'Acme',
    unit: 'g',
    nutrients: { kcal: 40, protein: 2, carbs: 5, fat: 1, fiber: 1 },
    servings: [{ label: '1 cup', amount: 249 }],
    barcodes: ['0012345678905'],
    source: { kind: 'off', gtin: '0012345678905', fetchedAt: 1_800_000_000_000 },
    archived: false,
  },
  entry: { id: UUID_A, date: '2030-03-04', meal: 'lunch', loggedAt: 1_800_000_000_000, ...INGREDIENT },
  profile: { id: 'me', sex: 'female', birthDate: '1990-06-15', heightCm: 170, weightKg: 70 },
  goal: {
    id: 'g:2030-03-04',
    effectiveFrom: '2030-03-04',
    policy: { kind: 'eat-back-workouts', fraction: 0.5 },
    kgPerWeek: -0.25,
    kcalOverride: 2100,
    macros: { kind: 'percent', protein: 30, carbs: 40, fat: 30 },
    waterMl: 2500,
    goalWeightKg: 68,
  },
  recipe: { id: UUID_A, name: 'Stew', ingredients: [INGREDIENT], yield: { servings: 4, cookedGrams: 1200 }, archived: false },
  savedMeal: { id: UUID_A, name: 'Usual lunch', items: [INGREDIENT], archived: false },
  water: { id: UUID_A, date: '2030-03-04', ml: 500, loggedAt: 1_800_000_000_000 },
  fast: { id: UUID_A, startedAt: 1_800_000_000_000, targetHours: 16 },
  fastEnd: { id: UUID_B, fastId: UUID_A, endedAt: 1_800_000_060_000 },
  weighIn: { id: 'w:2030-03-04', date: '2030-03-04', kg: 70.5, loggedAt: 1_800_000_000_000 },
  workout: {
    id: UUID_A,
    date: '2030-03-04',
    name: 'Run',
    minutes: 30,
    source: { kind: 'met', activity: 'run_6', met: 9.3 },
    kg: 70,
    kcal: 290,
    loggedAt: 1_800_000_000_000,
  },
  program: { id: 'p:2030-03-04', publishedAt: 1_800_000_000_000, ...PROGRAM_SAMPLE },
  session: {
    id: UUID_A,
    date: '2030-03-04',
    day: { key: 'push', label: 'Mon, Push' },
    programId: 'p:2030-03-04',
    startedAt: 1_800_000_000_000,
    finishedAt: 1_800_003_600_000,
    skips: [{ slotId: 'a2', note: 'Machine taken.' }],
    checked: ['warm'],
    note: 'Felt strong.',
  },
  performance: {
    id: `pf:${UUID_A}:a1:incline-press`,
    sessionId: UUID_A,
    date: '2030-03-04',
    liftId: 'incline-press',
    label: 'Incline press',
    slotId: 'a1',
    plannedLiftId: 'bench-press',
    target: { sets: 3, reps: { min: 8, max: 10 }, perSide: 'either' },
    note: 'Grip slipped.',
    sets: [
      { load: { kind: 'weight', amount: 45, unit: 'lb' }, reps: { kind: 'total', reps: 10 }, warmup: true, at: 1_800_000_000_000 },
      { load: { kind: 'weight', amount: 20, unit: 'kg' }, reps: { kind: 'sides', left: 8, right: 7 }, note: 'No pinch.', at: 1_800_000_060_000 },
      { load: { kind: 'bodyweight' }, reps: { kind: 'total', reps: 12 } },
      { load: { kind: 'band', label: 'green' }, reps: { kind: 'total', reps: 15 } },
    ],
  },
  trainingNote: { id: UUID_A, date: '2030-03-04', text: 'Sleep has been short.', at: 1_800_000_000_000 },
};

/**
 * The only inputs that refuse an unknown field rather than keep it, because Claude writes them
 * and a misspelled field must fail. Everything stored above must do the opposite.
 */
const STRICT_INPUTS: Readonly<Record<string, { readonly accepts: (raw: unknown) => boolean; readonly sample: unknown }>> = {
  ProgramDraft: { accepts: (raw) => parseProgramDraft(raw).ok, sample: PROGRAM_SAMPLE },
};

describe.each(KIND_NAMES)('stored kind %s', (kind) => {
  it('keeps unknown fields at every depth', () => {
    expect(closedObjects(KINDS[kind].schema)).toEqual([]);
  });

  it('still parses its frozen sample, dropping nothing', () => {
    const sample = FROZEN_SAMPLES[kind];
    expect(parseDoc(kind, sample)).toEqual({ ok: true, doc: sample });
  });

  it('carries a stray field through at every object in its sample', () => {
    const sample = FROZEN_SAMPLES[kind];
    for (const path of objectPaths(sample)) {
      const newer = withStray(sample, path);
      expect([path, parseDoc(kind, newer)]).toEqual([path, { ok: true, doc: newer }]);
    }
  });
});

describe.each(Object.entries(STRICT_INPUTS))('strict input %s', (_name, entry) => {
  it('accepts its sample', () => {
    expect(entry.accepts(entry.sample)).toBe(true);
  });

  it('refuses a stray field at every object in it', () => {
    const paths = objectPaths(entry.sample);
    expect(paths.length).toBeGreaterThan(10);
    for (const path of paths) expect([path, entry.accepts(withStray(entry.sample, path))]).toEqual([path, false]);
  });
});
