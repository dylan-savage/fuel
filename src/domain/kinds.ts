import { z } from 'zod';
import { Entry } from './diary.js';
import { Food } from './food.js';
import { Goal, Profile } from './goals.js';
import { Fast, FastEnd, Water } from './habits.js';
import type { LocalDate } from './ids.js';
import { Recipe, SavedMeal } from './reuse.js';

interface KindDef<S extends z.ZodType<{ id: string }>, D extends boolean> {
  readonly schema: S;
  /** Dated kinds get a doc.date index on the phone and can be read by day. */
  readonly dated: D;
  /** Further Dexie index specs on the phone, such as '*doc.barcodes'. */
  readonly indexes: readonly string[];
}

function doc<S extends z.ZodType<{ id: string }>>(schema: S, indexes: readonly string[] = []): KindDef<S, false> {
  return { schema, dated: false, indexes };
}

/** The bound makes marking a kind dated a compile error when its documents have no date. */
function datedDoc<S extends z.ZodType<{ id: string; date: LocalDate }>>(schema: S): KindDef<S, true> {
  return { schema, dated: true, indexes: [] };
}

/** The phone's index on food barcodes. Multi-entry ('*'), so each GTIN is its own key. */
export const BARCODE_INDEX = 'doc.barcodes';

/**
 * The only list of document kinds. Server validation, the phone's IndexedDB tables and the
 * write types all derive from it, so adding storage is one line plus the compile errors.
 */
const DEFS = {
  food: doc(Food, [`*${BARCODE_INDEX}`]),
  entry: datedDoc(Entry),
  profile: doc(Profile),
  goal: doc(Goal),
  recipe: doc(Recipe),
  savedMeal: doc(SavedMeal),
  water: datedDoc(Water),
  fast: doc(Fast),
  fastEnd: doc(FastEnd),
} as const;

export type Kind = keyof typeof DEFS;
export type DocOf<K extends Kind> = z.infer<(typeof DEFS)[K]['schema']>;
export type DatedKind = { [K in Kind]: (typeof DEFS)[K]['dated'] extends true ? K : never }[Kind];

/** The same registry, typed per key so `KINDS[kind].schema` parses to `DocOf<typeof kind>`. */
export const KINDS: { readonly [K in Kind]: KindDef<z.ZodType<DocOf<K>>, (typeof DEFS)[K]['dated']> } = DEFS;

function isKind(value: unknown): value is Kind {
  return typeof value === 'string' && Object.hasOwn(KINDS, value);
}

export const KIND_NAMES: readonly Kind[] = Object.keys(KINDS).filter(isKind);
export const KindName = z.custom<Kind>(isKind, 'unknown kind');

/**
 * A local write. Whole documents only: no patches and no increments, which is what lets
 * the phone keep its unsynced version of a document over anything it pulls.
 */
export type Mutation = {
  [K in Kind]:
    | { readonly op: 'put'; readonly kind: K; readonly doc: DocOf<K> }
    | { readonly op: 'delete'; readonly kind: K; readonly id: DocOf<K>['id'] };
}[Kind];

export type Parsed<T> = { readonly ok: true; readonly doc: T } | { readonly ok: false; readonly reason: string };

/** The boundary parse for any document crossing the wire. */
export function parseDoc<K extends Kind>(kind: K, raw: unknown): Parsed<DocOf<K>> {
  const result = KINDS[kind].schema.safeParse(raw);
  return result.success ? { ok: true, doc: result.data } : { ok: false, reason: z.prettifyError(result.error) };
}

/** A Dexie `stores()` argument: table name to primary key and indexes. */
export type DexieSpec = Readonly<Record<string, string>>;

/** The phone's IndexedDB layout as the registry implies it today. */
export function dexieStores(): DexieSpec {
  const kinds = Object.fromEntries(
    KIND_NAMES.map((kind) => {
      const { dated, indexes } = KINDS[kind];
      return [kind, ['id', ...(dated ? ['doc.date'] : []), ...indexes].join(', ')];
    }),
  );
  return { ...kinds, outbox: '++mutationId', meta: 'key' };
}

/**
 * Append-only. Entry n is the full IndexedDB layout at version n + 1, so the version is
 * derived, never hand-bumped. When the registry changes the layout, append the new
 * dexieStores() output; never edit or remove an entry.
 */
export const SCHEMA_HISTORY: readonly DexieSpec[] = [
  { food: 'id', entry: 'id, doc.date', outbox: '++mutationId', meta: 'key' },
  { food: 'id, *doc.barcodes', entry: 'id, doc.date', profile: 'id', goal: 'id', outbox: '++mutationId', meta: 'key' },
  {
    food: 'id, *doc.barcodes',
    entry: 'id, doc.date',
    profile: 'id',
    goal: 'id',
    recipe: 'id',
    savedMeal: 'id',
    outbox: '++mutationId',
    meta: 'key',
  },
  {
    food: 'id, *doc.barcodes',
    entry: 'id, doc.date',
    profile: 'id',
    goal: 'id',
    recipe: 'id',
    savedMeal: 'id',
    water: 'id, doc.date',
    fast: 'id',
    outbox: '++mutationId',
    meta: 'key',
  },
  {
    food: 'id, *doc.barcodes',
    entry: 'id, doc.date',
    profile: 'id',
    goal: 'id',
    recipe: 'id',
    savedMeal: 'id',
    water: 'id, doc.date',
    fast: 'id',
    fastEnd: 'id',
    outbox: '++mutationId',
    meta: 'key',
  },
];

export const DB_VERSION = SCHEMA_HISTORY.length;
