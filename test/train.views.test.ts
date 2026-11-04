/** The Train tab's reads over a real replica, so every date bound and index is the shipped one. */
import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openReplica, type Replica } from '../src/client/replica.js';
import { dayPreviewView, weekView, type WeekView } from '../src/client/views.js';
import { weighInId } from '../src/domain/body.js';
import type { Mutation } from '../src/domain/kinds.js';
import type { Performance } from '../src/domain/lifts.js';
import type { Program } from '../src/domain/program.js';
import type { Session } from '../src/domain/session.js';
import { T0, checklist, day, dayKey, kg, lb, lift, liftsBlock, minutes, ms, performance, program, session, sides, slot, slotId, target } from './training.fixtures.js';

const open: Replica[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.close();
});

async function replicaWith(docs: { readonly programs?: readonly Program[]; readonly sessions?: readonly Session[]; readonly performances?: readonly Performance[] }) {
  const { replica } = await openReplica({ name: 'train-views', indexedDB: new IDBFactory(), IDBKeyRange });
  open.push(replica);
  await put(replica, docs);
  return replica;
}

function put(replica: Replica, docs: { readonly programs?: readonly Program[]; readonly sessions?: readonly Session[]; readonly performances?: readonly Performance[] }) {
  return replica.commit([
    ...(docs.programs ?? []).map((doc): Mutation => ({ op: 'put', kind: 'program', doc })),
    ...(docs.sessions ?? []).map((doc): Mutation => ({ op: 'put', kind: 'session', doc })),
    ...(docs.performances ?? []).map((doc): Mutation => ({ op: 'put', kind: 'performance', doc })),
  ]);
}

const MONDAY = '2030-03-04';
const LATER = day('2030-03-07');
const benchDay = { key: 'push', label: 'Push', weekday: 1, blocks: [liftsBlock('main', [slot('a1', 'bench-press', 3)])] };
const rowDay = { key: 'pull', label: 'Pull', weekday: 4, blocks: [liftsBlock('main', [slot('b1', 'cable-row', 3)])] };
const pushed = (date: string) => session({ date: day(date), day: { key: dayKey('push'), label: 'Push' }, finishedAt: minutes(60) });

function required(week: WeekView | null): WeekView {
  if (week === null) throw new Error('expected a week');
  return week;
}

const doneOn = (week: WeekView, key: string) => week.days.find((d) => d.plan.key === key)?.doneOn;

describe('weekView', () => {
  it('is null before any version is in effect', async () => {
    const replica = await replicaWith({ programs: [program('2030-03-11', [benchDay])] });
    expect(await weekView(replica.read, LATER)).toBeNull();
  });

  it('keeps a day done when a version published mid-week replaces the plan', async () => {
    const done = pushed('2030-03-05');
    const monday = program(MONDAY, [benchDay, rowDay]);
    const midweek = program('2030-03-06', [{ ...benchDay, label: 'Push, renamed' }, rowDay], { publishedAt: ms(T0 + 1) });
    const replica = await replicaWith({ programs: [monday], sessions: [{ ...done, programId: monday.id }] });
    expect(doneOn(required(await weekView(replica.read, LATER)), 'push')).toBe('2030-03-05');
    await put(replica, { programs: [midweek] });
    const week = required(await weekView(replica.read, LATER));
    expect(week.days.map((d) => d.plan.label)).toEqual(['Push, renamed', 'Pull']);
    expect(doneOn(week, 'push')).toBe('2030-03-05');
    expect(week.suggested?.key).toBe('pull');
  });

  it('counts an imported session with no pin and a cardio-only one without crashing, and only in their week', async () => {
    const imported = session({ date: day('2030-03-05'), day: { key: dayKey('push'), label: 'Push' }, source: 'notion', startedAt: undefined });
    const cardio = session({ date: day('2030-03-06'), day: { key: dayKey('swim'), label: 'Swim' }, source: 'notion', note: 'Invented swim.', startedAt: undefined });
    const lastWeek = session({ date: day('2030-03-03'), day: { key: dayKey('pull'), label: 'Pull' }, source: 'notion', startedAt: undefined });
    const replica = await replicaWith({ programs: [program('2030-02-25', [benchDay, rowDay])], sessions: [imported, cardio, lastWeek] });
    const week = required(await weekView(replica.read, LATER));
    expect(week.done).toBe(2);
    expect(doneOn(week, 'push')).toBe('2030-03-05');
    expect(doneOn(week, 'pull')).toBeNull();
    expect(week.strip).toEqual([true, true]);
  });

  it('derives "no check-in" from no version this week, and a check-in once one takes effect', async () => {
    const before = program('2030-02-25', [benchDay], { report: { text: 'Old report.' } });
    const replica = await replicaWith({ programs: [before] });
    expect(required(await weekView(replica.read, LATER)).coach).toEqual({ kind: 'quiet' });
    await put(replica, { programs: [program(MONDAY, [benchDay, rowDay], { report: { text: 'This week.' } })] });
    const coach = required(await weekView(replica.read, LATER)).coach;
    expect(coach).toMatchObject({ kind: 'checked-in', report: { text: 'This week.' } });
    expect(coach.kind === 'checked-in' ? coach.changes.map((c) => c.target) : []).toEqual(['day:pull']);
  });

  it('holds the week\'s notes and leaves a day\'s note off it', async () => {
    const version = program(MONDAY, [benchDay], { notes: [{ text: 'For the week.' }, { text: 'For push.', day: dayKey('push') }, { text: 'Lapsed.', onlyWeek: day('2030-02-25') }] });
    const replica = await replicaWith({ programs: [version] });
    expect(required(await weekView(replica.read, LATER)).notes.map((n) => n.text)).toEqual(['For the week.']);
  });

  it('knows whether today has a weigh-in, and nothing about other days', async () => {
    const replica = await replicaWith({ programs: [program(MONDAY, [benchDay])] });
    const on = (date: string): Mutation => ({ op: 'put', kind: 'weighIn', doc: { id: weighInId(day(date)), date: day(date), kg: 80, loggedAt: ms(T0) } });
    await replica.commit([on('2030-03-06')]);
    expect(required(await weekView(replica.read, LATER)).weighedInToday).toBe(false);
    await replica.commit([on('2030-03-07')]);
    expect(required(await weekView(replica.read, LATER)).weighedInToday).toBe(true);
  });
});

