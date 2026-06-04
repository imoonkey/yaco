/** `yaco install` — canonical, idempotent installer.
 *
 *  Two-stage bootstrap per design:
 *    1. `tools/install.sh` builds the bun binary into $BIN_DIR/yaco, codesigns
 *       on macOS, then `exec "$BIN_DIR/yaco" install "$@"`.
 *    2. `yaco install` (this module) does the rest: npm deps, hook merge,
 *       wrapper write, global agent-config symlinks, projects.json upsert,
 *       legacy bin cleanup, and a trailing `yaco doctor` run.
 *
 *  Re-running `yaco install` MUST be a no-op (idempotent). `--dry-run`
 *  prints the planned action list to stderr without touching the
 *  filesystem.
 *
 *  Hook merge is delegated to ensureHooks() from lib/core/agent/lifecycle,
 *  which preserves all unrelated entries in ~/.claude/settings.json and
 *  ~/.codex/hooks.json (the canonical merge implementation lives there).
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { CliError, ErrCode } from "../lib/core/errors.ts";
import { ok, type Result } from "../lib/core/result.ts";
import {
  agentWrapperPath,
  ensureYacoHome,
  getYacoHome,
  projectsRegistryPath,
  readProjects,
  writeProjects,
  type Project,
} from "../lib/core/paths/index.ts";
import {
  ensureClaudeHooks,
  ensureCodexHooks,
  readAgentWrapperScript,
} from "../lib/core/agent/lifecycle.ts";
import { runAllChecks } from "./doctor.ts";

/** Read the agent-wrapper.sh body. Prefers the packaged path
 *  (readAgentWrapperScript via import.meta.url) which works under bun run,
 *  but falls back to ${YACO_REPO_ROOT}/cli/scripts/agent-wrapper.sh — the
 *  source-of-truth location — because the bun-compiled binary's VFS does
 *  not expose script siblings of import.meta.url. The two paths point at
 *  the same on-disk file at install time. */
function readWrapperBody(repoRoot: string): string {
  try {
    return readAgentWrapperScript();
  } catch {
    const fallback = join(repoRoot, "cli", "scripts", "agent-wrapper.sh");
    return readFileSync(fallback, "utf-8");
  }
}

const HELP = `yaco install — install or refresh YACO on this machine

Usage:
  yaco install [options]

Options:
  --cli-only       Skip app/server and app/ui npm install
  --skip-hooks     Skip merging provider hooks into ~/.claude + ~/.codex
                   (the wrapper script is still written)
  --no-registry    Do not upsert this repo into \${YACO_HOME}/projects.json
  --skip-doctor    Do not run \`yaco doctor\` after install
  --dry-run        Print planned actions to stderr without changing files
  --repo <path>    Override the repo root (default: \$YACO_REPO_ROOT or cwd)
  --bin-dir <path> Override the bin dir for legacy symlink cleanup
                   (default: \$YACO_BIN_DIR or \$HOME/.local/bin)
  --json           Emit the {ok,data}/{ok,error} envelope
  --help           Show this help
`;

interface InstallOptions {
  cliOnly: boolean;
  skipHooks: boolean;
  noRegistry: boolean;
  skipDoctor: boolean;
  dryRun: boolean;
  repoRoot?: string;
  binDir?: string;
  json: boolean;
}

export interface InstallReport {
  repoRoot: string;
  binDir: string;
  yacoHome: string;
  dryRun: boolean;
  actions: string[];
}

function defaultOptions(): InstallOptions {
  return {
    cliOnly: false,
    skipHooks: false,
    noRegistry: false,
    skipDoctor: false,
    dryRun: false,
    json: false,
  };
}

function parseOpts(argv: string[]): InstallOptions {
  const out = defaultOptions();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--cli-only": out.cliOnly = true; continue;
      case "--skip-hooks": out.skipHooks = true; continue;
      case "--no-registry": out.noRegistry = true; continue;
      case "--skip-doctor": out.skipDoctor = true; continue;
      case "--dry-run": out.dryRun = true; continue;
      case "--json": out.json = true; continue;
    }
    if (a === "--repo" || a.startsWith("--repo=")) {
      const v = a.startsWith("--repo=") ? a.slice("--repo=".length) : argv[++i];
      if (!v) throw new CliError(ErrCode.USAGE, "--repo requires a value");
      out.repoRoot = v; continue;
    }
    if (a === "--bin-dir" || a.startsWith("--bin-dir=")) {
      const v = a.startsWith("--bin-dir=") ? a.slice("--bin-dir=".length) : argv[++i];
      if (!v) throw new CliError(ErrCode.USAGE, "--bin-dir requires a value");
      out.binDir = v; continue;
    }
    throw new CliError(ErrCode.USAGE, `unknown install flag: ${a}`);
  }
  return out;
}

