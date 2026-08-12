/** `yaco install` — canonical, idempotent installer.
 *
 *  Two-stage bootstrap per design:
 *    1. the package lands on the machine — `npm install -g yaco-cli`, or
 *       `tools/install.sh`, which packs that same tarball, installs it into
 *       $BIN_DIR's prefix and `exec`s `"$BIN_DIR/yaco" install "$@"`. Landing is
 *       inert: it writes files and the `yaco` executable, nothing else.
 *    2. `yaco install` (this module) configures the machine: hook merge, wrapper
 *       write, skill symlinks, legacy bin cleanup, and a trailing `yaco doctor`
 *       run. Everything it plants comes out of the installed package, so none of
 *       it needs a checkout. The two steps that do — `npm install` in the app
 *       workspaces, and registering the yaco repo itself in projects.json — are
 *       skipped when there is no checkout to run them against.
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
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
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
import { listSkillNames, PACKAGED_SKILLS_DIR } from "../package-root.ts";
import { readAgentWrapperScript } from "../lib/core/agent/lifecycle.ts";
import { listProviders } from "../lib/core/agent/providers/index.ts";
import { runAllChecks, type DoctorReport } from "./doctor.ts";

const HELP = `yaco install — install or refresh YACO on this machine

Usage:
  yaco install [options]

Options:
  --cli-only       Skip the workspace-root npm install (the app's dependencies)
  --skip-hooks     Skip merging provider hooks into ~/.claude + ~/.codex
                   (the wrapper script is still written)
  --no-registry    Do not upsert this repo into \${YACO_HOME}/projects.json
  --skip-links     Do not write the ~/.claude/skills per-skill links or the
                   ~/.agents/skills symlink
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

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
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
 *  otherwise silently retarget the user's global `~/.claude/skills` to the
 *  transient install location, breaking the live setup the moment that
 *  location goes away. The default is to refuse;
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
      const sameTarget = realpathOr(resolveLinkTarget(linkPath, current)) === realpathOr(target);
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
function installAgentWrapper(actions: string[], dryRun: boolean): void {
  const path = agentWrapperPath();
  const content = readAgentWrapperScript();
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

/** Whether `repoRoot` is the yaco source repo — the only repo with a "yaco"
 *  registry entry to upsert (see {@link upsertRegistry}).
 *
 *  This asks for repository *identity*, not a directory layout: the marker is
 *  the manifest of the package this command was installed from. A layout marker
 *  would answer yes for any repo that happens to carry an `agent-config/` tree —
 *  someone's dotfiles, another agent-configuration project — and register it
 *  under a reserved name it does not own. */
