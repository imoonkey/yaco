/** Codex TUI provider adapter. */

import { resolveSessionId, PENDING_SESSION_ID } from "../session-id.ts";
import { shellEscape } from "./shell-escape.ts";
import { hasPermissionFlag, stripNameFlag, extractResume, stripResume } from "./args.ts";
import { codexHooks } from "./hooks.ts";
import { codexHistory } from "./history.ts";
import { codexOutput } from "./output.ts";
import { codexMessages } from "./messages.ts";
import { codexProjectMove } from "./project-move.ts";
import { codexHooksAllYacoOwned } from "../lifecycle.ts";
import type { TuiProvider } from "./types.ts";

// If any of these flags is present, don't add the default permission flag.
const PERMISSION_FLAGS = [
  "--yolo",
  "--dangerously-bypass-approvals-and-sandbox",
  "--full-auto",
  "-a",
  "--ask-for-approval",
  "--sandbox",
] as const;

// Codex needs truecolor advertised so its TUI renders correctly in headless tmux.
const LAUNCH_ENV: Record<string, string> = { COLORTERM: "truecolor" };

// Trust-folder dialog plus the two hook-review screens Codex shows when the
// installed hook commands change.
const TRUST_PATTERN = /trust this folder|Yes, I trust/i;
const HOOK_REVIEW_PATTERN = /Hooks need review[\s\S]*Trust all and continue/i;
const HOOK_TRUST_OVERLAY_PATTERN = /Press t to trust all/i;
const INPUT_PROMPT_AFTER_INTERSTITIAL_PATTERN = /^\s*›/m;

function envPrefix(env: Record<string, string>): string[] {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

export const codexProvider: TuiProvider = {
  id: "codex",
  label: "Codex",
  executable: "codex",

  command: {
    permissionFlags: PERMISSION_FLAGS,

    build(args: string[]): string {
      const parts: string[] = ["env", ...envPrefix(LAUNCH_ENV), "codex", "-c", "features.hooks=true"];
      if (!hasPermissionFlag(args, PERMISSION_FLAGS)) {
        parts.push("--yolo");
      }
      for (const arg of args) parts.push(shellEscape(arg));
      return parts.join(" ");
    },

    normalizeResumeArgs(args: string[]): string[] {
      const id = extractResume(args);
      if (!id) return [...args];
      return ["resume", id, ...stripResume(args)];
    },

    normalizeStartArgs(ctx): string[] {
      // Codex rejects --name; it learns its handle via the post-start /rename.
      return stripNameFlag(ctx.args);
    },

    postStartInputs(ctx): readonly string[] {
      return [`/rename ${ctx.handle}`];
    },

    renameInputs(newHandle: string): readonly string[] {
      return [`/rename ${newHandle}`];
    },

    startupInterstitials: [
      // Trust-FOLDER is a separate per-path trust mechanism with no foreign-content
      // notion — opening the folder is itself the trust decision. Stays unguarded.
      { pattern: TRUST_PATTERN, keys: ["Enter"], skipWhenPattern: INPUT_PROMPT_AFTER_INTERSTITIAL_PATTERN },
      // Hooks-review screens are gated by a fail-closed trust predicate: auto-press
      // ONLY when every effective Codex hook is YACO's own canonical command;
      // otherwise the session goes blocked(trust) and waits for a human.
      // Cursor starts on "Review hooks"; Down + Enter picks "Trust all and continue".
      { pattern: HOOK_REVIEW_PATTERN, keys: ["Down", "Enter"], settleMs: 100, skipWhenPattern: INPUT_PROMPT_AFTER_INTERSTITIAL_PATTERN, guard: codexHooksAllYacoOwned, blockReason: "trust" },
      { pattern: HOOK_TRUST_OVERLAY_PATTERN, keys: ["t"], skipWhenPattern: INPUT_PROMPT_AFTER_INTERSTITIAL_PATTERN, guard: codexHooksAllYacoOwned, blockReason: "trust" },
    ],
  },

  detection: {
    idlePatterns: [
      /^\s*›/m, // codex prompt (Unicode ›, U+203A)
    ],
    inputPromptPatterns: [
      /^\s*›/,
    ],
    inputEmptyPatterns: [
      /^\s*›\s*$/,
      /^\s*›\s*Write tests for @filename\s*$/,
    ],
    inputPlaceholderStylePatterns: [
      /\x1b\[2m/,
    ],
  },

  terminal: {
    launchEnv: LAUNCH_ENV,
    respondToColorQuery: true,
  },

  sessionId: {
    pendingValue: PENDING_SESSION_ID,
    envKeys: ["CODEX_THREAD_ID"],
    startResolution: "state-file-only",
    resolve: (ctx) => resolveSessionId(ctx.pid, "codex", ctx.sessionCreatedMs, ctx.sessionPath),
  },

  hooks: codexHooks(),

  history: codexHistory(),

  output: codexOutput(),

  messages: codexMessages(),

  projectMove: codexProjectMove(),
};
