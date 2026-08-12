/** How `${YACO_HOME}/agent-wrapper.sh` is swapped in, observed at the syscalls.
 *
 *  Its own file because that observation needs a `vi.mock("fs")`, which is
 *  file-scoped. install.test.ts pins the outcome — the running inode survives,
 *  the installed file is executable. What only a hook inside the fs calls can
 *  pin is how the temp was created and what state it is in at the moment of the
 *  swap, and what each failing step leaves behind.
 *
 *  Four properties, each with a failure mode no outcome assertion can see:
 *
 *  - the temp is created EXCLUSIVELY (`wx`). Without it the write follows a
 *    symlink sitting at the temp path and truncates + chmods 0755 whatever it
 *    points at.
 *  - mode 0755 is set BEFORE the rename. Chmod after it is invisible afterwards
 *    and still wrong: a session starting in the gap execs a file it may not run.
 *  - the temp is a SIBLING of the target. rename(2) fails EXDEV across
 *    filesystems, and $TMPDIR is routinely a different one — which on a box
 *    where /tmp is the same device is a bug no outcome assertion can see.
 *  - every failure AFTER the exclusive create leaves no temp behind, whatever
 *    its errno, and leaves the file live sessions are executing exactly as it
 *    was. (Before it, an EEXIST is the deliberate exception: that file is not
 *    ours to delete.) The truncating version could promise none of this — by the
 *    time anything can fail, the old content is already gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

interface RenameCall {
  from: string;
  to: string;
  /** Permission bits of `from` as the rename was entered. */
  fromMode: number;
}

/** Which step to blow up in, and what the calls looked like. `null` fails
 *  nothing — the mock is otherwise a straight pass-through. */
const ctl = vi.hoisted(() => ({
  failAt: null as null | "write" | "chmod" | "rename",
  /** errno for the injected failure. EEXIST is the one the writer reads. */
  failCode: "EIO",
  /** Make the package look like it ships no wrapper, so reading it throws. */
  hidePackagedWrapper: false,
  /** Pin the temp file's random suffix, so a test can collide with it. */
  uuid: null as string | null,
  renames: [] as RenameCall[],
  writeFlags: [] as (string | undefined)[],
}));

function boom(step: string): never {
  const e = new Error(`${ctl.failCode}: injected failure at ${step}`) as NodeJS.ErrnoException;
  e.code = ctl.failCode;
  throw e;
}

vi.mock("fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("fs")>();
  const isWrapperTemp = (p: unknown): boolean =>
    typeof p === "string" && p.includes("agent-wrapper.sh.") && p.endsWith(".tmp");
  const writeFileSync = ((path: unknown, data: unknown, opts?: unknown) => {
    if (isWrapperTemp(path)) {
      ctl.writeFlags.push((opts as { flag?: string } | undefined)?.flag);
      if (ctl.failAt === "write") boom("write");
    }
    return (fs.writeFileSync as (...a: unknown[]) => void)(path, data, opts);
  }) as typeof fs.writeFileSync;
  const chmodSync = ((path: unknown, mode: unknown) => {
    if (isWrapperTemp(path) && ctl.failAt === "chmod") boom("chmod");
    return (fs.chmodSync as (...a: unknown[]) => void)(path, mode);
  }) as typeof fs.chmodSync;
  const renameSync = ((from: string, to: string) => {
    ctl.renames.push({ from, to, fromMode: fs.statSync(from).mode & 0o777 });
    if (ctl.failAt === "rename") boom("rename");
    return fs.renameSync(from, to);
  }) as typeof fs.renameSync;
  const existsSync = ((p: unknown) => {
    if (ctl.hidePackagedWrapper && typeof p === "string" && p.endsWith("scripts/agent-wrapper.sh")) {
      return false;
    }
    return (fs.existsSync as (a: unknown) => boolean)(p);
  }) as typeof fs.existsSync;
  const patched = { ...fs, writeFileSync, chmodSync, renameSync, existsSync };
  return { ...patched, default: patched };
});

vi.mock("crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("crypto")>();
  const randomUUID = (() => ctl.uuid ?? crypto.randomUUID()) as typeof crypto.randomUUID;
  const patched = { ...crypto, randomUUID };
  return { ...patched, default: patched };
});

const { ensureAgentWrapperScript, ensureHooks, readAgentWrapperScript } = await import(
  "../../../../src/lib/core/agent/lifecycle.ts"
);
const { runInstall } = await import("../../../../src/commands/install.ts");

const ORIG = {
  HOME: process.env["HOME"],
  YACO_HOME: process.env["YACO_HOME"],
};

let sandbox: string;
let yacoHome: string;
let wrapper: string;

function reset(): void {
  ctl.failAt = null;
  ctl.failCode = "EIO";
  ctl.hidePackagedWrapper = false;
  ctl.uuid = null;
  ctl.renames = [];
  ctl.writeFlags = [];
}

beforeEach(() => {
  reset();
  sandbox = mkdtempSync(join(tmpdir(), "yaco-wrapper-atomic-"));
  process.env["HOME"] = join(sandbox, "home");
  mkdirSync(process.env["HOME"], { recursive: true });
  yacoHome = join(sandbox, "yaco");
  process.env["YACO_HOME"] = yacoHome;
  wrapper = join(yacoHome, "agent-wrapper.sh");
});