const CLI_PACKAGE_NAME = "yaco-cli";
function isYacoCheckout(repoRoot: string): boolean {
  try {
    const manifest = readFileSync(join(repoRoot, "cli", "package.json"), "utf-8");
    return (JSON.parse(manifest) as { name?: unknown }).name === CLI_PACKAGE_NAME;
  } catch {
    return false;
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

/** Install the global skills links: ~/.claude/skills is a REAL directory that
 *  yaco and the user's other skill sources share; yaco plants one symlink per
 *  shipped skill (the packaged agent-config/global/skills/ listing IS the
 *  manifest). ~/.agents/skills stays a whole-directory symlink to it.
 *
 *  The manifest is a package asset, located the same way every other one is, so
 *  `npm i -g yaco-cli` installs the skills too and no checkout is involved.
 *  Resolving it from `repoRoot` instead is what made the CLI alone deliver a
 *  third of the product: the skills are what the commands exist to drive.
 *
 *  Purely additive: skills the user put in ~/.claude/skills under other names
 *  coexist untouched, a same-name non-symlink is kept (yaco's link is skipped
 *  with a note, never clobbered — not even with --force), and install never
 *  claims a global instruction file, so a pre-existing ~/.claude/CLAUDE.md is
 *  left exactly as the user wrote it. */
function installGlobalLinks(force: boolean, actions: string[], dryRun: boolean): void {
  const home = userHome();
  const skillsDir = PACKAGED_SKILLS_DIR;
  // Hard precondition: a package that cannot show its own skills is broken, not
  // merely bare — silently linking to a non-existent target would mask that and
  // only surface as a confusing error from doctor later.
  if (!isDirectory(skillsDir)) {
    throw new CliError(
      ErrCode.ENV,
      `missing ${skillsDir} — this yaco-cli installation is incomplete (reinstall it)`,
    );
  }
  const claudeSkills = join(home, ".claude", "skills");
  ensureSkillsContainer(claudeSkills, force, actions, dryRun);
  for (const name of listSkillNames(skillsDir)) {
    plantSkillLink(name, join(claudeSkills, name), join(skillsDir, name), force, actions, dryRun);
  }
  upsertSymlink(join(home, ".agents", "skills"), claudeSkills, force, actions, dryRun);
}

/** Whether a path is a yaco skills directory — the packaged one, or the
 *  `agent-config/global/skills` of a yaco checkout an older install linked to.
 *
 *  Every link this installer ever planted names one, so this is how an upgrade
 *  tells its own past output apart from a link the user chose. Without it, the
 *  move to a packaged manifest would land as 22 links reported "user-managed"
 *  and left pointing into a clone the user is free to delete — a silent no-op
 *  upgrade that only fails much later, when the clone goes.
 *
 *  Shape locates the candidate; identity decides. The layout is not ours alone —
 *  a dotfiles repo or a forked skill source can carry the same three
 *  directories — so the checkout it belongs to has to be a yaco checkout by the
 *  same test {@link isYacoCheckout} applies. Taking the layout as proof would
 *  disconnect that user's own skills, which is precisely what the additive
 *  install promises never to do. Not knowing which clone planted the link is
 *  what makes this a property of the target rather than of this run. */
const SKILLS_DIR_SHAPE = join("agent-config", "global", "skills");
function isYacoSkillsDir(path: string): boolean {
  if (path === PACKAGED_SKILLS_DIR) return true;
  if (!path.endsWith(sep + SKILLS_DIR_SHAPE)) return false;
  return isYacoCheckout(path.slice(0, -(SKILLS_DIR_SHAPE.length + 1)));
}

/** A readlink() result may be relative — resolve it against the link's own
 *  directory, never the process cwd. */
function resolveLinkTarget(linkPath: string, current: string): string {
  return current.startsWith("/") ? current : join(dirname(linkPath), current);
}

/** Make ~/.claude/skills a real directory to merge into.
 *
 *  A pre-existing whole-directory symlink to a yaco skills directory is the
 *  pre-v0.1 layout — migrate it in place (unlink, mkdir; per-skill links
 *  follow), whether it names the packaged manifest or the checkout an older
 *  install pointed it at. A symlink anywhere else keeps the same protection
 *  upsertSymlink gave the old layout: refuse without --force, so an install run
 *  from a transient checkout can't silently capture the user's global skills. */
function ensureSkillsContainer(
  path: string,
  force: boolean,
  actions: string[],
  dryRun: boolean,
): void {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    if (dryRun) {
      actions.push(`create dir ${path}`);
      return;
    }
    mkdirSync(path, { recursive: true });
    actions.push(`create dir ${path}`);
    return;
  }
  if (st.isSymbolicLink()) {
    const current = readlinkSync(path);
    // A dangling link serves nobody, whoever made it — the same rule
    // plantSkillLink applies per skill.
    const dangling = !existsSync(path);
    if (!dangling && !isYacoSkillsDir(resolveLinkTarget(path, current)) && !force) {
      throw new CliError(
        ErrCode.CONFLICT,
        `${path} already points at ${current}; refusing to retarget to a per-skill directory (re-run with --force, or --skip-links to leave it alone)`,
        { linkPath: path, currentTarget: current },
      );
    }
    if (dryRun) {
      actions.push(`migrate ${path}: whole-dir symlink → per-skill links`);
      return;
    }
    unlinkSync(path);
    mkdirSync(path, { recursive: true });
    actions.push(`migrate ${path}: whole-dir symlink → per-skill links`);
    return;
  }
  if (!st.isDirectory()) {
    throw new CliError(
      ErrCode.IO,
      `refusing to replace non-directory at ${path} (move it aside and re-run)`,
    );
  }
}

/** Plant one per-skill symlink, additively: never clobber a user's real
 *  file/dir of the same name; retarget a foreign live symlink only with
 *  --force; always replace a dangling one (it serves nobody).
 *
 *  A live link into some *other* yaco skills directory is not foreign — it is
 *  this installer's own earlier output, from when the manifest was a checkout —
 *  so it is migrated without --force. See {@link isYacoSkillsDir}. */
function plantSkillLink(
  name: string,
  linkPath: string,
  target: string,
  force: boolean,
  actions: string[],
  dryRun: boolean,
): void {
  let st;
  try {
    st = lstatSync(linkPath);
  } catch {
    if (!dryRun) symlinkSync(target, linkPath);
    actions.push(`symlink skill ${name}`);
    return;
  }
  if (!st.isSymbolicLink()) {
    actions.push(`keep ${name}: existing user skill (not a yaco link)`);
    return;
  }
  const current = readlinkSync(linkPath);
  const resolved = resolveLinkTarget(linkPath, current);
  if (realpathOr(resolved) === realpathOr(target)) return;
  const dangling = !existsSync(linkPath);
  if (!dangling && !isYacoSkillsDir(dirname(resolved)) && !force) {
    actions.push(`skip ${name}: links to ${current} (user-managed; --force to retarget)`);
    return;
  }
  if (!dryRun) {
    unlinkSync(linkPath);
    symlinkSync(target, linkPath);
  }
  actions.push(`relink skill ${name}`);
}

/** Whether this checkout's `node_modules` is its own to rewrite.
 *
 *  A linked worktree's is not. `scripts/worktree-provision.sh` builds it as a
 *  *mirror*: every third-party package, and `.package-lock.json` itself, is a
 *  symlink into the main checkout's tree. `npm install` there is a reconciler
 *  pointed at somebody else's data — it would write through those symlinks and
 *  rewrite the main checkout's node_modules from the worktree's branch. So the
 *  step is skipped, and the tool that owns the mirror is named instead.
 *
 *  Git's own marker decides: `.git` is a FILE in a linked worktree (it holds
 *  `gitdir: …`) and a directory in the checkout that owns the repository. */
function ownsItsNodeModules(repoRoot: string): boolean {
  try {
    return !statSync(join(repoRoot, ".git")).isFile();
  } catch {
    return true; // no .git at all — a tarball or an export, not a worktree
  }
}

/** One `npm install` at the workspace ROOT — never inside a member (no-op when
 *  --cli-only, skipped when there is no checkout).
 *
 *  The root is the only place that links `packages/*` into `node_modules`.
 *  Installing in `app/server` and `app/ui` alone left `yaco-codex-transcribe` —
 *  imported bare by `app/server/src/routes/voice.ts`, declared by nobody —
 *  unresolvable, so `npm run start:app` and `scripts/verify.sh` both died on a
 *  clean clone. Invisible on every developer box, each of which has had a root
 *  install run in it at least once. Running at the root loses nothing: both app
 *  packages are workspace members, so the one install covers them too.
 *
 *  DO NOT "fix" that package by declaring it as an app dependency instead:
 *  `app/server/scripts/build.mjs` externalises exactly the *declared*
 *  dependencies and inlines this one precisely because it is not declared.
 *  Declaring it makes the published bundle require a package that is never
 *  published. The linking belongs here, in the install.
 *
 *  Two things disqualify a root, and both report the skip rather than performing
 *  it silently. Repository identity is the first, the same question
 *  {@link upsertRegistry} asks — `npm install` at whatever directory a package
 *  user happened to be standing in is not a step, it is an accident. A linked
 *  worktree is the second: see {@link ownsItsNodeModules}. */
function installWorkspaceDeps(repoRoot: string, actions: string[], dryRun: boolean): void {
  if (!isYacoCheckout(repoRoot)) {
    actions.push(`skipped npm install: ${repoRoot} is not a yaco checkout`);
    return;
  }
  if (!ownsItsNodeModules(repoRoot)) {
    actions.push(
      `skipped npm install: ${repoRoot} is a linked worktree ` +
        `(run \`bash scripts/worktree-provision.sh\` from it instead)`,
    );
    return;
  }
  if (dryRun) {
    actions.push(`npm install in ${repoRoot}`);
    return;
  }
  const r = spawnSync("npm", ["install"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env },
  });
  if (r.status !== 0) {
    throw new CliError(ErrCode.IO, `npm install failed in ${repoRoot} (exit ${r.status})`);
  }
  actions.push(`npm install in ${repoRoot}`);
}

