/** Shared hook-capability helpers. Hook config mutation is delegated to the
 *  existing lifecycle installers; this module exposes per-provider hook
 *  metadata (events, config path, install, probe) for the registry. */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { ensureClaudeHooks, ensureCodexHooks } from "../lifecycle.ts";
import type { ProviderHookEvent, ProviderHooks } from "./types.ts";

/** Honor $HOME at call time so hook paths track test home overrides. */
function userHome(): string {
  const env = process.env["HOME"];
  return env && env.length > 0 ? env : homedir();
}

/** A YACO-managed hook entry runs the `agent hook-event` entry point. */
function hasInstalledHook(configPath: string): boolean {
  if (!existsSync(configPath)) return false;
  try {
    const raw = readFileSync(configPath, "utf-8");
    return /\bagent\s+hook-event\b/.test(raw);
  } catch {
    return false;
  }
}

/** Hook events Claude's adapter installs. */
export const CLAUDE_HOOK_EVENTS: readonly ProviderHookEvent[] = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Notification",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
];

/** Hook events Codex's adapter installs. */
export const CODEX_HOOK_EVENTS: readonly ProviderHookEvent[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "PreCompact",
  "PostCompact",
  "Stop",
];

export function claudeHooks(): ProviderHooks {
  const configPath = (): string => join(userHome(), ".claude", "settings.json");
  return {
    events: CLAUDE_HOOK_EVENTS,
    configPath,
    install: ensureClaudeHooks,
    hasInstalledHook: () => hasInstalledHook(configPath()),
  };
}

export function codexHooks(): ProviderHooks {
  const configPath = (): string => join(userHome(), ".codex", "hooks.json");
  return {
    events: CODEX_HOOK_EVENTS,
    configPath,
    install: ensureCodexHooks,
    hasInstalledHook: () => hasInstalledHook(configPath()),
  };
}
