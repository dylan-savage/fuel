import { describe, expect, it } from 'vitest';
import { Muscle, liftBook, type Lift, type LiftBook } from '../src/domain/lifts.js';
import { pickList, type PickFor } from '../src/domain/picks.js';
import { bw, lb, lift, performance, slot } from './training.fixtures.js';

const catalog: readonly Lift[] = [
  { id: lift('bench-press'), name: 'Bench press', aliases: [] },
  { id: lift('calf-raise'), name: 'Calf raise', aliases: [lift('standing-calf-raise')] },
  { id: lift('cable-row'), name: 'Cable row', aliases: [] },
  { id: lift('leg-press'), name: 'Leg press', aliases: [] },
  { id: lift('pin-press'), name: 'Pin press', aliases: [lift('rack-press')] },
  { id: lift('seal-row'), name: 'Seal row', aliases: [] },
];
const book = liftBook(catalog);
const ids = (choices: readonly { readonly liftId: string }[]) => choices.map((choice) => choice.liftId);

/** A row from this day's sessions, with no slot as an added exercise has. */
const addedThere = (name: string, date: string) => performance({ lift: name, date, sets: [bw(20)] });

describe('pickList for Add exercise', () => {
  const add: PickFor = { kind: 'add', onDay: [lift('bench-press'), lift('cable-row')] };
  const pick = (query = '', dayHistory = [addedThere('leg-press', '2030-02-18'), addedThere('standing-calf-raise', '2030-02-25')], newest = [performance({ lift: 'zottman-curl', label: 'Zottman curl', date: '2030-01-07', sets: [lb(20, 10)] })]) =>
    pickList({ pickFor: add, lifts: catalog, book, newest, dayHistory, query });

  it('suggests what he added to this day before, newest first, under the catalog\'s name', () => {
    expect(pick().suggested).toEqual([
      { liftId: lift('calf-raise'), label: 'Calf raise' },
      { liftId: lift('leg-press'), label: 'Leg press' },
    ]);
  });

  it('lists everything else A–Z, his logged names included, never a suggestion or a lift on the day', () => {
    expect(ids(pick().others)).toEqual(['pin-press', 'seal-row', 'zottman-curl']);
  });

  it('suggests nothing with no history here, and still lists every lift', () => {
    const fresh = pick('', [], []);
    expect(fresh.suggested).toEqual([]);
    expect(ids(fresh.others)).toEqual(['calf-raise', 'leg-press', 'pin-press', 'seal-row']);
  });

  it('never suggests a lift he added before that is on the day now', () => {
    expect(ids(pick('', [addedThere('cable-row', '2030-02-25')]).suggested)).toEqual([]);
  });

  it('filters both lists in place by name or alias, keeping their order', () => {
    expect(pick('press')).toMatchObject({ suggested: [{ liftId: 'leg-press' }], others: [{ liftId: 'pin-press' }] });
    expect(pick('rack press')).toMatchObject({ suggested: [], others: [{ liftId: 'pin-press' }], typed: null });
    expect(ids(pick('ZOTTMAN').others)).toEqual(['zottman-curl']);
  });

  it('offers the search as a new lift only when nothing offered is it', () => {
    expect(pick(' Tib raise (wall) ').typed).toEqual({ liftId: lift('tib-raise'), label: 'Tib raise (wall)' });
    expect(pick('Zottman curl').typed).toBeNull();
    expect(pick('Standing calf raise').typed).toBeNull();
    expect(pick('Bench press').typed, 'a lift already on the day').toBeNull();
    expect(pick('!!!').typed).toBeNull();
  });
});

