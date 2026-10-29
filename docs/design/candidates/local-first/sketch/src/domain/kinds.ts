import { z } from 'zod';
import { todo } from '../todo.js';
import { HealthDay, Exercise } from './burn.js';
import { Entry } from './diary.js';
import { Food, Recipe, SavedMeal } from './food.js';
import { Fast, WaterLog } from './habits.js';
import { Goal, Profile } from './goals.js';
import { WeighIn } from './body.js';
import type { LocalDate } from './ids.js';

/**
 * Who may write a kind. 'client' kinds arrive only through /api/sync pushes.
 * 'server' kinds are written only by server code (Health ingest) and pushes of them are
 * rejected. Each kind has exactly one writer class, so two writers never share a document.
 */
type Writer = 'client' | 'server';

interface KindDef<S extends z.ZodType<{ id: string }>, W extends Writer, D extends boolean> {
  readonly schema: S;
  readonly writer: W;
  /** Dated kinds get a doc.date index on the phone and appear in ReplicaReader.onDate. */
  readonly dated: D;
  /** Extra Dexie index paths on the stored row { id, rev, doc }. */
  readonly extraIndexes: readonly string[];
}

function doc<S extends z.ZodType<{ id: string }>, W extends Writer>(
  schema: S,
  writer: W,
  extraIndexes: readonly string[] = [],
): KindDef<S, W, false> {
  return { schema, writer, dated: false, extraIndexes };
}

/** The type parameter bound makes it a compile error to mark a kind dated when its docs have no date. */
function datedDoc<S extends z.ZodType<{ id: string; date: LocalDate }>, W extends Writer>(
  schema: S,
  writer: W,
  extraIndexes: readonly string[] = [],
): KindDef<S, W, true> {
  return { schema, writer, dated: true, extraIndexes };
}

/**
 * THE registry. Adding a feature's storage is one line here. The server stores every kind
 * in one generic table, the phone gets one Dexie table per kind, and validation on both
 * sides of the wire uses these schemas. No other list of kinds exists.
 */
export const KINDS = {
  food: doc(Food, 'client', ['*doc.barcodes']),
  recipe: doc(Recipe, 'client'),
  savedMeal: doc(SavedMeal, 'client'),
  entry: datedDoc(Entry, 'client'),
  exercise: datedDoc(Exercise, 'client'),
  water: datedDoc(WaterLog, 'client'),
  fast: doc(Fast, 'client', ['doc.startedAt']),
  weighIn: datedDoc(WeighIn, 'client'),
  goal: doc(Goal, 'client', ['doc.effectiveFrom']),
  profile: doc(Profile, 'client'),
  health: datedDoc(HealthDay, 'server'),
} as const;

export type Kind = keyof typeof KINDS;
export type DocOf<K extends Kind> = z.infer<(typeof KINDS)[K]['schema']>;
export type ClientKind = { [K in Kind]: (typeof KINDS)[K]['writer'] extends 'client' ? K : never }[Kind];
export type ServerKind = Exclude<Kind, ClientKind>;
export type DatedKind = { [K in Kind]: (typeof KINDS)[K]['dated'] extends true ? K : never }[Kind];

export const KindName = z.enum(Object.keys(KINDS) as [Kind, ...Kind[]]);

export function isClientKind(kind: Kind): kind is ClientKind {
  return todo(`isClientKind(${kind})`);
}

export type Parsed<T> = { readonly ok: true; readonly doc: T } | { readonly ok: false; readonly reason: string };

/** The boundary parse for any document crossing the wire or coming out of storage. */
export function parseDoc<K extends Kind>(kind: K, raw: unknown): Parsed<DocOf<K>> {
  return todo(`parseDoc(${kind}, ${typeof raw})`);
}

/**
 * Bump when dexieStores() output changes. test/registry.test.ts pins the derived spec per
 * version, so changing an index without bumping fails the build instead of failing on the phone.
 */
export const CLIENT_DB_VERSION = 1;

/**
 * Dexie store spec derived from KINDS: `<kind>: 'id[, doc.date][, extra...]'`, plus the
 * replica's own `outbox: 'mutationId'` and `meta: 'key'` tables.
 */
export function dexieStores(): Record<string, string> {
  return todo('dexieStores');
}
