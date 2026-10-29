import { randomUUID } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { createIntents } from '../src/client/intents.js';
import { openReplica, type Replica } from '../src/client/replica.js';
import { dayView } from '../src/client/views.js';
import { quickAddItem } from '../src/domain/food.js';
import { LocalDate } from '../src/domain/ids.js';
import { at } from './fixtures.js';

const today = LocalDate.parse('2026-10-28');
const slot = { date: today, meal: 'lunch' } as const;
const open: Replica[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.close();
});

async function setup() {
  const { replica } = await openReplica({ name: 'intents', indexedDB: new IDBFactory(), IDBKeyRange });
  open.push(replica);
  return { replica, intents: createIntents(replica, { now: () => at(1_800_000_000_000), newId: randomUUID }) };
}

describe('intents', () => {
  it('logs quick adds into the day and its kcal total, queued for the mini', async () => {
    const { replica, intents } = await setup();
    await intents.logItems([quickAddItem('Burrito', { kcal: 900 }), quickAddItem('', { kcal: 150 })], slot);
    const day = await dayView(replica.read, today);
    expect(day.entries.map((e) => e.food.name)).toEqual(['Burrito', 'Quick add']);
    expect(day.totals.sum.kcal).toBe(1050);
    expect(day.totals.incomplete.has('protein')).toBe(true);
    expect(await replica.read.pendingCount()).toBe(2);
  });

  it('deletes an entry and puts it back on undo', async () => {
    const { replica, intents } = await setup();
    const [id] = await intents.logItems([quickAddItem('Latte', { kcal: 190 })], slot);
    if (!id) throw new Error('nothing logged');
    const undo = await intents.deleteEntry(id);
    expect((await dayView(replica.read, today)).entries).toEqual([]);
    await undo();
    expect((await dayView(replica.read, today)).entries.map((e) => e.id)).toEqual([id]);
  });

  it('keeps other days out of the day view', async () => {
    const { replica, intents } = await setup();
    await intents.logItems([quickAddItem('Yesterday', { kcal: 100 })], { date: LocalDate.parse('2026-10-27'), meal: 'dinner' });
    expect((await dayView(replica.read, today)).entries).toEqual([]);
  });
});
