/** Startup trust gate (cli-trust-gate).
 *
 *  Two layers:
 *   1. codexHooksAllYacoOwned — the fail-closed security predicate that decides
 *      whether Codex's hooks-review screen may be auto-dismissed. Strict
 *      per-handler canonical-YACO match across ALL effective sources
 *      (global+project hooks.json, inline [hooks] in global+project config.toml).
 *   2. The interstitial guard path — a matched hooks-review interstitial whose
 *      guard fails writes blocked(trust) and sends NO keys (verified directly
 *      through handleStartupInterstitial, whose blocked branch never touches
 *      tmux), while the trust-FOLDER interstitial stays unguarded.
 *
 *  No module mock here because none is needed: the blocked branch never touches
 *  tmux, so the gate is exercised against real on-disk config under a sandboxed
 *  HOME.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  codexHooksAllYacoOwned,
  hookCommand,
  _resetHookBinaryCacheForTests,
} from "../src/lib/core/agent/lifecycle.ts";
import { handleStartupInterstitial } from "../src/commands/agent/start.ts";
import { getProvider } from "../src/lib/core/agent/providers/index.ts";
import { writeState, readState, deleteState, listStateHandles } from "../src/lib/core/agent/session-state.ts";
import type { StartupInterstitial } from "../src/lib/core/agent/providers/types.ts";
import type { SessionState } from "../src/lib/core/agent/model.ts";

const ORIG = {
  HOME: process.env["HOME"],
  SESSIONS: process.env["YACO_AGENT_SESSIONS_DIR"],
};

let sandbox: string;
let home: string;
let projectDir: string;

const CANONICAL = hookCommand("SessionStart"); // <yaco-binary> agent hook-event SessionStart
const FOREIGN = "/usr/local/bin/evil-hook";

function codexDir(root: string): string {
  const dir = join(root, ".codex");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function writeHooksJson(root: string, map: Record<string, unknown>): void {
  writeFileSync(join(codexDir(root), "hooks.json"), JSON.stringify({ hooks: map }, null, 2));
}

function writeRaw(root: string, name: string, body: string): void {
  writeFileSync(join(codexDir(root), name), body);
}

function commandGroup(...commands: string[]): unknown {
  return { hooks: commands.map((command) => ({ type: "command", command })) };
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "yaco-trust-gate-"));
  home = join(sandbox, "home");
  projectDir = join(sandbox, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  process.env["HOME"] = home;
  process.env["YACO_AGENT_SESSIONS_DIR"] = join(sandbox, "sessions");
  _resetHookBinaryCacheForTests();
});

afterEach(() => {
  for (const h of listStateHandles()) deleteState(h);
  if (ORIG.HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIG.HOME;
  if (ORIG.SESSIONS === undefined) delete process.env["YACO_AGENT_SESSIONS_DIR"];
  else process.env["YACO_AGENT_SESSIONS_DIR"] = ORIG.SESSIONS;
  rmSync(sandbox, { recursive: true, force: true });
  _resetHookBinaryCacheForTests();
});

// ===========================================================================
// codexHooksAllYacoOwned — fail-closed security predicate
// ===========================================================================

describe("codexHooksAllYacoOwned", () => {
  it("returns true when no Codex hook source exists", () => {
    expect(codexHooksAllYacoOwned(projectDir)).toBe(true);
  });

  it("AC1: fully YACO-owned across all sources → true", () => {
    writeHooksJson(home, { SessionStart: [commandGroup(CANONICAL)] });
    writeHooksJson(projectDir, { Stop: [commandGroup(hookCommand("Stop"))] });
    writeRaw(home, "config.toml", "suppress_unstable_features_warning = true\n");
    writeRaw(projectDir, "config.toml", "model = \"o3\"\n");
    expect(codexHooksAllYacoOwned(projectDir)).toBe(true);
  });

  it("AC2: a foreign handler in GLOBAL hooks.json → false", () => {
    writeHooksJson(home, { SessionStart: [commandGroup(FOREIGN)] });
    expect(codexHooksAllYacoOwned(projectDir)).toBe(false);
  });

  it("AC2: a foreign handler in PROJECT hooks.json → false", () => {
    writeHooksJson(home, { SessionStart: [commandGroup(CANONICAL)] });
    writeHooksJson(projectDir, { Stop: [commandGroup(FOREIGN)] });
    expect(codexHooksAllYacoOwned(projectDir)).toBe(false);
  });

  it("AC2: a foreign handler inline in GLOBAL config.toml → false", () => {
    writeRaw(home, "config.toml",
      ["suppress_unstable_features_warning = true",
       "[[hooks.SessionStart.hooks]]",
       "type = \"command\"",
       `command = "${FOREIGN}"`].join("\n"));
    expect(codexHooksAllYacoOwned(projectDir)).toBe(false);
  });

  it("AC2: a foreign handler inline in PROJECT config.toml → false", () => {
    writeRaw(projectDir, "config.toml",
      ["[[hooks.Stop.hooks]]",
       "type = \"command\"",
       `command = "${FOREIGN}"`].join("\n"));
    expect(codexHooksAllYacoOwned(projectDir)).toBe(false);
  });

  it("all-YACO inline config.toml → true (per-handler canonical match)", () => {
    writeRaw(home, "config.toml",
      ["[[hooks.SessionStart.hooks]]",
       "type = \"command\"",
       `command = "${CANONICAL}"`].join("\n"));
    expect(codexHooksAllYacoOwned(projectDir)).toBe(true);
  });

  it("ignores Codex trust bookkeeping ([hooks.state]) and the feature flag", () => {
    // Real config.toml carries `[features] hooks = true` and a `[hooks.state...]`
    // subtree of trusted-hash bookkeeping — neither is a hook definition, so an
    // otherwise all-YACO machine must NOT be blocked by them.
    writeHooksJson(home, { SessionStart: [commandGroup(CANONICAL)] });
    writeRaw(home, "config.toml",
      ["[features]",
       "hooks = true",
       "",
       "[hooks.state]",
       "",
       "[hooks.state.\"/home/u/.codex/hooks.json:session_start:0:0\"]",
       "trusted_hash = \"sha256:abc\""].join("\n"));
    expect(codexHooksAllYacoOwned(projectDir)).toBe(true);
  });

  it("AC3: a group mixing a YACO handler with a foreign handler → false", () => {
    // isYacoOwnedGroup would PASS this group (it has one YACO command); the
    // strict per-handler gate must NOT.
    writeHooksJson(home, { SessionStart: [commandGroup(CANONICAL, FOREIGN)] });
    expect(codexHooksAllYacoOwned(projectDir)).toBe(false);
  });

  it("AC4: an unparseable hooks.json source → false", () => {
    writeRaw(home, "hooks.json", "{ this is not json ");
    expect(codexHooksAllYacoOwned(projectDir)).toBe(false);
  });

  it("a non-command handler type (hooks.json) → false", () => {
    writeHooksJson(home, { SessionStart: [{ hooks: [{ type: "javascript", command: CANONICAL }] }] });
    expect(codexHooksAllYacoOwned(projectDir)).toBe(false);
  });

  it("a non-command handler type INLINE in config.toml → false", () => {
    // Critical: a non-"command" type carrying the canonical command string must
    // still block — Codex would run it as something other than our command hook.
    writeRaw(home, "config.toml",
      ["[[hooks.SessionStart.hooks]]",
       "type = \"javascript\"",
       `command = "${CANONICAL}"`].join("\n"));
    expect(codexHooksAllYacoOwned(projectDir)).toBe(false);
  });

  it("a hook group with no `hooks` array → false", () => {
    // Unexpected group shape must fail closed, not be treated as trusted.
    writeHooksJson(home, { SessionStart: [{}] });
    expect(codexHooksAllYacoOwned(projectDir)).toBe(false);
  });

  it("a substring-embedded YACO command (foreign wrapper) → false", () => {
    writeHooksJson(home, { SessionStart: [commandGroup(`evil && ${CANONICAL}`)] });
    expect(codexHooksAllYacoOwned(projectDir)).toBe(false);
  });

  it("an UNKNOWN event key with a canonical handler (hooks.json) → false", () => {
    // An event YACO never installs is foreign by definition, even with our
    // exact command — block regardless of the canonical command string.
    writeHooksJson(home, { mystery: [commandGroup(CANONICAL)] });
    expect(codexHooksAllYacoOwned(projectDir)).toBe(false);
  });

  it("an UNKNOWN event key with a canonical handler (inline config.toml) → false", () => {
    writeRaw(home, "config.toml",
      ["[[hooks.mystery.hooks]]",
       "type = \"command\"",
       `command = "${CANONICAL}"`].join("\n"));
    expect(codexHooksAllYacoOwned(projectDir)).toBe(false);
  });

  it("AC4: malformed config.toml → false (unparseable source ⇒ block)", () => {
    writeRaw(home, "config.toml", `model = "unterminated\n[features]\nhooks = true\n`);
    expect(codexHooksAllYacoOwned(projectDir)).toBe(false);
  });

  it("a foreign handler hidden under [hooks.state] → false", () => {
    // The `state` subtree is trust bookkeeping, but it must be VALIDATED, not
    // blindly skipped — a command-shaped entry smuggled under it must block.
    writeRaw(home, "config.toml",
      ["[hooks.state]",
       `hooks = [{ type = "command", command = "${FOREIGN}" }]`].join("\n"));
    expect(codexHooksAllYacoOwned(projectDir)).toBe(false);
  });

  it("a legit [hooks.state] with only trusted_hash records → true", () => {
    writeHooksJson(home, { SessionStart: [commandGroup(CANONICAL)] });
    writeRaw(home, "config.toml",
      ["[hooks.state]",
       "[hooks.state.\"/h/.codex/hooks.json:session_start:0:0\"]",
       "trusted_hash = \"sha256:abc\"",
       "[hooks.state.\"/h/.codex/hooks.json:stop:0:0\"]",
       "trusted_hash = \"sha256:def\""].join("\n"));
    expect(codexHooksAllYacoOwned(projectDir)).toBe(true);
  });

  it("AC-shape: hooks.json in the inline-OBJECT shape → false (json wants array)", () => {
    // Even a CANONICAL command must block when the per-source shape is wrong —
    // a foreign hooks.json could otherwise pass by using the object shape.
    writeRaw(home, "hooks.json",
      JSON.stringify({ hooks: { SessionStart: { hooks: [{ type: "command", command: CANONICAL }] } } }));
    expect(codexHooksAllYacoOwned(projectDir)).toBe(false);
  });

  it("AC-shape: inline config.toml in the ARRAY shape → false (toml wants object)", () => {
    writeRaw(home, "config.toml",
      ["[[hooks.SessionStart]]",
       "[[hooks.SessionStart.hooks]]",
       "type = \"command\"",
       `command = "${CANONICAL}"`].join("\n"));
    expect(codexHooksAllYacoOwned(projectDir)).toBe(false);
  });

  it("a disabled foreign handler is skipped → true", () => {
    writeHooksJson(home, {
      SessionStart: [{ hooks: [{ type: "command", command: FOREIGN, enabled: false }] }],
    });
    expect(codexHooksAllYacoOwned(projectDir)).toBe(true);
  });
});

// ===========================================================================
// Codex interstitial wiring — guards on the two hooks-review screens only
// ===========================================================================

describe("codex hooks-review interstitial wiring", () => {
  const interstitials = getProvider("codex").command.startupInterstitials ?? [];
  const find = (re: RegExp): StartupInterstitial | undefined =>
    interstitials.find((i) => re.test(i.pattern.source));

  it("guards the 'Hooks need review' menu with the YACO-owned gate → blocked(trust)", () => {
    const i = find(/Hooks need review/);
    expect(i?.guard).toBe(codexHooksAllYacoOwned);
    expect(i?.blockReason).toBe("trust");
  });

  it("guards the 'Press t to trust all' overlay → blocked(trust)", () => {
    const i = find(/Press t to trust all/);
    expect(i?.guard).toBe(codexHooksAllYacoOwned);
    expect(i?.blockReason).toBe("trust");
  });

  it("AC5: the trust-FOLDER interstitial stays unguarded (pure auto-Enter)", () => {
    const i = find(/trust this folder/);
    expect(i?.guard).toBeUndefined();
    expect(i?.blockReason).toBeUndefined();
    expect(i?.keys).toEqual(["Enter"]);
  });
});

// ===========================================================================
// Guard path — a failed gate writes blocked(trust) and sends NO keys
// ===========================================================================

const HOOK_REVIEW_SCREEN = ["Hooks need review", "", "› Review hooks", "  Trust all and continue"].join("\n");

function startingState(handle: string, sessionPath: string): SessionState {
  return {
    handle,
    provider: "codex",
    sessionPath,
    pid: 1234,
    sessionId: "pending:awaiting-first-prompt",
    status: "starting",
    createdAt: new Date().toISOString(),
  };
}

describe("handleStartupInterstitial guard path", () => {
  it("AC2: a foreign hook → blocked(trust), reports 'blocked', sends no keys", () => {
    // Foreign hook in the (sandboxed) global config → the real gate rejects it.
    writeHooksJson(home, { SessionStart: [commandGroup(FOREIGN)] });
    const handle = "tg-foreign";
    writeState(startingState(handle, projectDir));

    // The blocked branch returns before any sendRawKeys call, so no tmux needed.
    const outcome = handleStartupInterstitial(
      handle,
      HOOK_REVIEW_SCREEN,
      getProvider("codex").command.startupInterstitials ?? [],
      new Set<string>(),
      projectDir,
    );

    expect(outcome).toBe("blocked");
    const state = readState(handle);
    expect(state?.status).toBe("blocked");
    expect(state?.blockReason).toBe("trust");
  });

  it("does not re-handle an already-blocked interstitial on the next poll", () => {
    writeHooksJson(home, { SessionStart: [commandGroup(FOREIGN)] });
    const handle = "tg-once";
    writeState(startingState(handle, projectDir));
    const handled = new Set<string>();
    const interstitials = getProvider("codex").command.startupInterstitials ?? [];

    expect(handleStartupInterstitial(handle, HOOK_REVIEW_SCREEN, interstitials, handled, projectDir)).toBe("blocked");
    // Same dialog, next poll: it is marked handled → "none" (no re-write, no keys).
    expect(handleStartupInterstitial(handle, HOOK_REVIEW_SCREEN, interstitials, handled, projectDir)).toBe("none");
  });

  it("a passing guard (all-YACO) reaches the send branch, not blocked", () => {
    // All-YACO config → gate passes → the interstitial is NOT blocked. We use a
    // stub interstitial with no real keys so the send branch performs no tmux IO.
    writeHooksJson(home, { SessionStart: [commandGroup(CANONICAL)] });
    const handle = "tg-owned";
    writeState(startingState(handle, projectDir));
    const stub: StartupInterstitial = {
      pattern: /Hooks need review[\s\S]*Trust all and continue/i,
      keys: [], // empty → send branch is a no-op, no tmux
      guard: codexHooksAllYacoOwned,
      blockReason: "trust",
    };

    const outcome = handleStartupInterstitial(handle, HOOK_REVIEW_SCREEN, [stub], new Set<string>(), projectDir);

    expect(outcome).toBe("handled");
    expect(readState(handle)?.status).toBe("starting"); // not blocked
  });
});
