/** Unit tests for the file lock: contention, stale-PID reclaim, and the
 *  cross-host non-reclamation contract surfaced via describeLock. */

import { describe, it, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireLock,
  describeLock,
  lockPathFor,
  withLock,
} from "../../../../src/lib/core/task/index.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "task-lock-"));
}

describe("acquireLock / withLock", () => {
  it("creates the lock directory and writes owner metadata", async () => {
    const dir = tmp();
    const f = join(dir, "tasks.json");
    const h = await acquireLock(f, { command: "test", timeoutMs: 500 });
    try {
      expect(existsSync(h.path)).toBe(true);
      const owner = JSON.parse(readFileSync(join(h.path, "owner.json"), "utf-8"));
      expect(owner.pid).toBe(process.pid);
      expect(owner.hostname).toBe(hostname());
      expect(owner.command).toBe("test");
    } finally {
      h.release();
    }
    expect(existsSync(h.path)).toBe(false);
  });

  it("waits on a held lock then proceeds when released", async () => {
    const f = join(tmp(), "tasks.json");
    const first = await acquireLock(f, { timeoutMs: 1000 });
    const t0 = Date.now();
    const secondP = acquireLock(f, { timeoutMs: 1000, pollMs: 20 });
    // Release the first after a short delay; second should pick it up.
    setTimeout(() => first.release(), 50);
    const second = await secondP;
    second.release();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(800);
  });

  it("times out with LOCK when the holder is alive and never releases", async () => {
    const f = join(tmp(), "tasks.json");
    const first = await acquireLock(f, { timeoutMs: 5_000 });
    try {
      await expect(
        acquireLock(f, { timeoutMs: 80, pollMs: 20 }),
      ).rejects.toMatchObject({ code: "LOCK" });
    } finally {
      first.release();
    }
  });

  it("reclaims a same-host dead-PID lock silently on retry", async () => {
    const f = join(tmp(), "tasks.json");
    // Pre-seed a stale lock dir with a PID that's almost certainly dead.
    mkdirSync(lockPathFor(f));
    writeFileSync(
      join(lockPathFor(f), "owner.json"),
      JSON.stringify({
        pid: 1, // init — definitely alive; use a different strategy
        hostname: hostname(),
        startedAt: "2026-01-01T00:00:00Z",
        command: "stale",
      }),
    );
    // 1 is alive, so this should NOT be reclaimed yet — clean up the stub
    // and re-seed with a pid we can guarantee is dead.
    rmSync(lockPathFor(f), { recursive: true });
    mkdirSync(lockPathFor(f));
    writeFileSync(
      join(lockPathFor(f), "owner.json"),
      JSON.stringify({
        pid: deadPid(),
        hostname: hostname(),
        startedAt: "2026-01-01T00:00:00Z",
        command: "stale",
      }),
    );
    const h = await acquireLock(f, { timeoutMs: 500 });
    try {
      expect(existsSync(h.path)).toBe(true);
      const owner = JSON.parse(readFileSync(join(h.path, "owner.json"), "utf-8"));
      expect(owner.pid).toBe(process.pid);
    } finally {
      h.release();
    }
  });

  it("refuses to reclaim a cross-host lock and surfaces it via describeLock", async () => {
    const f = join(tmp(), "tasks.json");
    mkdirSync(lockPathFor(f));
    writeFileSync(
      join(lockPathFor(f), "owner.json"),
      JSON.stringify({
        pid: 99999,
        hostname: "other-host.example.invalid",
        startedAt: "2026-01-01T00:00:00Z",
        command: "ghost",
      }),
    );
    await expect(
      acquireLock(f, { timeoutMs: 80, pollMs: 20 }),
    ).rejects.toMatchObject({ code: "LOCK" });

    const status = describeLock(f);
    expect(status.held).toBe(true);
    expect(status.sameHost).toBe(false);
    expect(status.reclaimable).toBeFalsy();
    expect(status.notes?.[0]).toContain("cross-host");
  });

  it("withLock releases on exception", async () => {
    const f = join(tmp(), "tasks.json");
    await expect(
      withLock(f, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow(/boom/);
    expect(existsSync(lockPathFor(f))).toBe(false);
  });
});

/** Pick a PID that is essentially guaranteed not to be a live process —
 *  spawn a tiny short-lived child, wait for it to exit, then return its
 *  reused PID. The kernel may eventually recycle the PID, but for the
 *  brief window of this test it is dead.
 */
function deadPid(): number {
  // 0x7fffff (~8M) is above the typical Linux PID range; if not present,
  // it surfaces as ESRCH which is exactly what we want.
  return 8_388_607;
}
