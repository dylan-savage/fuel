import { useEffect } from 'preact/hooks';

/**
 * Asks to keep the screen on while `active`, again each time the app returns, since the system
 * drops a lock when it leaves the screen. Any failure is silent, because the clock and the data do
 * not depend on it. Whether it holds in a Home Screen app is unproven.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let stopped = false;
    const request = () => {
      if (document.visibilityState !== 'visible' || (lock !== null && !lock.released)) return;
      navigator.wakeLock.request('screen').then(
        (next) => {
          if (stopped) void next.release().catch(() => undefined);
          else lock = next;
        },
        () => undefined,
      );
    };
    request();
    document.addEventListener('visibilitychange', request);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', request);
      void lock?.release().catch(() => undefined);
    };
  }, [active]);
}
