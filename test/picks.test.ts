import { describe, expect, it } from 'vitest';
import { liftBook, type Lift } from '../src/domain/lifts.js';
import { pickList, type PickFor } from '../src/domain/picks.js';
import { bw, lb, lift, performance } from './training.fixtures.js';

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
