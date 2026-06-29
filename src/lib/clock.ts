/**
 * Injectable clock seam — route every time-based decision through `now()`
 * so tests can freeze/speed time and verify scheduling.
 *
 * Also provides a timer registry for proactive turn-timeout scheduling.
 * Timers fire even with zero chat activity (not just reactive).
 */

let _now: () => number = () => Date.now();

/** Return current epoch ms. */
export function now(): number {
  return _now();
}

/** Override the clock. Test-only; NEVER call from handler code. */
export function _setClock(fn: () => number): void {
  _now = fn;
}

/** Restore real clock. */
export function _resetClock(): void {
  _now = () => Date.now();
}

/** Default turn timeout in ms (60s). */
export const TURN_TIMEOUT_MS = 60_000;

// ---- proactive timer registry ----

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Schedule a proactive timeout callback for a room. Fires even when no
 * chat messages arrive. Replaces any existing timer for the same room.
 *
 * `api` is the grammY Bot API instance used to send timeout messages.
 * Tests can mock this by passing a no-op `api`.
 */
export function scheduleGameTimer(
  rid: string,
  callback: () => void | Promise<void>,
  delayMs: number,
): void {
  clearGameTimer(rid);
  const handle = setTimeout(() => {
    timers.delete(rid);
    void callback();
  }, delayMs);
  timers.set(rid, handle);
}

/** Cancel a previously scheduled game timer for this room. */
export function clearGameTimer(rid: string): void {
  const handle = timers.get(rid);
  if (handle) {
    clearTimeout(handle);
    timers.delete(rid);
  }
}

/** Remove all timers. Test-only. */
export function _clearAllTimers(): void {
  for (const h of timers.values()) clearTimeout(h);
  timers.clear();
}

/** How many timers are currently scheduled? Test-only. */
export function _timerCount(): number {
  return timers.size;
}