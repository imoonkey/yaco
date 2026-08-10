/** Blocking sleep for the lifecycle polling loops.
 *
 *  `agent start`'s readiness/session-id polls, tmux's input-empty gate, and the
 *  Stop-hook debounce are all synchronous read-decide-retry loops that must not
 *  yield to the event loop between iterations: a hook handler that returned to
 *  the loop mid-debounce would let a newer event's write land before the
 *  re-read that is supposed to detect it.
 *
 *  `Atomics.wait` on a lock nobody ever notifies is the portable way to say
 *  that. It parks the thread for the full duration without spinning the CPU and
 *  without a runtime-specific API. The buffer is module-scoped because the
 *  value is never read: index 0 stays 0 forever, so every `wait` sees the
 *  expected value and blocks until it times out.
 *
 *  Lifecycle-only, per the distribution design — this must never reach an
 *  exported read path, where a blocked thread is a stalled server.
 */

const PARK = new Int32Array(new SharedArrayBuffer(4));

/** Block the calling thread for `ms` milliseconds. A non-positive or
 *  non-finite duration returns immediately rather than parking forever, which
 *  is what `Atomics.wait` would do for `Infinity` and what a caller computing a
 *  remaining-time delta never means. */
export function sleepSync(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(PARK, 0, 0, ms);
}