function userHome(): string {
  const env = process.env["HOME"];
  return env && env.length > 0 ? env : homedir();
}

function resolveRepoRoot(opt?: string): string {
  if (opt && opt.length > 0) return resolve(opt);
  const env = process.env["YACO_REPO_ROOT"];
  if (env && env.length > 0) return resolve(env);
  return resolve(process.cwd());
}

function resolveBinDir(opt?: string): string {
  if (opt && opt.length > 0) return resolve(opt);
  const env = process.env["YACO_BIN_DIR"];
  if (env && env.length > 0) return resolve(env);
  return join(userHome(), ".local", "bin");
}

function pathKind(p: string): "missing" | "symlink" | "other" {
  try {
    const st = lstatSync(p);
    return st.isSymbolicLink() ? "symlink" : "other";
  } catch {
    return "missing";
  }
}

/** Idempotent symlink upsert: missing → create; symlink → replace if target
 *  drifted; regular file/dir → refuse with IO error. */
function upsertSymlink(linkPath: string, target: string, actions: string[], dryRun: boolean): void {
  const kind = pathKind(linkPath);
  if (kind === "other") {
    throw new CliError(
      ErrCode.IO,
      `refusing to replace non-symlink at ${linkPath} (move it aside and re-run)`,
    );
  }
  if (kind === "symlink") {
    // Read current target; if it matches, no-op for idempotency.
    let current: string | null = null;
    try { current = readlinkSync(linkPath); } catch { /* fall through */ }
    if (current === target) return;
    if (dryRun) {
      actions.push(`relink ${linkPath} -> ${target}`);
      return;
    }
    unlinkSync(linkPath);
  } else if (dryRun) {
    actions.push(`symlink ${linkPath} -> ${target}`);
    return;
  }
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath);
  actions.push(`symlink ${linkPath} -> ${target}`);
}

/** Remove a path iff it is a symlink (never touches regular files). */
function removeLegacySymlink(p: string, actions: string[], dryRun: boolean): void {
  if (pathKind(p) !== "symlink") return;
  if (dryRun) {
    actions.push(`remove legacy symlink ${p}`);
    return;
  }
  unlinkSync(p);
  actions.push(`removed legacy symlink ${p}`);
}

/** Write the agent-wrapper.sh script under ${YACO_HOME} if missing or stale. */
function installAgentWrapper(repoRoot: string, actions: string[], dryRun: boolean): void {
  const path = agentWrapperPath();
  const content = readWrapperBody(repoRoot);
  if (existsSync(path)) {
    const current = readFileSync(path, "utf-8");
    if (current === content) return;
    if (dryRun) {
      actions.push(`update ${path}`);
      return;
    }
  } else if (dryRun) {
    actions.push(`write ${path}`);
    return;
  }
  ensureYacoHome();
  writeFileSync(path, content);
  chmodSync(path, 0o755);
  actions.push(`wrote ${path}`);
}

/** Upsert {id: "yaco", path: repoRoot} into ${YACO_HOME}/projects.json. */
function upsertRegistry(repoRoot: string, actions: string[], dryRun: boolean): void {
  const file = projectsRegistryPath();
  const existing: Project[] = (() => {
    if (!existsSync(file)) return [];
    try { return readProjects(); } catch { return []; }
  })();
  // Drop legacy ids; ensure exactly one yaco entry pointing at repoRoot.
  const filtered = existing.filter((p) => !["workflow", "multmux", "agent-config"].includes(p.name));
  const idx = filtered.findIndex((p) => p.name === "yaco");
  const target: Project = { name: "yaco", path: repoRoot };
  if (idx >= 0) {
    if (filtered[idx]!.path === repoRoot && filtered.length === existing.length) {
      // No change needed.
      return;
    }
    filtered[idx] = target;
  } else {
    filtered.unshift(target);
  }
  if (dryRun) {
    actions.push(`update registry ${file}`);
    return;
  }
  writeProjects(filtered);
  actions.push(`updated registry ${file}`);
}

