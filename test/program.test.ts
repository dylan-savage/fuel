import { describe, expect, it } from 'vitest';
import { Program, dayNotesFor, dayParts, notesFor, plannedDay, programOn, stepsOf, type Block, type LiftsBlock, type PlannedDay } from '../src/domain/program.js';
import { checklist, day, dayKey, liftsBlock, program, slot } from './training.fixtures.js';

const PUSH = dayKey('push');

function stepNames(block: LiftsBlock) {
  return stepsOf(block).map((s) => `${s.slot.id}.${s.round}${s.endsRound ? ' rest' : ''}`);
}

describe('stepsOf', () => {
  it('walks straight sets as the one-slot case, resting after every set', () => {
    expect(stepNames(liftsBlock('a', [slot('a1', 'bench-press', 3)]))).toEqual(['a1.1 rest', 'a1.2 rest', 'a1.3 rest']);
  });

  it('walks a superset A1, A2, rest', () => {
    const block = liftsBlock('a', [slot('a1', 'bench-press', 2), slot('a2', 'cable-row', 2)]);
    expect(stepNames(block)).toEqual(['a1.1', 'a2.1 rest', 'a1.2', 'a2.2 rest']);
  });

  it('drops a 2-set slot out of the last round of 3, and the round still rests', () => {
    const block = liftsBlock('a', [slot('a1', 'bench-press', 3), slot('a2', 'cable-row', 2)]);
    expect(stepNames(block)).toEqual(['a1.1', 'a2.1 rest', 'a1.2', 'a2.2 rest', 'a1.3 rest']);
  });

  it('rests after the first slot in the last round when the 2-set slot comes first', () => {
    const block = liftsBlock('a', [slot('a1', 'cable-row', 2), slot('a2', 'bench-press', 3)]);
    expect(stepNames(block)).toEqual(['a1.1', 'a2.1 rest', 'a1.2', 'a2.2 rest', 'a2.3 rest']);
  });
});

describe('plannedDay', () => {
  const retest: Block = liftsBlock('retest', [slot('r1', 'goblet-squat', 1)], { onlyWeek: day('2030-03-11') });
  const main: Block = liftsBlock('main', [slot('a1', 'bench-press', 3)]);
  const version = program('2030-03-04', [{ key: 'push', blocks: [main, retest] }]);

  const blockIds = (date: string) => plannedDay(version, PUSH, day(date))?.blocks.map((b) => b.id);

  it('shows a one-week block in its week only, and it lapses with no write', () => {
    expect(blockIds('2030-03-10')).toEqual(['main']);
    expect(blockIds('2030-03-11')).toEqual(['main', 'retest']);
    expect(blockIds('2030-03-17')).toEqual(['main', 'retest']);
    expect(blockIds('2030-03-18')).toEqual(['main']);
  });

  it('answers undefined for a day the version does not hold', () => {
    expect(plannedDay(version, dayKey('legs'), day('2030-03-11'))).toBeUndefined();
  });

  it('answers undefined for a day whose only blocks belong to other weeks', () => {
    const oneOff = program('2030-03-04', [{ key: 'push', blocks: [checklist('warm', { onlyWeek: day('2030-03-11') })] }]);
    expect(plannedDay(oneOff, PUSH, day('2030-03-11'))?.blocks).toHaveLength(1);
    expect(plannedDay(oneOff, PUSH, day('2030-03-18'))).toBeUndefined();
  });
});

describe('dayParts', () => {
  const planOf = (...blocks: Block[]): PlannedDay => ({ key: PUSH, label: 'Push', minutes: undefined, blocks });

  it('puts optional blocks last and keeps the rest in the order planned', () => {
    const parts = dayParts(planOf(checklist('warm'), liftsBlock('extra', [slot('e1', 'crunch', 2)], { optional: true }), liftsBlock('main', [slot('a1', 'bench-press', 3)])));
    expect(parts.map((part) => part.block.id)).toEqual(['warm', 'main', 'extra']);
  });

  it('letters the supersets in reading order and counts rounds to the largest set count', () => {
    const parts = dayParts(
      planOf(
        liftsBlock('straight', [slot('a1', 'bench-press', 4)]),
        liftsBlock('first', [slot('b1', 'cable-row', 3), slot('b2', 'face-pull', 2)]),
        checklist('warm'),
        liftsBlock('second', [slot('c1', 'squat', 2), slot('c2', 'crunch', 2)]),
      ),
    );
    expect(parts.map((part) => part.superset)).toEqual([null, { letter: 'A', rounds: 3 }, null, { letter: 'B', rounds: 2 }]);
  });
});

describe('notesFor', () => {
  it('lapses a one-week note the same way as a block, and keeps a standing one', () => {
    const version = program('2030-03-04', [{ key: 'push', blocks: [checklist('warm')] }], {
      notes: [{ text: 'Deload this week.', onlyWeek: day('2030-03-11') }, { text: 'Sleep comes first.' }],
    });
    expect(notesFor(version, day('2030-03-13')).map((n) => n.text)).toEqual(['Deload this week.', 'Sleep comes first.']);
    expect(notesFor(version, day('2030-03-18')).map((n) => n.text)).toEqual(['Sleep comes first.']);
  });

  it('keeps a note naming a day off the week and on that day alone, lapsing the same way', () => {
    const version = program('2030-03-04', [{ key: 'push', blocks: [checklist('warm')] }, { key: 'pull', blocks: [checklist('warm')] }], {
      notes: [{ text: 'For the week.' }, { text: 'Bring chalk.', day: PUSH }, { text: 'Light this time.', day: PUSH, onlyWeek: day('2030-03-11') }],
    });
    expect(notesFor(version, day('2030-03-13')).map((n) => n.text)).toEqual(['For the week.']);
    expect(dayNotesFor(version, PUSH, day('2030-03-13')).map((n) => n.text)).toEqual(['Bring chalk.', 'Light this time.']);
    expect(dayNotesFor(version, PUSH, day('2030-03-18')).map((n) => n.text)).toEqual(['Bring chalk.']);
    expect(dayNotesFor(version, dayKey('pull'), day('2030-03-13'))).toEqual([]);
  });
});

describe('programOn', () => {
  const first = program('2030-03-04', [{ key: 'push', blocks: [checklist('warm')] }]);
  const second = program('2030-03-11', [{ key: 'push', blocks: [checklist('warm')] }]);

  it('chooses the version across two Mondays, whatever order they arrive in', () => {
    for (const versions of [
      [first, second],
      [second, first],
    ]) {
      expect(programOn(versions, day('2030-03-03'))).toBeUndefined();
      expect(programOn(versions, day('2030-03-04'))?.id).toBe(first.id);
      expect(programOn(versions, day('2030-03-10'))?.id).toBe(first.id);
      expect(programOn(versions, day('2030-03-11'))?.id).toBe(second.id);
      expect(programOn(versions, day('2031-01-01'))?.id).toBe(second.id);
    }
  });
});

describe('Program', () => {
  const version = program('2030-03-04', [{ key: 'push', blocks: [checklist('warm')] }]);

  it('derives its id from its date', () => {
    expect(version.id).toBe('p:2030-03-04');
    expect(Program.safeParse(version).success).toBe(true);
    expect(Program.safeParse({ ...version, id: 'p:2030-03-05' }).success).toBe(false);
  });
});