describe('dayPreviewView', () => {
  const superset = liftsBlock('pair', [slot('a1', 'bench-press', 3, { target: target(3, 8, 12) }), slot('a2', 'cable-row', 3, { target: target(3, 8, 12, { perSide: 'left-first' }) })], { restSeconds: 75 });
  const version = program(MONDAY, [
    {
      key: 'push',
      blocks: [liftsBlock('extra', [slot('e1', 'crunch', 2)], { optional: true }), checklist('warm'), superset, checklist('retest', { onlyWeek: day('2030-02-25') })],
    },
  ]);
  const PUSH = dayKey('push');

  it('reads notes, then blocks with lapsed ones gone and optional ones last, for that day only', async () => {
    const replica = await replicaWith({ programs: [{ ...version, notes: [{ text: 'For push.', day: PUSH }, { text: 'For the week.' }] }] });
    const preview = await dayPreviewView(replica.read, PUSH, LATER);
    expect(preview?.notes.map((n) => n.text)).toEqual(['For push.']);
    expect(preview?.parts.map((p) => p.block.id)).toEqual(['warm', 'pair', 'extra']);
    expect(preview?.parts[1]?.superset).toEqual({ letter: 'A', rounds: 3 });
    expect(await dayPreviewView(replica.read, dayKey('legs'), LATER)).toBeNull();
  });

  it('shows last-time lines as typed, in kg, per side and under an alias', async () => {
    const withAlias = { ...version, lifts: version.lifts.map((l) => (l.id === 'bench-press' ? { ...l, aliases: [lift('flat-bench')] } : l)) };
    const replica = await replicaWith({
      programs: [withAlias],
      performances: [
        performance({ date: '2030-03-01', lift: 'flat-bench', sets: [kg(62.5, 8), kg(62.5, 8), kg(60, 6)] }),
        performance({ date: '2030-02-28', lift: 'cable-row', sets: [sides(30, 10, 9)] }),
        performance({ date: '2030-02-20', lift: 'cable-row', sets: [sides(25, 12, 12)] }),
      ],
    });
    const lasts = (await dayPreviewView(replica.read, PUSH, LATER))?.lasts;
    expect(lasts?.get(slotId('a1'))).toEqual({ date: '2030-03-01', line: '62.5/62.5/60 kg × 8/8/6', addWeight: false });
    expect(lasts?.get(slotId('a2'))).toEqual({ date: '2030-02-28', line: '30 lb × 10+9', addWeight: false });
    expect(lasts?.get(slotId('e1'))).toBeNull();
  });

  it('does not re-run when a set is logged today, while the week does', async () => {
    // A live query only runs where Dexie found a global indexedDB, which Node has none of.
    Object.assign(Dexie.dependencies, { indexedDB: new IDBFactory(), IDBKeyRange });
    const replica = await replicaWith({ programs: [version], performances: [performance({ date: '2030-03-01', lift: 'bench-press', sets: [lb(100, 8)] })] });
    let previewRuns = 0;
    const weeks: (WeekView | null)[] = [];
    const stopPreview = replica
      .live((r) => {
        previewRuns++;
        return dayPreviewView(r, PUSH, LATER);
      })
      .subscribe(() => undefined);
    const stopWeek = replica.live((r) => weekView(r, LATER)).subscribe((week) => weeks.push(week));
    await vi.waitFor(() => expect(weeks).toHaveLength(1));
    expect(weeks[0]?.done).toBe(0);

    const today = session({ date: LATER, day: { key: PUSH, label: 'Push' }, programId: version.id });
    await put(replica, { sessions: [today], performances: [performance({ session: today.id, date: LATER, slot: 'a1', lift: 'bench-press', sets: [lb(110, 8, 1)] })] });
    await vi.waitFor(() => expect(weeks.at(-1)?.done).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(previewRuns).toBe(1);
    stopPreview();
    stopWeek();
  });
});