/** Run the doctor checks in-process and bail if any are failing.
 *
 *  `repoRoot` is threaded through so `yaco install --repo X` runs doctor
 *  against X's task graph (not whatever cwd happens to be). When `quiet` is
 *  true, the per-check chatter is suppressed (e.g. when install is running in
 *  --json mode and the stderr stream must stay empty per the CLI contract).
 *  The returned report is always populated; callers fold it into their
 *  envelope when needed. */
async function runDoctor(
  repoRoot: string,
  actions: string[],
  dryRun: boolean,
  quiet: boolean,
): Promise<DoctorReport | undefined> {
  if (dryRun) {
    actions.push(`run yaco doctor`);
    return undefined;
  }
  const report = await runAllChecks(repoRoot);
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
export async function runInstall(opts: InstallOptions): Promise<InstallReport> {
  const repoRoot = resolveRepoRoot(opts.repoRoot);
  const binDir = resolveBinDir(opts.binDir);
  const yacoHome = getYacoHome();
  const actions: string[] = [];

  // Export the bin dir so `yacoExecutable()` writes `<binDir>/yaco` into
  // provider hooks — but ONLY when the caller actually named one, via --bin-dir
  // or $YACO_BIN_DIR. `tools/install.sh` always does, so the bootstrap still
  // names the prefix it just installed into.
  //
  // The default (`~/.local/bin`) is a guess, and exporting a guess here made it
  // outrank a real installation: `npm i -g yaco-cli` into an nvm prefix,
  // followed by `yaco install`, wrote every hook command back to a stale
  // `~/.local/bin/yaco` left over from an older bootstrap. Left unset, the
  // resolver falls through to the executable actually on PATH — the one the
  // user just ran.
  if (opts.binDir || process.env["YACO_BIN_DIR"]) process.env["YACO_BIN_DIR"] = binDir;

  // Always: wrapper script + global links + legacy bin cleanup.
  installAgentWrapper(actions, opts.dryRun);

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
    installGlobalLinks(opts.force, actions, opts.dryRun);
  }

  // Legacy bin symlinks left over from multmux's prior install footprint.
  removeLegacySymlink(join(binDir, "mt"), actions, opts.dryRun);
  removeLegacySymlink(join(binDir, "multmux"), actions, opts.dryRun);

  if (!opts.cliOnly) {
    installWorkspaceDeps(repoRoot, actions, opts.dryRun);
  }

  // The registry entry names the yaco source repo as a project. An `npm i -g`
  // user has no such repo, so there is nothing to register and the step is
  // skipped rather than pointed at whatever directory they were standing in.
  // It is not a capability gap: they register their own repos with
  // `yaco project add`.
  if (!opts.noRegistry) {
    if (isYacoCheckout(repoRoot)) {
      upsertRegistry(repoRoot, opts.force, actions, opts.dryRun);
    } else {
      actions.push(`skipped registry: ${repoRoot} is not a yaco checkout (\`yaco project add\` registers your own repos)`);
    }
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
    doctor = await runDoctor(repoRoot, actions, opts.dryRun, opts.json);
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
  const report = await runInstall(opts);
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
