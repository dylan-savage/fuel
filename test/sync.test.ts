import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openReplica } from '../src/client/replica.js';
import { OfflineError, startSync, type SyncHandle, type SyncState, type Transport } from '../src/client/sync.js';
import { openStore } from '../src/server/store.js';
import { at, entry, newClientId, newEntryId, request } from './fixtures.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

async function setup(transportFor: (deliver: Transport) => Transport) {
  const server = openStore(':memory:');
  const { replica, port } = await openReplica({ name: 'sync-test', indexedDB: new IDBFactory(), IDBKeyRange });
  const deliver: Transport = (req) => Promise.resolve(server.sync(req, { now: at(1), userAgent: null }));
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as const });
  const sync = startSync(port, replica, {
    transport: transportFor(deliver),
    window: win,
    document: doc,
    debounceMs: 5,
    backoffMs: { base: 60_000, max: 60_000 },
  });
  const states: SyncState[] = [];
  sync.state.subscribe((s) => states.push(s));
  cleanup.push(() => {
    sync.stop();
    replica.close();
    server.close();
  });
  const serverDocIds = () => server.sync(request(newClientId(), []), { now: at(1), userAgent: null }).changes.map((c) => c.id);
  return { replica, sync, win, states, serverDocIds };
}

const idle = (sync: SyncHandle) =>
  vi.waitFor(() => {
    let state: SyncState | undefined;
    sync.state.subscribe((s) => (state = s))();
    expect(state?.kind).toBe('idle');
  });

describe('startSync', () => {
  it('pushes a commit to the server without being asked', async () => {
    const { replica, sync, serverDocIds } = await setup((deliver) => deliver);
    await idle(sync);
    const doc = entry(newEntryId(), 300);
    await replica.commit([{ op: 'put', kind: 'entry', doc }]);
    await vi.waitFor(() => expect(serverDocIds()).toEqual([doc.id]));
    expect(await replica.read.pendingCount()).toBe(0);
  });

  it('keeps writes queued while offline and sends them when the browser comes back online', async () => {
    let online = false;
    const { replica, win, states, serverDocIds } = await setup((deliver) => (req) => {
      if (!online) return Promise.reject(new OfflineError('no route'));
      return deliver(req);
    });
    await replica.commit([{ op: 'put', kind: 'entry', doc: entry(newEntryId(), 120) }]);
    await vi.waitFor(() => expect(states.at(-1)?.kind).toBe('offline'));
    expect(await replica.read.pendingCount()).toBe(1);

    online = true;
    win.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(serverDocIds()).toHaveLength(1));
    await vi.waitFor(() => expect(states.at(-1)?.kind).toBe('idle'));
    expect(await replica.read.pendingCount()).toBe(0);
  });

  it('never runs two rounds at once', async () => {
    let active = 0;
    let maxActive = 0;
    const { sync } = await setup((deliver) => async (req) => {
      maxActive = Math.max(maxActive, ++active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return deliver(req);
    });
    await Promise.all([sync.run(), sync.run(), sync.run()]);
    expect(maxActive).toBe(1);
  });
});
