/**
 * Injectable clock seam — route every time-based decision through `now()`
 * so tests can freeze/speed time and verify scheduling.
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
