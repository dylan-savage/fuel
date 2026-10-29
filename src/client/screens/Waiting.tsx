import { useLive, useSyncState, waitingView } from '../views.js';

/** "N waiting" while writes sit in the outbox; the reason when sync is failing. */
export function Waiting() {
  const waiting = useLive(waitingView, []);
  const sync = useSyncState();
  if (!waiting) return null;
  const why = sync?.kind === 'offline' ? 'offline' : sync?.kind === 'error' ? sync.message : null;
  return (
    <span class="badge" role="status" title={why ?? undefined}>
      {waiting} waiting
    </span>
  );
}
