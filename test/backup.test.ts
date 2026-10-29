import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupIfDue } from '../src/server/backup.js';
import { openStore } from '../src/server/store.js';
import { at, entry, newClientId, newEntryId, putEntry, request } from './fixtures.js';

const tempDir = () => mkdtempSync(join(tmpdir(), 'fuel-backup-'));

describe('backupIfDue', () => {
  it('writes a restorable copy once per day', async () => {
    const store = openStore(join(tempDir(), 'fuel.db'));
    const doc = entry(newEntryId(), 512);
    store.sync(request(newClientId(), [putEntry(1, doc)]), { now: at(1), userAgent: null });
    const dir = tempDir();

    const file = await backupIfDue({ store, dir, keep: 30 }, '2026-10-28');
    expect(await backupIfDue({ store, dir, keep: 30 }, '2026-10-28')).toBeNull();
    store.close();

    expect(file).toBe(join(dir, 'fuel-2026-10-28.db'));
    const restored = openStore(join(dir, 'fuel-2026-10-28.db'));
    expect(restored.sync(request(newClientId(), []), { now: at(2), userAgent: null }).changes.map((c) => c.doc)).toEqual([doc]);
    restored.close();
  });

  it('keeps only the newest files', async () => {
    const store = openStore(':memory:');
    const dir = tempDir();
    for (const day of ['2026-10-01', '2026-10-02', '2026-10-03']) writeFileSync(join(dir, `fuel-${day}.db`), '');
    writeFileSync(join(dir, 'notes.txt'), '');
    await backupIfDue({ store, dir, keep: 2 }, '2026-10-04');
    store.close();
    expect(readdirSync(dir).sort()).toEqual(['fuel-2026-10-03.db', 'fuel-2026-10-04.db', 'notes.txt']);
  });
});
