import { randomUUID } from 'node:crypto';
import type { Entry } from '../src/domain/diary.js';
import type { Food } from '../src/domain/food.js';
import { EntryId, FoodId, LocalDate, Millis } from '../src/domain/ids.js';
import { ClientId, MutationId, Rev, type SyncRequest, type WireMutation } from '../src/protocol.js';

export const newEntryId = (): EntryId => EntryId.parse(randomUUID());
export const newClientId = (): ClientId => ClientId.parse(randomUUID());
export const rev = (n: number): Rev => Rev.parse(n);
export const at = (ms: number): Millis => Millis.parse(ms);

export function entry(id: EntryId, kcal: number, date = '2026-10-28'): Entry {
  return {
    id,
    date: LocalDate.parse(date),
    meal: 'lunch',
    loggedAt: Millis.parse(1_800_000_000_000),
    food: { name: 'Quick add', unit: 'portion', nutrients: { kcal }, servings: [], origin: { kind: 'adhoc' } },
    quantity: { kind: 'amount', amount: 1 },
  };
}

export function food(id = FoodId.parse(randomUUID())): Food {
  return {
    id,
    name: 'Oats',
    unit: 'g',
    nutrients: { kcal: 380, protein: 13, carbs: 67, fat: 7 },
    servings: [{ label: '1 cup', amount: 80 }],
    barcodes: [],
    source: { kind: 'user' },
    archived: false,
  };
}

export const putEntry = (id: number, doc: Entry): WireMutation => ({
  op: 'put',
  id: MutationId.parse(id),
  kind: 'entry',
  docId: doc.id,
  doc,
});

export const deleteEntry = (id: number, docId: EntryId): WireMutation => ({
  op: 'delete',
  id: MutationId.parse(id),
  kind: 'entry',
  docId,
});

export function request(clientId: ClientId, mutations: WireMutation[], cursor = 0, epoch: string | null = null): SyncRequest {
  return { clientId, epoch, cursor: Rev.parse(cursor), mutations };
}
