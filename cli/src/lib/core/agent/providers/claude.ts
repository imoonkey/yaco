/** Claude TUI provider adapter. */

import { resolveSessionId, PENDING_SESSION_ID } from "../session-id.ts";
import { shellEscape } from "./shell-escape.ts";
import { hasNameFlag, hasPermissionFlag, extractResume, stripResume } from "./args.ts";
import { claudeHooks } from "./hooks.ts";
import { claudeHistory } from "./history.ts";
import { claudeOutput } from "./output.ts";
import type { TuiProvider } from "./types.ts";

// If any of these flags is present, don't add the default permission flag.
const PERMISSION_FLAGS = [
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--permission-mode",
] as const;

// Trust-folder dialog shown on first launch in an untrusted directory.
const TRUST_PATTERN = /trust this folder|Yes, I trust/i;

export const claudeProvider: TuiProvider = {
  id: "claude",
  label: "Claude",
  executable: "claude",

  command: {
    permissionFlags: PERMISSION_FLAGS,

    build(args: string[]): string {
      const parts: string[] = ["env", "-u", "CLAUDECODE", "claude"];
      if (!hasPermissionFlag(args, PERMISSION_FLAGS)) {
        parts.push("--dangerously-skip-permissions");
      }
      for (const arg of args) parts.push(shellEscape(arg));
      return parts.join(" ");
    },

    normalizeResumeArgs(args: string[]): string[] {
      const id = extractResume(args);
      if (!id) return [...args];
      return ["--resume", id, ...stripResume(args)];
    },

    normalizeStartArgs(ctx): string[] {
      // Claude accepts --name natively; inject it when the caller has not.
      if (ctx.handle && !hasNameFlag(ctx.args)) {
        return [...ctx.args, "--name", ctx.handle];
      }
      return [...ctx.args];
    },

    postStartInputs(): readonly string[] {
      return [];
    },

    renameInputs(newHandle: string): readonly string[] {
      return [`/rename ${newHandle}`];
    },

    startupInterstitials: [
      { pattern: TRUST_PATTERN, keys: ["Enter"] },
    ],
  },

  detection: {
    idlePatterns: [
      /^❯\s/m, // Claude Code idle prompt (\s matches U+00A0 NBSP that follows ❯)
      />\s*$/m, // fallback simple prompt
    ],
  },

  sessionId: {
    pendingValue: PENDING_SESSION_ID,
    envKeys: ["CLAUDE_CODE_SESSION_ID"],
    startResolution: "poll-provider-storage",
    resolve: (ctx) => resolveSessionId(ctx.pid, "claude", ctx.sessionCreatedMs, ctx.sessionPath),
  },

  hooks: claudeHooks(),

  history: claudeHistory(),

  output: claudeOutput(),
};
