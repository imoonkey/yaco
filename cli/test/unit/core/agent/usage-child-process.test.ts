/** The app-server child's process plumbing, where the runtime reports failures
 *  somewhere other than the call that caused them.
 *
 *  `usage-subprocess.test.ts` covers what the command *says* about a broken
 *  `codex`. This file covers the way it could stop saying anything at all: a
 *  write to a pipe with no reader, which on Node 24 emits `EPIPE` on the
 *  child's stdin and crashes the process unless something is listening. Both
 *  tests drive the real spawn helper, because a child that is not there is
 *  exactly what the command needs a real `codex` to get past.
 */
import { describe, it, expect, afterEach, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _spawnCodexAppServerForTests } from "../../../../src/lib/core/agent/providers/usage.ts";

const TMP: string[] = [];

afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

describe("writing to a codex child that is not there", () => {
  const ORIGINAL_PATH = process.env["PATH"];
  afterEach(() => {
    if (ORIGINAL_PATH === undefined) delete process.env["PATH"];
    else process.env["PATH"] = ORIGINAL_PATH;
  });

  /** Spawn the real helper against a PATH holding no `codex`, so the child
   *  never starts and its stdin has no reader. */
  function spawnWithoutCodex() {
    const root = mkdtempSync(join(tmpdir(), "yaco-usage-nopath-"));
    TMP.push(root);
    const empty = join(root, "bin");
    mkdirSync(empty, { recursive: true });
    process.env["PATH"] = empty;
    return _spawnCodexAppServerForTests();
  }

  it("resolves the write and reports why the child never started", async () => {
    const proc = spawnWithoutCodex();
    // Must not reject: a request that cannot be delivered is not the error
    // worth reporting, and throwing here would pre-empt the read outcome that
    // knows what actually happened.
    await proc.send({ method: "initialize", id: 1 });
    await proc.exited;
    expect(proc.spawnError()?.code).toBe("ENOENT");
    proc.child.kill();
  });

  it("listens for stdin errors, which is the whole EPIPE guard", async () => {
    const proc = spawnWithoutCodex();
    // Deliberately structural. On Node 24 a write to a closed pipe emits
    // `EPIPE` on the child's stdin and, with no listener, crashes the process
    // — measured, not assumed. Bun raises no such event, so on this runtime
    // the guard's absence is invisible end to end and only its presence can be
    // asserted; the behavioural version arrives with the Node test cohort.
    // This is what fails if the listener is deleted.
    expect(proc.child.stdin.listenerCount("error")).toBeGreaterThan(0);
    await proc.exited;
    proc.child.kill();
  });
});