describe('pickList for Swap', () => {
  const chest = Muscle.parse('chest');
  const back = Muscle.parse('back');
  const lifts: readonly Lift[] = [
    { id: lift('bench-press'), name: 'Bench press', aliases: [], muscle: chest },
    { id: lift('cable-fly'), name: 'Cable fly', aliases: [], muscle: chest },
    { id: lift('dip'), name: 'Dip', aliases: [], muscle: chest },
    { id: lift('landmine-press'), name: 'Landmine press', aliases: [], muscle: chest },
    { id: lift('machine-press'), name: 'Machine press', aliases: [], muscle: chest },
    { id: lift('pec-deck'), name: 'Pec deck', aliases: [], muscle: chest },
    { id: lift('push-up'), name: 'Push-up', aliases: [], muscle: chest },
    { id: lift('seal-row'), name: 'Seal row', aliases: [], muscle: back },
  ];
  const tagged = liftBook(lifts);
  const press = slot('a1', 'bench-press', 3, { label: 'Flat bench', swaps: [{ liftId: lift('landmine-press'), label: 'Landmine (half kneeling)' }] });
  const swapFor = (current = press.liftId): PickFor => ({ kind: 'swap', slot: press, current });
  const newest = [performance({ lift: 'push-up', date: '2030-02-26', sets: [bw(20)] }), performance({ lift: 'dip', date: '2030-02-20', sets: [bw(10)] })];
  const inSlot = (name: string, date: string) => performance({ slot: 'a1', lift: name, planned: 'bench-press', date, sets: [lb(100, 8)] });
  const dayHistory = [inSlot('pec-deck', '2030-02-18'), inSlot('cable-fly', '2030-02-25')];
  const pick = (input: { readonly current?: typeof press.liftId; readonly query?: string; readonly book?: LiftBook; readonly history?: readonly ReturnType<typeof performance>[] } = {}) =>
    pickList({ pickFor: swapFor(input.current), lifts, book: input.book ?? tagged, newest, dayHistory: input.history ?? dayHistory, query: input.query ?? '' });

  it('suggests the listed swap with its plan label, what he did here before, then the same muscle by when he last did it', () => {
    expect(pick().suggested).toEqual([
      { liftId: lift('landmine-press'), label: 'Landmine (half kneeling)' },
      { liftId: lift('cable-fly'), label: 'Cable fly' },
      { liftId: lift('pec-deck'), label: 'Pec deck' },
      { liftId: lift('push-up'), label: 'Push-up' },
      { liftId: lift('dip'), label: 'Dip' },
      { liftId: lift('machine-press'), label: 'Machine press' },
    ]);
  });

  it('offers the plan\'s lift first once he has left it, and never the one he is on', () => {
    const onDeck = pick({ current: lift('pec-deck') });
    expect(onDeck.suggested[0]).toEqual({ liftId: lift('bench-press'), label: 'Flat bench' });
    expect(ids([...onDeck.suggested, ...onDeck.others])).not.toContain('pec-deck');
  });

  it('stops alike lifts at eight suggestions, and lists the rest A–Z after them', () => {
    const many: readonly Lift[] = [...lifts, ...['arnold-press', 'chest-press', 'floor-press', 'svend-press'].map((id) => ({ id: lift(id), name: id, aliases: [], muscle: chest }))];
    const list = pickList({ pickFor: swapFor(), lifts: many, book: liftBook(many), newest, dayHistory, query: '' });
    expect(ids(list.suggested)).toEqual(['landmine-press', 'cable-fly', 'pec-deck', 'push-up', 'dip', 'arnold-press', 'chest-press', 'floor-press']);
    expect(ids(list.others)).toEqual(['machine-press', 'seal-row', 'svend-press']);
  });

  it('never repeats a suggestion in the rest, which run A–Z', () => {
    const { suggested, others } = pick();
    expect(ids(others)).toEqual(['seal-row']);
    expect(ids(others).filter((id) => ids(suggested).includes(id))).toEqual([]);
  });

  it('with no muscle placed anywhere, suggests the plan\'s own and his history, and lists the rest', () => {
    const untagged = liftBook(lifts.map(({ muscle: _muscle, ...lift }) => lift));
    const list = pick({ book: untagged });
    expect(ids(list.suggested)).toEqual(['landmine-press', 'cable-fly', 'pec-deck']);
    expect(ids(list.others)).toEqual(['dip', 'machine-press', 'push-up', 'seal-row']);
  });

  it('filters suggestions by search in place, and still names a new lift', () => {
    expect(ids(pick({ query: 'press' }).suggested)).toEqual(['landmine-press', 'machine-press']);
    expect(pick({ query: 'Zottman press (seated)' })).toMatchObject({ suggested: [], others: [], typed: { liftId: 'zottman-press', label: 'Zottman press (seated)' } });
    expect(pick({ query: 'Bench press' }).typed, 'the lift he is on').toBeNull();
  });
});

describe('pickList for Add exercise, with muscles placed', () => {
  const lifts: readonly Lift[] = [
    { id: lift('leg-press'), name: 'Leg press', aliases: [], muscle: Muscle.parse('quads') },
    { id: lift('hack-squat'), name: 'Hack squat', aliases: [], muscle: Muscle.parse('quads') },
    { id: lift('calf-raise'), name: 'Calf raise', aliases: [], muscle: Muscle.parse('calves') },
    { id: lift('seal-row'), name: 'Seal row', aliases: [], muscle: Muscle.parse('back') },
  ];

  it('ranks lifts for the day\'s muscles after what he added here before', () => {
    const list = pickList({ pickFor: { kind: 'add', onDay: [lift('leg-press')] }, lifts, book: liftBook(lifts), newest: [], dayHistory: [addedThere('calf-raise', '2030-02-25')], query: '' });
    expect(ids(list.suggested)).toEqual(['calf-raise', 'hack-squat']);
    expect(ids(list.others)).toEqual(['seal-row']);
  });
});
