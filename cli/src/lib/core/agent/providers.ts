export interface Provider {
  readonly name: string;
  readonly idlePatterns: readonly RegExp[];
  /** Build the shell command to start this provider with passthrough args */
  buildCommand(passthroughArgs: string[]): string;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Permission flags — if any present, don't add default permission flag
const CLAUDE_PERMISSION_FLAGS = [
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--permission-mode",
] as const;

const CODEX_PERMISSION_FLAGS = [
  "--yolo",
  "--dangerously-bypass-approvals-and-sandbox",
  "--full-auto",
  "-a",
  "--ask-for-approval",
  "--sandbox",
] as const;

/** Check if any permission-related flag is present (prefix-based to handle --flag=value) */
function hasPermissionFlag(args: string[], flags: readonly string[]): boolean {
  return args.some(arg => flags.some(flag => arg === flag || arg.startsWith(flag + "=")));
}

/** Strip --name / -n from args (for Codex which doesn't accept it) */
function stripNameFlag(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--name" || arg === "-n") {
      i++; // skip value
    } else if (arg.startsWith("--name=")) {
      // skip
    } else {
      result.push(arg);
    }
  }
  return result;
}

export const PROVIDERS: Record<string, Provider> = {
  claude: {
    name: "claude",
    idlePatterns: [
      /^❯\s/m,          // Claude Code idle prompt (\s matches U+00A0 NBSP that follows ❯)
      />\s*$/m,         // fallback simple prompt
    ],
    buildCommand(passthroughArgs: string[]): string {
      const parts: string[] = ["env", "-u", "CLAUDECODE", "claude"];
      if (!hasPermissionFlag(passthroughArgs, CLAUDE_PERMISSION_FLAGS)) {
        parts.push("--dangerously-skip-permissions");
      }
      for (const arg of passthroughArgs) {
        parts.push(shellEscape(arg));
      }
      return parts.join(" ");
    },
  },
  codex: {
    name: "codex",
    idlePatterns: [
      /^\s*›/m,         // codex prompt (Unicode ›, U+203A)
      />\s*$/m,         // fallback simple prompt
    ],
    buildCommand(passthroughArgs: string[]): string {
      // Strip --name for Codex (it doesn't accept it)
      const args = stripNameFlag(passthroughArgs);
      const parts: string[] = ["env", "COLORTERM=truecolor", "codex", "-c", "features.hooks=true"];
      if (!hasPermissionFlag(args, CODEX_PERMISSION_FLAGS)) {
        parts.push("--yolo");
      }
      for (const arg of args) {
        parts.push(shellEscape(arg));
      }
      return parts.join(" ");
    },
  },
};

// All known idle patterns across all providers, for provider-agnostic detection
export const ALL_IDLE_PATTERNS: readonly RegExp[] = (() => {
  const seen = new Set<string>();
  return Object.values(PROVIDERS)
    .flatMap((p) => p.idlePatterns)
    .filter((pat) => {
      if (seen.has(pat.source)) return false;
      seen.add(pat.source);
      return true;
    });
})();

// Patterns that indicate the agent is actively processing.
// Purely structural — no word lists (Claude Code rotates verbs) and no specific
// spinner chars (Claude Code varies ✳✻✽⏺· across versions/models).
const BUSY_PATTERNS: readonly RegExp[] = [
  /esc to interrupt/i,
  /\(\d+[smh][^)]*\u00b7/,             // Timer with "·" separator: "(5s ·", "(2m 30s ·", "(57m 19s · ↓ ..."
];

function relevantOutputWindow(output: string, tail: number = 40): string {
  const lines = output.split("\n");
  while (lines.length > 0 && !lines[lines.length - 1]!.trim()) {
    lines.pop();
  }
  return lines.slice(-tail).join("\n");
}

export function isIdle(output: string): boolean {
  const lastLines = relevantOutputWindow(output);
  if (!lastLines) return false;
  // Busy indicators only count if they appear in the live UI area (last ~12
  // lines). The MCP-boot "(0s · esc to interrupt)" line scrolls up into
  // history once the prompt comes back; it stays detectable in the broader
  // 40-line window for many seconds, which would otherwise mask idle.
  const liveTail = relevantOutputWindow(output, 12);
  if (BUSY_PATTERNS.some((pat) => pat.test(liveTail))) return false;
  // Check for idle prompt
  return ALL_IDLE_PATTERNS.some((pat) => pat.test(lastLines));
}

export function getProvider(name: string): Provider {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`Unknown provider: ${name}. Available: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return provider;
}
