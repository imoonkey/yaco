/** `sleepSync` — the blocking sleep the lifecycle polling loops run on.
 *
 *  Two properties matter and neither is observable from the call sites: it must
 *  actually block the thread (a loop that yields would let a newer event's
 *  write land mid-debounce), and it must return immediately rather than park
 *  forever when a caller hands it a non-positive remaining-time delta.
 */
import { describe, it, expect } from "vitest";
import { sleepSync } from "../../../src/lib/core/sleep.ts";

describe("sleepSync", () => {
  it("blocks for at least the requested duration", () => {
    const started = Date.now();
    sleepSync(120);
    expect(Date.now() - started).toBeGreaterThanOrEqual(115);
  });

  it("blocks the thread rather than yielding to the event loop", async () => {
    // A timer queued before the sleep cannot run until the sleep returns, so
    // the callback observes the full duration as elapsed. A yielding sleep
    // would let it fire at ~0ms.
    let firedAfterMs = -1;
    const queuedAt = Date.now();
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        firedAfterMs = Date.now() - queuedAt;
        resolve();
      }, 0);
    });
    sleepSync(120);
    await timer;
    expect(firedAfterMs).toBeGreaterThanOrEqual(115);
  });

  it("returns immediately for a non-positive or non-finite duration", () => {
    const started = Date.now();
    for (const ms of [0, -1, -1000, Number.NaN, Number.POSITIVE_INFINITY]) {
      sleepSync(ms);
    }
    expect(Date.now() - started).toBeLessThan(50);
  });
});