afterEach(() => {
  reset();
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

/** A wrapper on disk that differs from the packaged one, so the next call has
 *  to write. Returns the inode a "live session" would be holding. */
function stageStaleWrapper(): { content: string; ino: number } {
  mkdirSync(yacoHome, { recursive: true });
  const content = "#!/usr/bin/env bash\n# what the live sessions are running\n";
  writeFileSync(wrapper, content);
  return { content, ino: statSync(wrapper).ino };
}

describe("ensureAgentWrapperScript — how the file is swapped in", () => {
  it("renames an exclusively-created sibling temp that is already 0755", () => {
    expect(ensureAgentWrapperScript()).toBe(true);
    expect(ctl.renames).toHaveLength(1);
    const call = ctl.renames[0]!;
    expect(call.to).toBe(wrapper);
    expect(dirname(call.from)).toBe(dirname(wrapper));
    expect(call.fromMode).toBe(0o755);
    expect(ctl.writeFlags).toEqual(["wx"]);
  });

  it("reports whether it wrote, and does not touch a wrapper already current", () => {
    expect(ensureAgentWrapperScript()).toBe(true);
    const ino = statSync(wrapper).ino;
    reset();
    expect(ensureAgentWrapperScript()).toBe(false);
    expect(ctl.renames).toEqual([]);
    expect(statSync(wrapper).ino).toBe(ino);
  });

  it("leaves the inode a live session is executing intact", () => {
    const stale = stageStaleWrapper();
    const fd = openSync(wrapper, "r");
    try {
      expect(ensureAgentWrapperScript()).toBe(true);
      // The old inode: still the bytes the "session" started on.
      expect(readFileSync(fd, "utf-8")).toBe(stale.content);
      // The name: a different inode, carrying the packaged wrapper.
      expect(statSync(wrapper).ino).not.toBe(stale.ino);
      expect(readFileSync(wrapper, "utf-8")).toBe(readAgentWrapperScript());
    } finally {
      closeSync(fd);
    }
  });
});

describe("ensureAgentWrapperScript — failure paths", () => {
  for (const step of ["write", "chmod", "rename"] as const) {
    it(`leaves no temp and does not disturb the wrapper in use when ${step} fails`, () => {
      const stale = stageStaleWrapper();
      ctl.failAt = step;
      expect(() => ensureAgentWrapperScript()).toThrow(/injected failure at/);
      expect(readdirSync(yacoHome).filter((n) => n.endsWith(".tmp"))).toEqual([]);
      expect(readFileSync(wrapper, "utf-8")).toBe(stale.content);
      expect(statSync(wrapper).ino).toBe(stale.ino);
    });

    it(`leaves no temp when ${step} fails and the wrapper did not exist yet`, () => {
      ctl.failAt = step;
      expect(() => ensureAgentWrapperScript()).toThrow(/injected failure at/);
      expect(existsSync(wrapper)).toBe(false);
      expect(readdirSync(yacoHome)).toEqual([]);
    });
  }
});

describe("ensureAgentWrapperScript — EEXIST after the exclusive create", () => {
  for (const step of ["chmod", "rename"] as const) {
    it(`still removes the temp when ${step} is what reports it`, () => {
      // rename(2) has its own uses for EEXIST. Past the exclusive create the
      // temp is ours whatever the errno says, so reading the code instead of
      // the step would strand it on a failure that is not about ownership.
      const stale = stageStaleWrapper();
      ctl.failAt = step;
      ctl.failCode = "EEXIST";
      expect(() => ensureAgentWrapperScript()).toThrow(/injected failure at/);
      expect(readdirSync(yacoHome).filter((n) => n.endsWith(".tmp"))).toEqual([]);
      expect(readFileSync(wrapper, "utf-8")).toBe(stale.content);
    });
  }
});

describe("ensureAgentWrapperScript — a temp it did not create", () => {
  it("refuses the path and leaves it alone", () => {
    // `wx` exists to make this case harmless rather than destructive. Whatever
    // sits at the temp path, it is not ours — the refused exclusive create is
    // the proof — and removing it on the way out would throw away the very file
    // the flag just protected.
    const stale = stageStaleWrapper();
    ctl.uuid = "squatter-0000-0000-0000-000000000000";
    const squatter = `${wrapper}.${process.pid}.${ctl.uuid.slice(0, 8)}.tmp`;
    writeFileSync(squatter, "someone else's file\n");

    expect(() => ensureAgentWrapperScript()).toThrow(/EEXIST/);

    expect(readFileSync(squatter, "utf-8")).toBe("someone else's file\n");
    expect(readFileSync(wrapper, "utf-8")).toBe(stale.content);
  });
});

describe("installAgentWrapper --dry-run", () => {
  it("does not plan a write the real run could not perform", () => {
    // A plan is a promise about the real run. With no packaged wrapper to
    // install, the real run throws — so reporting `write` would be a plan
    // install cannot carry out.
    ctl.hidePackagedWrapper = true;
    return expect(
      runInstall({
        cliOnly: true, skipHooks: true, noRegistry: true, skipLinks: true,
        skipDoctor: true, dryRun: true, force: false, json: false,
      }),
    ).rejects.toThrow(/cannot locate/);
  });
});

describe("the `yaco agent start` path", () => {
  it("refreshes the wrapper through the same rename, not a second writer", () => {
    // ensureHooks() is what `yaco agent start` calls on every start — far more
    // often than `yaco install` runs, and always while other sessions are live.
    // It used to reach a separate truncating implementation.
    const stale = stageStaleWrapper();
    const fd = openSync(wrapper, "r");
    try {
      ensureHooks("claude");
      expect(ctl.renames.map((r) => r.to)).toContain(wrapper);
      expect(readFileSync(fd, "utf-8")).toBe(stale.content);
      expect(statSync(wrapper).ino).not.toBe(stale.ino);
      expect(statSync(wrapper).mode & 0o777).toBe(0o755);
    } finally {
      closeSync(fd);
    }
  });
});
