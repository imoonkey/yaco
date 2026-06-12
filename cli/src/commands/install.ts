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
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { CliError, ErrCode } from "../lib/core/errors.ts";
import { ok, type Result } from "../lib/core/result.ts";
import { dual } from "../lib/core/render.ts";
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
  readAgentWrapperScript,
  _resetHookBinaryCacheForTests,
} from "../lib/core/agent/lifecycle.ts";
import { listProviders } from "../lib/core/agent/providers/index.ts";
import { runAllChecks, type DoctorReport } from "./doctor.ts";

const HELP = `yaco install — install or refresh YACO on this machine

Usage:
  yaco install [options]

Options:
  --cli-only       Skip app/server and app/ui npm install
  --skip-hooks     Skip merging provider hooks into ~/.claude + ~/.codex
                   (the wrapper script is still written)
  --no-registry    Do not upsert this repo into \${YACO_HOME}/projects.json
  --skip-links     Do not write ~/.claude/* / ~/.codex/* / ~/.agents/* symlinks
  --skip-doctor    Do not run \`yaco doctor\` after install
  --dry-run        Print planned actions to stderr without changing files
  --repo <path>    Override the repo root (default: \$YACO_REPO_ROOT or cwd)
  --bin-dir <path> Override the bin dir for legacy symlink cleanup
                   (default: \$YACO_BIN_DIR or \$HOME/.local/bin)
  --force          Overwrite existing global links + project registry entry
                   whose targets differ from this install (default: refuse)
  --json           Emit the {ok,data}/{ok,error} envelope
  --help           Show this help
`;

interface InstallOptions {
  cliOnly: boolean;
  skipHooks: boolean;
  noRegistry: boolean;
  skipLinks: boolean;
  skipDoctor: boolean;
  dryRun: boolean;
  force: boolean;
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
  doctor?: DoctorReport;
}

