/** The mechanics of the wrapper write, observed at the rename itself.
 *
 *  Its own file because that observation needs a `vi.mock("node:fs")`, which is
 *  file-scoped and would otherwise sit under every test in install.test.ts.
 *  install.test.ts pins the outcome — the running inode survives, the installed
 *  file is executable; what only a hook inside `renameSync` can pin is the state
 *  the temp is in *at the moment of the swap*, and what a failing swap leaves.
 *
 *  Three properties, each with a failure mode the outcome cannot distinguish:
 *
 *  - mode 0755 is set BEFORE the rename. Chmod after it is invisible afterwards
 *    and still wrong: a session starting in the gap execs a file it may not run.
 *  - the temp is a SIBLING of the target. rename(2) fails EXDEV across
 *    filesystems, and $TMPDIR is routinely a different one — which on a dev box
 *    where /tmp is the same device is a bug no outcome assertion can see.
 *  - a failed write leaves no temp behind, and leaves the file live sessions are
 *    executing exactly as it was. The truncating version could promise neither:
 *    by the time anything can fail, the old content is already gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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

const ctl = vi.hoisted(() => ({ failRename: false, calls: [] as RenameCall[] }));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const renameSync = ((from: string, to: string) => {
    ctl.calls.push({ from, to, fromMode: fs.statSync(from).mode & 0o777 });
    if (ctl.failRename) {
      const e = new Error("EXDEV: cross-device link not permitted") as NodeJS.ErrnoException;
      e.code = "EXDEV";
      throw e;
    }
    return fs.renameSync(from, to);
  }) as typeof fs.renameSync;
  return { ...fs, renameSync, default: { ...fs, renameSync } };
});

const { runInstall } = await import("../../../src/commands/install.ts");

// $YACO_BIN_DIR too: install reaches into it to clear legacy symlinks, and an
// ambient one would point that at a real bin dir on the developer's machine.
const ORIG = {
  HOME: process.env["HOME"],
  YACO_HOME: process.env["YACO_HOME"],
  YACO_BIN_DIR: process.env["YACO_BIN_DIR"],
};

let sandbox: string;
let yacoHome: string;
let wrapper: string;

/** Wrapper-only install: every other step is switched off, so every rename the
 *  hook records — and everything left in ${YACO_HOME} — is this one write. */
const wrapperOnly = {
  cliOnly: true,
  skipHooks: true,
  noRegistry: true,
  skipLinks: true,
  skipDoctor: true,
  dryRun: false,
  force: false,
  json: false,
} as const;

function wrapperRename(): RenameCall {
  expect(ctl.calls).toHaveLength(1);
  return ctl.calls[0]!;
}

beforeEach(() => {
  ctl.failRename = false;
  ctl.calls = [];
  sandbox = mkdtempSync(join(tmpdir(), "yaco-wrapper-atomic-"));
  process.env["HOME"] = join(sandbox, "home");
  mkdirSync(process.env["HOME"], { recursive: true });
  yacoHome = join(sandbox, "yaco");
  process.env["YACO_HOME"] = yacoHome;
  process.env["YACO_BIN_DIR"] = join(sandbox, "bin");
  wrapper = join(yacoHome, "agent-wrapper.sh");
});

afterEach(() => {
  ctl.failRename = false;
  ctl.calls = [];
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

describe("installAgentWrapper — how the file is swapped in", () => {
  it("renames a sibling temp that is already 0755", async () => {
    await runInstall({ ...wrapperOnly });
    const call = wrapperRename();
    expect(call.to).toBe(wrapper);
    expect(dirname(call.from)).toBe(dirname(wrapper));
    expect(call.fromMode).toBe(0o755);
  });
});

describe("installAgentWrapper — failure path", () => {
  it("leaves no temp behind and does not disturb the wrapper in use", async () => {
    await runInstall({ ...wrapperOnly });
    const stale = "#!/usr/bin/env bash\n# what the live sessions are running\n";
    writeFileSync(wrapper, stale);
    const staleIno = statSync(wrapper).ino;

    ctl.failRename = true;
    await expect(runInstall({ ...wrapperOnly })).rejects.toThrow(/EXDEV/);

    expect(readdirSync(yacoHome).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(readFileSync(wrapper, "utf-8")).toBe(stale);
    expect(statSync(wrapper).ino).toBe(staleIno);
  });

  it("leaves no temp behind when the target did not exist yet", async () => {
    ctl.failRename = true;
    await expect(runInstall({ ...wrapperOnly })).rejects.toThrow(/EXDEV/);
    expect(existsSync(wrapper)).toBe(false);
    expect(readdirSync(yacoHome)).toEqual([]);
  });
});
