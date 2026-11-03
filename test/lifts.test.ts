import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LocalDate, addDays, isMonday, mondayOf } from '../src/domain/ids.js';
import { Performance, liftBook, liftIdOf, performanceId, type Lift } from '../src/domain/lifts.js';
import { day, lb, lift, newSessionId, performance, slotId } from './training.fixtures.js';

describe('mondayOf', () => {
  it.each([
    ['2030-03-04', '2030-03-04'],
    ['2030-03-05', '2030-03-04'],
    ['2030-03-10', '2030-03-04'],
    ['2030-03-11', '2030-03-11'],
    ['2031-01-01', '2030-12-30'],
  ])('puts %s in the week of %s', (date, monday) => {
    expect(mondayOf(day(date))).toBe(monday);
  });

  it('always lands on a Monday within the six days before', () => {
    const anyDate = fc.date({ min: new Date('2000-01-01'), max: new Date('2100-01-01'), noInvalidDate: true }).map((d) => LocalDate.parse(d.toISOString().slice(0, 10)));
    fc.assert(
      fc.property(anyDate, (date) => {
        const monday = mondayOf(date);
        expect(isMonday(monday)).toBe(true);
        expect(monday <= date).toBe(true);
        expect(addDays(monday, 6) >= date).toBe(true);
      }),
    );
  });
});

describe('liftIdOf', () => {
  it.each([
    ['Bench press', 'bench-press'],
    ['  Bench   Press!! ', 'bench-press'],
    ['Seated row (wide grip)', 'seated-row'],
    ['Seated row (close grip)', 'seated-row'],
    ['Crème brûlée curl', 'creme-brulee-curl'],
  ])('slugs %j to %s', (name, slug) => {
    expect(liftIdOf(name)).toBe(slug);
  });

  it('gives null when nothing is left to slug', () => {
    expect(liftIdOf('(wide)')).toBeNull();
    expect(liftIdOf('  !! ')).toBeNull();
  });

  it('keeps a long name a valid slug', () => {
    expect(liftIdOf(`${'a'.repeat(59)} b c`)).toBe('a'.repeat(59));
  });
});

describe('liftBook', () => {
  const catalog: readonly Lift[] = [
    { id: lift('squat'), name: 'Squat', aliases: [lift('back-squat'), lift('high-bar-squat')] },
    { id: lift('curl'), name: 'Curl', aliases: [] },
  ];
  const book = liftBook(catalog);

  it('resolves an alias to its lift and unions the histories', () => {
    expect(book.canonical(lift('back-squat'))).toBe('squat');
    expect(book.members(lift('back-squat'))).toEqual(['squat', 'back-squat', 'high-bar-squat']);
    expect(book.nameOf(lift('high-bar-squat'))).toBe('Squat');
  });

  it('treats a name it has never heard of as its own lift', () => {
    const typed = lift('landmine-press');
    expect(book.canonical(typed)).toBe(typed);
    expect(book.members(typed)).toEqual([typed]);
    expect(book.has(typed)).toBe(false);
    expect(book.nameOf(typed)).toBeUndefined();
  });
});

describe('Performance', () => {
  const sessionId = newSessionId();
  const row = performance({ session: sessionId, slot: 'a1', lift: 'bench-press', sets: [lb(100, 8)] });

  it('derives its id from session, slot and lift', () => {
    expect(row.id).toBe(`pf:${sessionId}:a1:bench-press`);
    expect(Performance.safeParse(row).success).toBe(true);
    expect(Performance.safeParse({ ...row, id: `pf:${sessionId}:a2:bench-press` }).success).toBe(false);
  });

  it('gives an added exercise an id no slot can collide with', () => {
    expect(performanceId(sessionId, undefined, lift('curl'))).toBe(`pf:${sessionId}::curl`);
    expect(performanceId(sessionId, slotId('extra'), lift('curl'))).not.toBe(performanceId(sessionId, undefined, lift('curl')));
  });

  it('must hold a set', () => {
    expect(Performance.safeParse({ ...row, sets: [] }).success).toBe(false);
  });

  it('names a planned lift only when it differs from the lift done', () => {
    expect(Performance.safeParse({ ...row, plannedLiftId: lift('incline-press') }).success).toBe(true);
    expect(Performance.safeParse({ ...row, plannedLiftId: lift('bench-press') }).success).toBe(false);
  });

  it('refuses a range whose bottom is above its top', () => {
    expect(Performance.safeParse({ ...row, target: { sets: 3, reps: { min: 12, max: 8 } } }).success).toBe(false);
  });

  it('lets a per-side target name no starting side, and nothing else new', () => {
    expect(Performance.safeParse({ ...row, target: { sets: 3, reps: { min: 8, max: 12 }, perSide: 'either' } }).success).toBe(true);
    expect(Performance.safeParse({ ...row, target: { sets: 3, reps: { min: 8, max: 12 }, perSide: 'both' } }).success).toBe(false);
  });
});