function defaultOptions(): InstallOptions {
  return {
    cliOnly: false,
    skipHooks: false,
    noRegistry: false,
    skipLinks: false,
    skipDoctor: false,
    dryRun: false,
    force: false,
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
      case "--skip-links": out.skipLinks = true; continue;
      case "--skip-doctor": out.skipDoctor = true; continue;
      case "--dry-run": out.dryRun = true; continue;
      case "--force": out.force = true; continue;
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

/** Idempotent symlink upsert: missing → create; symlink whose realpath matches
 *  target → no-op; symlink whose realpath differs → CONFLICT (refuse) unless
 *  `force=true`; regular file/dir → refuse with IO error.
 *
 *  The realpath comparison closes the same shape of footgun the registry
 *  rebind fix closed: running `yaco install` from a `.worktrees/<slug>/`
 *  checkout (or from any non-canonical alias of the same repo) would
 *  otherwise silently retarget the user's global `~/.claude/{CLAUDE.md,
 *  skills}` etc. to the transient install location, breaking the live
 *  setup the moment that location goes away. The default is to refuse;
 *  `--force` is the operator escape hatch for legitimate checkout moves.
 *  `--skip-links` skips all global-link writes entirely. */
function upsertSymlink(
  linkPath: string,
  target: string,
  force: boolean,
  actions: string[],
  dryRun: boolean,
): void {
  const kind = pathKind(linkPath);
  if (kind === "other") {
    throw new CliError(
      ErrCode.IO,
      `refusing to replace non-symlink at ${linkPath} (move it aside and re-run)`,
    );
  }
  if (kind === "symlink") {
    // Read current target; if realpaths match, no-op for idempotency.
    let current: string | null = null;
    try { current = readlinkSync(linkPath); } catch { /* fall through */ }
    if (current !== null) {
      const sameTarget = realpathOr(current) === realpathOr(target);
      if (sameTarget) return;
      if (!force) {
        throw new CliError(
          ErrCode.CONFLICT,
          `${linkPath} already points at ${current}; refusing to retarget to ${target} (re-run with --force, or --skip-links to leave it alone)`,
          { linkPath, currentTarget: current, newTarget: target },
        );
      }
    }
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
  const content = readAgentWrapperScript(repoRoot);
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

/** Best-effort realpath that gracefully degrades to the input when the path
 *  doesn't exist (e.g. a stale registry entry pointing at a deleted checkout)
 *  or when realpath can't traverse it. Used only for path-equality checks
 *  where false-equal beats false-different. */
function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Upsert {id: "yaco", path: repoRoot} into ${YACO_HOME}/projects.json.
 *  Refuses to overwrite a malformed registry — operator must repair the file
 *  manually rather than silently lose other project entries.
 *
 *  Also refuses to silently rebind the "yaco" entry when an existing entry
 *  points at a different path. This blocks the worktree footgun where running
 *  `yaco install` from inside a `.worktrees/<slug>/` checkout would otherwise
 *  silently re-register the project at the worktree path and the web app
 *  would then filter every session/task/worktree view through the wrong root.
 *  Pass `--force` to override (e.g. when you actually moved the checkout).
 *
 *  Path equality uses realpath on both sides so symlink aliases of the same
 *  checkout don't false-CONFLICT (e.g. `cd /symlink/to/repo && yaco install`
 *  after the registry was first written from the canonical path). */
function upsertRegistry(repoRoot: string, force: boolean, actions: string[], dryRun: boolean): void {
  const file = projectsRegistryPath();
  let existing: Project[] = [];
  if (existsSync(file)) {
    try {
      existing = readProjects();
    } catch (e) {
      throw new CliError(
        ErrCode.ENV,
        `projects.json: ${(e as Error).message} at ${file}; refusing to overwrite (repair the file or remove it and re-run \`yaco install\`)`,
      );
    }
  }
  // Drop legacy ids; ensure exactly one yaco entry pointing at repoRoot.
  const filtered = existing.filter((p) => !["workflow", "multmux", "agent-config"].includes(p.name));
  const idx = filtered.findIndex((p) => p.name === "yaco");
  const target: Project = { name: "yaco", path: repoRoot };
  if (idx >= 0) {
    const currentPath = filtered[idx]!.path;
    const samePath = realpathOr(currentPath) === realpathOr(repoRoot);
    if (samePath && filtered.length === existing.length) {
      // No change needed.
      return;
    }
    if (!samePath && !force) {
      throw new CliError(
        ErrCode.CONFLICT,
        `projects.json already registers "yaco" at ${currentPath}; refusing to rebind to ${repoRoot} (re-run with --force, or edit ${file})`,
        { existingPath: currentPath, newPath: repoRoot, registryPath: file },
      );
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
function installGlobalLinks(repoRoot: string, force: boolean, actions: string[], dryRun: boolean): void {
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
  upsertSymlink(join(home, ".claude", "CLAUDE.md"), claudeMd, force, actions, dryRun);
  upsertSymlink(join(home, ".claude", "skills"), skillsDir, force, actions, dryRun);
  upsertSymlink(join(home, ".codex", "AGENTS.md"), claudeMd, force, actions, dryRun);
  upsertSymlink(join(home, ".agents", "skills"), join(home, ".claude", "skills"), force, actions, dryRun);

  // Per-user machine config: link USER.md beside CLAUDE.md/AGENTS.md when it
  // exists (gitignored; copied from USER.md.example). Conditional so a checkout
  // without one — e.g. a fresh OSS clone — still installs cleanly.
  const userMd = join(repoRoot, "agent-config", "global", "USER.md");
  if (existsSync(userMd)) {
    upsertSymlink(join(home, ".claude", "USER.md"), userMd, force, actions, dryRun);
    upsertSymlink(join(home, ".codex", "USER.md"), userMd, force, actions, dryRun);
  }
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

/** Run the doctor checks in-process and bail if any are failing.
 *
 *  `repoRoot` is threaded through so `yaco install --repo X` runs doctor
 *  against X's task graph (not whatever cwd happens to be). When `quiet` is
 *  true, the per-check chatter is suppressed (e.g. when install is running in
 *  --json mode and the stderr stream must stay empty per the CLI contract).
 *  The returned report is always populated; callers fold it into their
 *  envelope when needed. */
function runDoctor(
  repoRoot: string,
  actions: string[],
  dryRun: boolean,
  quiet: boolean,
): DoctorReport | undefined {
  if (dryRun) {
    actions.push(`run yaco doctor`);
    return undefined;
  }
  const report = runAllChecks(repoRoot);
  if (!quiet) {
    for (const c of report.checks) {
      process.stderr.write(`doctor: ${c.status.toUpperCase().padEnd(4)} ${c.name} — ${c.detail}\n`);
    }
  }
  if (report.summary.fail > 0) {
    throw new CliError(
      ErrCode.INVALID,
      `yaco doctor: ${report.summary.fail} check(s) failed (run \`yaco doctor\` for details)`,
      report,
    );
  }
  actions.push(`ran yaco doctor (${report.summary.pass} pass)`);
  return report;
}

/** Pure side-effect driver. Tests call this directly with an opts object. */
export function runInstall(opts: InstallOptions): InstallReport {
  const repoRoot = resolveRepoRoot(opts.repoRoot);
  const binDir = resolveBinDir(opts.binDir);
  const yacoHome = getYacoHome();
  const actions: string[] = [];

  // Export the resolved BIN_DIR so lifecycle's hookBinary() resolves to
  // <binDir>/yaco — the canonical form per the install/distribution design.
  // Without this, hook commands written into ~/.claude/settings.json would
  // point at whatever YACO_BIN_DIR happened to be in the calling shell (or
  // an argv[0]-derived path that may not exist post-install).
  process.env["YACO_BIN_DIR"] = binDir;
  // Invalidate any earlier hookBinary cache so the merge writes the canonical
  // path even if a sibling code path has already resolved it.
  _resetHookBinaryCacheForTests();

  // Always: wrapper script + global links + legacy bin cleanup.
  installAgentWrapper(repoRoot, actions, opts.dryRun);

  if (!opts.skipHooks) {
    // Merge yaco-owned hook entries into each provider config. We call the
    // adapter's hooks.install (NOT ensureHooks) — it only touches the JSON
    // config; the wrapper was already written above and must not be re-read.
    for (const provider of listProviders()) {
      const hooks = provider.hooks;
      if (!hooks) continue;
      const configPath = hooks.configPath();
      if (opts.dryRun) {
        actions.push(`merge ${configPath} hooks`);
      } else {
        hooks.install();
        actions.push(`merged ${configPath} hooks`);
      }
    }
  }

  if (!opts.skipLinks) {
    installGlobalLinks(repoRoot, opts.force, actions, opts.dryRun);
  }

  // Legacy bin symlinks left over from multmux's prior install footprint.
  removeLegacySymlink(join(binDir, "mt"), actions, opts.dryRun);
  removeLegacySymlink(join(binDir, "multmux"), actions, opts.dryRun);

  if (!opts.cliOnly) {
    installAppDeps(repoRoot, actions, opts.dryRun);
  }

  if (!opts.noRegistry) {
    upsertRegistry(repoRoot, opts.force, actions, opts.dryRun);
  }

  if (opts.dryRun && !opts.json) {
    // Mirror the action list to stderr so a human running --dry-run sees the
    // plan. Suppressed in --json mode where the structured envelope on stdout
    // is the canonical channel and the CLI contract bans stderr chatter.
    for (const a of actions) process.stderr.write(`plan: ${a}\n`);
  }

  let doctor: DoctorReport | undefined;
  if (!opts.skipDoctor) {
    // Quiet doctor in --json mode so stderr stays empty per the CLI contract;
    // the report is folded into the install envelope under `data.doctor`.
    doctor = runDoctor(repoRoot, actions, opts.dryRun, opts.json);
  }

  return { repoRoot, binDir, yacoHome, dryRun: opts.dryRun, actions, doctor };
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
  return dual(opts.json, report, () => renderInstall(report));
}

/** Concise text confirmation: the (dry-run) plan header plus one line per
 *  action, then the doctor summary when doctor ran. */
function renderInstall(report: InstallReport): string {
  const verb = report.dryRun ? "would install" : "installed";
  const lines = [`${verb} yaco (repo: ${report.repoRoot})`];
  for (const a of report.actions) lines.push(`  ${a}`);
  if (report.doctor) {
    lines.push(`  doctor: ${report.doctor.summary.pass} pass, ${report.doctor.summary.fail} fail`);
  }
  return lines.join("\n") + "\n";
}
