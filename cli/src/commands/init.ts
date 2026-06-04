/** `yaco init <subcommand>` — initialize a YACO project.
 *
 *  Today the only subcommand is `links`, a strict port of
 *  agent-config/global/skills/init-all/scripts/init-symlinks.sh:
 *
 *      .agents/  -> .claude/      (Codex project-skills path)
 *      .codex/   -> .claude/      (Codex alt path)
 *      AGENTS.md -> CLAUDE.md     (Codex)
 *      GEMINI.md -> CLAUDE.md     (Gemini)
 *
 *  The shell helper warned-and-skipped when CLAUDE.md was missing or when
 *  a non-symlink already sat at a target path. This port hardens both
 *  paths:
 *
 *    • Missing CLAUDE.md is a hard precondition failure (ENV → exit 3),
 *      so callers can't silently end up with broken AGENTS.md / GEMINI.md
 *      symlinks pointing at nothing.
 *    • A regular file or directory at a target path refuses to clobber
 *      (IO → exit 1), so we never destroy user data.
 *    • An existing symlink at a target path is removed and re-created so
 *      the command stays idempotent even if the target moved.
 */

import {
  lstatSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { CliError, ErrCode } from "../lib/core/errors.ts";
import { ok, type Result } from "../lib/core/result.ts";

const HELP = `yaco init — initialize a YACO project

Usage:
  yaco init links [--cwd <path>] [--json]
  yaco init --help

Subcommands:
  links   Create multi-tool compatibility symlinks in the project root
          (.agents/, .codex/, AGENTS.md, GEMINI.md). Requires CLAUDE.md
          to already exist. Refuses to overwrite a non-symlink at any
          target path; replaces existing symlinks idempotently.

Flags:
  --cwd <path>   Operate in <path> instead of the current directory
`;

interface LinkPlan {
  /** Path to create, relative to the project root. */
  name: string;
  /** Symlink target (also relative to the project root). */
  target: string;
}

const LINKS: ReadonlyArray<LinkPlan> = [
  { name: ".agents", target: ".claude" },
  { name: ".codex", target: ".claude" },
  { name: "AGENTS.md", target: "CLAUDE.md" },
  { name: "GEMINI.md", target: "CLAUDE.md" },
];

export interface LinkAction {
  /** Absolute path of the symlink that was created or replaced. */
  path: string;
  /** Symlink target as recorded on disk (still repo-relative). */
  target: string;
  action: "created" | "replaced";
}

export interface InitLinksResult {
  cwd: string;
  links: LinkAction[];
}

/** Inspect `path` without following symlinks. Used to discriminate
 *  "missing" / "existing symlink" / "existing real file or dir". */
type PathKind = "missing" | "symlink" | "other";

function inspectPath(path: string): PathKind {
  try {
    const st = lstatSync(path);
    return st.isSymbolicLink() ? "symlink" : "other";
  } catch {
    return "missing";
  }
}

/** Pure side-effect helper: create the four standard symlinks under
 *  `cwd`. Tests call this directly with a tmpdir. */
export function runInitLinks(cwd: string): InitLinksResult {
  const root = resolve(cwd);

  // Precondition: CLAUDE.md must already exist (regular file or symlink).
  // Use lstat so a symlink to a not-yet-resolvable target still counts.
  if (inspectPath(join(root, "CLAUDE.md")) === "missing") {
    throw new CliError(
      ErrCode.ENV,
      `no CLAUDE.md found in ${root} — create it before running 'yaco init links'`,
    );
  }

  // The shell helper guaranteed .claude/ existed before symlinking into
  // it. Mirror that so the resulting .agents/.codex symlinks resolve.
  try {
    mkdirSync(join(root, ".claude"), { recursive: true });
  } catch (e) {
    throw new CliError(
      ErrCode.IO,
      `failed to create ${join(root, ".claude")}: ${(e as Error).message}`,
    );
  }

  const actions: LinkAction[] = [];
  for (const { name, target } of LINKS) {
    const path = join(root, name);
    const kind = inspectPath(path);
    if (kind === "other") {
      throw new CliError(
        ErrCode.IO,
        `will not overwrite non-symlink at ${path}`,
      );
    }
    let action: LinkAction["action"] = "created";
    if (kind === "symlink") {
      try {
        unlinkSync(path);
      } catch (e) {
        throw new CliError(
          ErrCode.IO,
          `failed to remove existing symlink at ${path}: ${(e as Error).message}`,
        );
      }
      action = "replaced";
    }
    try {
      symlinkSync(target, path);
    } catch (e) {
      throw new CliError(
        ErrCode.IO,
        `failed to symlink ${path} -> ${target}: ${(e as Error).message}`,
      );
    }
    actions.push({ path, target, action });
  }
  return { cwd: root, links: actions };
}

// ─── Dispatcher ─────────────────────────────────────────────────────────

export async function handleInit(
  argv: string[],
  _opts: { json: boolean },
): Promise<Result<unknown>> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return ok({ help: HELP });
  }
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === "links") {
    return handleInitLinks(rest);
  }

  throw new CliError(
    ErrCode.USAGE,
    `unknown subcommand: init ${sub}. Run \`yaco init --help\`.`,
  );
}

function handleInitLinks(argv: string[]): Result<unknown> {
  let cwd = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") return ok({ help: HELP });
    if (a === "--json") continue;
    if (a === "--cwd" || a.startsWith("--cwd=")) {
      const v = a.startsWith("--cwd=")
        ? a.slice("--cwd=".length)
        : argv[++i];
      if (v === undefined || v === "") {
        throw new CliError(ErrCode.USAGE, "--cwd requires a value");
      }
      cwd = v;
      continue;
    }
    if (a.startsWith("-")) {
      throw new CliError(
        ErrCode.USAGE,
        `unknown flag for 'init links': ${a}`,
      );
    }
    throw new CliError(
      ErrCode.USAGE,
      `yaco init links: unexpected argument '${a}'`,
    );
  }
  return ok(runInitLinks(cwd));
}