/** Install global agent-config symlinks into ~/.claude / ~/.codex / ~/.agents. */
function installGlobalLinks(repoRoot: string, actions: string[], dryRun: boolean): void {
  const home = userHome();
  const claudeMd = join(repoRoot, "agent-config", "global", "CLAUDE.md");
  const skillsDir = join(repoRoot, "agent-config", "global", "skills");
  // Hard precondition: if agent-config/global/CLAUDE.md is missing, refuse to
  // install — silently linking to a non-existent target would mask a broken
  // checkout and only surface as a confusing error from doctor later.
  if (!existsSync(claudeMd)) {
    throw new CliError(
      ErrCode.ENV,
      `missing ${claudeMd} — repo root is not a YACO checkout (or --repo is wrong)`,
    );
  }
  upsertSymlink(join(home, ".claude", "CLAUDE.md"), claudeMd, actions, dryRun);
  upsertSymlink(join(home, ".claude", "skills"), skillsDir, actions, dryRun);
  upsertSymlink(join(home, ".codex", "AGENTS.md"), claudeMd, actions, dryRun);
  upsertSymlink(join(home, ".agents", "skills"), join(home, ".claude", "skills"), actions, dryRun);
}

/** Run npm install in app/server and app/ui (no-op when --cli-only). */
function installAppDeps(repoRoot: string, actions: string[], dryRun: boolean): void {
  for (const sub of ["app/server", "app/ui"] as const) {
    const dir = join(repoRoot, sub);
    if (!existsSync(dir)) continue;
    if (dryRun) {
      actions.push(`npm install in ${dir}`);
      continue;
    }
    const r = spawnSync("npm", ["install"], {
      cwd: dir,
      stdio: "inherit",
      env: { ...process.env },
    });
    if (r.status !== 0) {
      throw new CliError(ErrCode.IO, `npm install failed in ${dir} (exit ${r.status})`);
    }
    actions.push(`npm install in ${dir}`);
  }
}

/** Run the doctor checks in-process and bail if any are failing. */
function runDoctor(actions: string[], dryRun: boolean): void {
  if (dryRun) {
    actions.push(`run yaco doctor`);
    return;
  }
  const report = runAllChecks();
  for (const c of report.checks) {
    process.stderr.write(`doctor: ${c.status.toUpperCase().padEnd(4)} ${c.name} — ${c.detail}\n`);
  }
  if (report.summary.fail > 0) {
    throw new CliError(
      ErrCode.INVALID,
      `yaco doctor: ${report.summary.fail} check(s) failed (run \`yaco doctor\` for details)`,
      report,
    );
  }
  actions.push(`ran yaco doctor (${report.summary.pass} pass)`);
}

/** Pure side-effect driver. Tests call this directly with an opts object. */
export function runInstall(opts: InstallOptions): InstallReport {
  const repoRoot = resolveRepoRoot(opts.repoRoot);
  const binDir = resolveBinDir(opts.binDir);
  const yacoHome = getYacoHome();
  const actions: string[] = [];

  // Always: wrapper script + global links + legacy bin cleanup.
  installAgentWrapper(repoRoot, actions, opts.dryRun);

  if (!opts.skipHooks) {
    if (opts.dryRun) {
      actions.push(`merge ~/.claude/settings.json hooks`);
      actions.push(`merge ~/.codex/hooks.json hooks`);
    } else {
      // Call the per-provider helpers directly (NOT ensureHooks) — they only
      // touch the JSON configs; we already wrote the wrapper above. ensureHooks
      // would re-call readAgentWrapperScript(), which breaks under the
      // bun-compiled binary VFS.
      ensureClaudeHooks();
      ensureCodexHooks();
      actions.push(`merged ~/.claude/settings.json hooks`);
      actions.push(`merged ~/.codex/hooks.json hooks`);
    }
  }

  installGlobalLinks(repoRoot, actions, opts.dryRun);

  // Legacy bin symlinks left over from multmux's prior install footprint.
  removeLegacySymlink(join(binDir, "mt"), actions, opts.dryRun);
  removeLegacySymlink(join(binDir, "multmux"), actions, opts.dryRun);

  if (!opts.cliOnly) {
    installAppDeps(repoRoot, actions, opts.dryRun);
  }

  if (!opts.noRegistry) {
    upsertRegistry(repoRoot, actions, opts.dryRun);
  }

  if (opts.dryRun) {
    // Mirror the action list to stderr so a human running --dry-run sees the
    // plan even when --json captures the structured envelope on stdout.
    for (const a of actions) process.stderr.write(`plan: ${a}\n`);
  }

  if (!opts.skipDoctor) {
    runDoctor(actions, opts.dryRun);
  }

  return { repoRoot, binDir, yacoHome, dryRun: opts.dryRun, actions };
}

export async function handleInstall(
  argv: string[],
  outer: { json: boolean },
): Promise<Result<unknown>> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return ok({ help: HELP });
  }
  const opts = parseOpts(argv);
  opts.json = opts.json || outer.json;
  const report = runInstall(opts);
  return ok(report);
}
