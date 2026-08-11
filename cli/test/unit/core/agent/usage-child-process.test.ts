/** The app-server child's process plumbing, where the runtime reports failures
 *  somewhere other than the call that caused them.
 *
 *  `usage-subprocess.test.ts` covers what the command *says* about a broken
 *  `codex`. This file covers the way it could stop saying anything at all: a
 *  write to a pipe with no reader, which on Node emits `EPIPE` on the child's
 *  stdin and takes the whole process down unless something is listening. Both
 *  tests drive the real spawn helper, because a child that is not there — or
 *  one that stopped reading — is exactly what the command needs a real `codex`
 *  to get past.
 */
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _spawnCodexAppServerForTests } from "../../../../src/lib/core/agent/providers/usage.ts";

const TMP: string[] = [];

afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

/** A PATH holding only what the caller puts on it. */
function isolatedBin(): string {
  const root = mkdtempSync(join(tmpdir(), "yaco-usage-child-"));
  TMP.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  process.env["PATH"] = bin;
  return bin;
}

describe("writing to a codex child that cannot read", () => {
  const ORIGINAL_PATH = process.env["PATH"];
  afterEach(() => {
    if (ORIGINAL_PATH === undefined) delete process.env["PATH"];
    else process.env["PATH"] = ORIGINAL_PATH;
  });

  it("resolves the write and reports why the child never started", async () => {
    isolatedBin();
    const proc = _spawnCodexAppServerForTests();
    // Must not reject: a request that cannot be delivered is not the error
    // worth reporting, and throwing here would pre-empt the read outcome that
    // knows what actually happened.
    await proc.send({ method: "initialize", id: 1 });
    await proc.exited;
    expect(proc.spawnError()?.code).toBe("ENOENT");
    proc.child.kill();
  });

  it("survives the EPIPE from a live child that closed its read end", async () => {
    // The failure the guard exists for, driven end to end. A `codex` that
    // closes stdin and stays up is the app-server that is there and stopped
    // reading — the only shape that raises EPIPE: a child that never spawned,
    // and a child that has already exited, both leave `errored` null. The
    // `ready` line is the handshake that the read end is really gone before we
    // write, so the outcome does not depend on a race.
    //
    // Deliberately no listener of our own. `stdin.errored` records the error
    // whether or not anyone subscribed, while an unhandled `error` event is an
    // uncaught exception that fails this file — so if `usage.ts` drops its
    // `child.stdin.on("error", …)`, this test cannot pass, it dies. Under Bun
    // there is no such event at all, which is why this could only be asserted
    // structurally until the file ran on Node.
    const bin = isolatedBin();
    const codex = join(bin, "codex");
    // Its own PATH, because the one it inherits holds nothing but itself and
    // a shim that dies at the prompt is the *exited* child — a different case,
    // which raises no EPIPE and would make this test a coin flip.
    writeFileSync(codex, "#!/bin/sh\nexec 0<&-\necho ready\nPATH=/usr/bin:/bin exec sleep 30\n");
    chmodSync(codex, 0o755);

    const proc = _spawnCodexAppServerForTests();
    try {
      await new Promise<void>((resolve) => proc.child.stdout.once("data", () => resolve()));
      await proc.send({ method: "initialize", id: 1 });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(proc.spawnError()).toBeUndefined();
      expect((proc.child.stdin.errored as NodeJS.ErrnoException | null)?.code).toBe("EPIPE");
    } finally {
      proc.child.kill();
      await proc.exited;
    }
  });
});
