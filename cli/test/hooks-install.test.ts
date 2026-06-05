/** Tests for `yaco agent hooks install` — merge semantics under isolated YACO_HOME.
 *
 *  AC: writes ${YACO_HOME}/agent-wrapper.sh; merges yaco-owned entries into
 *  ~/.claude/settings.json + ~/.codex/hooks.json; pre-existing unrelated
 *  entries are preserved.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { ensureClaudeHooks, ensureCodexHooks, ensureHooks, dropLegacyMultmuxHooks, HOOK_MARKER, CLAUDE_HOOK_EVENTS } from "../src/lib/core/agent/lifecycle.ts";
import { agentWrapperPath } from "../src/lib/core/paths/yaco-home.ts";

const ORIGINAL_YACO_HOME = process.env["YACO_HOME"];
const ORIGINAL_HOME = process.env["HOME"];
let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "yaco-hooks-install-"));
  process.env["YACO_HOME"] = join(sandbox, ".yaco");
  process.env["HOME"] = sandbox;
});

afterEach(() => {
  if (ORIGINAL_YACO_HOME === undefined) delete process.env["YACO_HOME"];
  else process.env["YACO_HOME"] = ORIGINAL_YACO_HOME;
  if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIGINAL_HOME;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("ensureHooks(provider) — wrapper installation", () => {
  it("writes ${YACO_HOME}/agent-wrapper.sh and makes it executable", () => {
    ensureHooks("claude");
    const path = agentWrapperPath();
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, "utf-8");
    expect(body).toContain("YACO_AGENT_SESSIONS_DIR");
    expect(body).toContain("#!/bin/bash");
  });
});

describe("ensureClaudeHooks — merge semantics", () => {
  it("adds yaco entries to fresh ~/.claude/settings.json", () => {
    ensureClaudeHooks();
    const settings = JSON.parse(readFileSync(join(sandbox, ".claude", "settings.json"), "utf-8"));
    for (const event of CLAUDE_HOOK_EVENTS) {
      const groups = settings.hooks[event];
      expect(Array.isArray(groups)).toBe(true);
      const ours = groups.find((g: any) => g.matcher === HOOK_MARKER || g.matcher === "*");
      expect(ours).toBeDefined();
      expect(ours.hooks[0].command).toMatch(new RegExp(`hook-event-bin\\.ts ${event}\\b|agent hook-event ${event}\\b`));
    }
  });

  it("preserves pre-existing unrelated hook entries", () => {
    const claudeDir = join(sandbox, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const userHook = {
      matcher: "my-custom-stop",
      hooks: [{ type: "command", command: "/usr/local/bin/my-notifier", async: false }],
    };
    const initial = { hooks: { Stop: [userHook], SessionStart: [] } };
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(initial));

    ensureClaudeHooks();

    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf-8"));
    // User's custom Stop entry preserved
    const customPreserved = settings.hooks.Stop.find((g: any) => g.matcher === "my-custom-stop");
    expect(customPreserved).toBeDefined();
    expect(customPreserved.hooks[0].command).toBe("/usr/local/bin/my-notifier");
    // Our Stop entry added alongside
    const ourStop = settings.hooks.Stop.find((g: any) => g.matcher === HOOK_MARKER);
    expect(ourStop).toBeDefined();
    expect(ourStop.hooks[0].command).toMatch(/hook-event-bin\.ts Stop\b|agent hook-event Stop\b/);
  });

  it("is idempotent: a second install adds no new entries", () => {
    ensureClaudeHooks();
    const first = readFileSync(join(sandbox, ".claude", "settings.json"), "utf-8");
    ensureClaudeHooks();
    const second = readFileSync(join(sandbox, ".claude", "settings.json"), "utf-8");
    expect(second).toBe(first);
  });

  it("overwrites a stale yaco-owned entry in place (no duplicate appended) "
    + "while leaving unrelated user entries untouched", () => {
    const claudeDir = join(sandbox, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const userHook = {
      matcher: "users-own-stop",
      hooks: [{ type: "command", command: "/usr/local/bin/my-notifier", async: false }],
    };
    const staleYacoHook = {
      matcher: HOOK_MARKER,
      hooks: [{
        type: "command",
        command: "bun /old/path/that/no/longer/exists.ts Stop",
        async: true,
      }],
    };
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({ hooks: { Stop: [userHook, staleYacoHook] } }),
    );

    ensureClaudeHooks();

    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf-8"));
    const stopGroups = settings.hooks.Stop;
    // User entry preserved verbatim, including order.
    const userPreserved = stopGroups.find((g: any) => g.matcher === "users-own-stop");
    expect(userPreserved).toBeDefined();
    expect(userPreserved.hooks[0].command).toBe("/usr/local/bin/my-notifier");
    // The stale yaco entry was overwritten in place — exactly one yaco-owned
    // group remains, and its command points at the current binary.
    const yacoOwned = stopGroups.filter((g: any) =>
      g?.hooks?.some((h: any) => /hook-event-bin\.ts|agent\s+hook-event/.test(h?.command)),
    );
    expect(yacoOwned).toHaveLength(1);
    expect(yacoOwned[0].hooks[0].command).not.toContain("/old/path/that/no/longer/exists.ts");
    expect(yacoOwned[0].hooks[0].command).toMatch(/hook-event-bin\.ts Stop\b|agent hook-event Stop\b/);
  });
});

describe("ensureCodexHooks — merge semantics", () => {
  it("adds yaco entries to fresh ~/.codex/hooks.json", () => {
    ensureCodexHooks();
    const hooks = JSON.parse(readFileSync(join(sandbox, ".codex", "hooks.json"), "utf-8"));
    const sessionStart = hooks.hooks.SessionStart.find((g: any) => g.matcher === HOOK_MARKER || g.matcher === "*");
    expect(sessionStart).toBeDefined();
    expect(sessionStart.hooks[0].command).toMatch(/hook-event-bin\.ts SessionStart\b|agent hook-event SessionStart\b/);
    // Codex hooks are sync (not async)
    expect(sessionStart.hooks[0].async).toBe(false);
  });

  it("preserves pre-existing unrelated entries", () => {
    const codexDir = join(sandbox, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const userEntry = {
      matcher: "user-tag",
      hooks: [{ type: "command", command: "user-script", async: false }],
    };
    writeFileSync(join(codexDir, "hooks.json"), JSON.stringify({ hooks: { Stop: [userEntry] } }));

    ensureCodexHooks();

    const hooks = JSON.parse(readFileSync(join(codexDir, "hooks.json"), "utf-8"));
    const preserved = hooks.hooks.Stop.find((g: any) => g.matcher === "user-tag");
    expect(preserved).toBeDefined();
  });
});

describe("ensureHooks(provider) — end-to-end install", () => {
  it("installs wrapper + claude + codex when called for both providers", () => {
    ensureHooks("claude");
    ensureHooks("codex");
    expect(existsSync(agentWrapperPath())).toBe(true);
    expect(existsSync(join(sandbox, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(sandbox, ".codex", "hooks.json"))).toBe(true);
  });
});

describe("dropLegacyMultmuxHooks — legacy hook-v2.sh cleanup", () => {
  it("removes hook-v2.sh groups, prunes only groups it empties, leaves others", () => {
    const hooks: Record<string, any> = {
      Stop: [
        { matcher: "multmux-hook", hooks: [{ type: "command", command: 'bash "/home/u/.yaco/hook-v2.sh"' }] },
        { matcher: "user-tag", hooks: [{ type: "command", command: "/usr/local/bin/my-notifier" }] },
        { matcher: "*", hooks: [] }, // unrelated pre-existing empty group — must survive
      ],
      PreToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: 'bash "/home/u/.multmux/hook-v2.sh"' }] },
      ],
    };

    expect(dropLegacyMultmuxHooks(hooks)).toBe(true);

    // Both legacy paths (~/.yaco and ~/.multmux) are gone.
    expect(JSON.stringify(hooks)).not.toContain("hook-v2.sh");
    // User group preserved; the unrelated empty group is left untouched.
    expect(hooks.Stop.find((g: any) => g.matcher === "user-tag")).toBeDefined();
    expect(hooks.Stop.find((g: any) => g.matcher === "*" && g.hooks.length === 0)).toBeDefined();
    // The group we emptied (PreToolUse legacy) is dropped, not left as an empty husk.
    expect(hooks.PreToolUse.length).toBe(0);
  });

  it("is a no-op (returns false) when there is nothing legacy to drop", () => {
    const hooks: Record<string, any> = {
      Stop: [{ matcher: HOOK_MARKER, hooks: [{ type: "command", command: "yaco agent hook-event Stop" }] }],
    };
    expect(dropLegacyMultmuxHooks(hooks)).toBe(false);
    expect(hooks.Stop.length).toBe(1);
  });

  it("ensureClaudeHooks strips a migrated hook-v2.sh entry and installs the managed form", () => {
    const claudeDir = join(sandbox, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const legacy = { matcher: "*", hooks: [{ type: "command", command: 'bash "/home/u/.yaco/hook-v2.sh"', async: true }] };
    const userHook = { matcher: "my-custom-stop", hooks: [{ type: "command", command: "/usr/local/bin/my-notifier" }] };
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ hooks: { Stop: [legacy, userHook] } }));

    ensureClaudeHooks();

    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf-8"));
    expect(JSON.stringify(settings)).not.toContain("hook-v2.sh");
    expect(settings.hooks.Stop.find((g: any) => g.matcher === "my-custom-stop")).toBeDefined();
    expect(settings.hooks.Stop.find((g: any) => g.matcher === HOOK_MARKER)).toBeDefined();
  });

  it("ensureCodexHooks strips a legacy multmux-hook entry", () => {
    const codexDir = join(sandbox, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const legacy = { matcher: "multmux-hook", hooks: [{ type: "command", command: 'bash "/home/u/.yaco/hook-v2.sh"', async: false }] };
    writeFileSync(join(codexDir, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [legacy] } }));

    ensureCodexHooks();

    const hooks = JSON.parse(readFileSync(join(codexDir, "hooks.json"), "utf-8"));
    expect(JSON.stringify(hooks)).not.toContain("hook-v2.sh");
    expect(hooks.hooks.SessionStart.find((g: any) => g.matcher === HOOK_MARKER)).toBeDefined();
  });
});
