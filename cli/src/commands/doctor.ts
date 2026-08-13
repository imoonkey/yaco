/** `yaco doctor` — required health checks for a YACO install.
 *
 *  Eleven stable check names per the install/distribution design:
 *    binary, version, yaco-home, registry, skills-link,
 *    agent-hook-config, agent-wrapper, tmux, git, providers, task-graph
 *
 *  Each check returns { name, status: 'pass'|'fail'|'skip', detail }. `skip`
 *  means "nothing to check here" (a legitimate zero state: a repo with no task
 *  graph yet, a machine with no agent CLI installed yet) and is counted in
 *  neither summary bucket, so it never trips the exit code.
 *  --json envelope is ALWAYS `{ok:true,data:{checks,summary}}` on stdout —
 *  doctor is a STATUS command, so the schema stays stable even when checks
 *  fail. The exit code reflects summary.fail > 0 (exit 1) vs 0 (exit 0), so
 *  callers can branch on the exit code without having to disambiguate two
 *  envelope shapes.
 *
 *  Like `yaco align poll`, the handler reaches process.exit() directly
 *  (bypassing the dispatcher's render path) because the standard ErrCode
 *  table cannot express "Ok envelope but non-zero exit" cleanly.
 *
 *  `gh` is intentionally NOT included as a separate check — only ever
 *  reported as part of `providers` if at all; doctor's required surface
 *  is exactly the 11 names above so consumers can rely on the contract.
 */
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { listSkillNames, PACKAGED_SKILLS_DIR, packagedAssetPath } from "../package-root.ts";
import { which } from "../lib/core/which.ts";
import { ok, type Result } from "../lib/core/result.ts";
import { CliError, ErrCode } from "../lib/core/errors.ts";
import { emit } from "../lib/core/json.ts";
import {
  agentWrapperPath,
  getYacoHome,
  projectsRegistryPath,
  readProjects,
  readYacoProjectPaths,
} from "../lib/core/paths/index.ts";
import { loadTaskStore, validateGraph } from "../lib/core/task/index.ts";
import { listProviders } from "../lib/core/agent/providers/index.ts";

const HELP = `yaco doctor — run YACO health checks

Usage:
  yaco doctor [--repo <path>] [--json]
  yaco doctor --help

Flags:
  --repo <path>   Repo to use for the task-graph check (default: cwd or
                  \$YACO_REPO_ROOT)
  --json          Emit {ok:true, data:{checks, summary}} on stdout (always —
                  doctor never returns an error envelope; exit code is 1 when
                  any check failed, 0 otherwise)

Reports the status of: binary, version, yaco-home, registry, skills-link,
agent-hook-config, agent-wrapper, tmux, git, providers, task-graph.
`;

export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  checks: CheckResult[];
  summary: { pass: number; fail: number };
}

/** The 11 required check names — stable contract per the design. Tests
 *  assert this exact list shows up in `yaco doctor --json` output. */
export const REQUIRED_CHECKS = [
  "binary",
  "version",
  "yaco-home",
  "registry",
  "skills-link",
  "agent-hook-config",
  "agent-wrapper",
  "tmux",
  "git",
  "providers",
  "task-graph",
] as const;

function userHome(): string {
  const env = process.env["HOME"];
  return env && env.length > 0 ? env : homedir();
}

function pass(name: string, detail: string): CheckResult {
  return { name, status: "pass", detail };
}
function fail(name: string, detail: string): CheckResult {
  return { name, status: "fail", detail };
}
function skip(name: string, detail: string): CheckResult {
  return { name, status: "skip", detail };
}

function isExecutable(path: string): boolean {
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    // mode bit 0o111 — executable for at least one of {user, group, other}.
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function checkBinary(): CheckResult {
  const path = which("yaco");
  if (!path) return fail("binary", "`yaco` not on $PATH — run tools/install.sh");
  if (!isExecutable(path)) return fail("binary", `${path} is not executable`);
  return pass("binary", path);
}

function checkVersion(): CheckResult {
  // Until cli/package.json publishes a real version, mirror it here as
  // the source-of-truth for the doctor report.
  try {
    // The manifest is a package asset, so it is located the same way every
    // other one is. Fall through to "0.0.0" on any read failure — a compiled
    // single-file artifact has no readable package root.
    const pkg = JSON.parse(readFileSync(packagedAssetPath("package.json"), "utf-8"));
    const v = typeof pkg.version === "string" ? pkg.version : "0.0.0";
    return pass("version", v);
  } catch {
    return pass("version", "0.0.0");
  }
}

function checkYacoHome(): CheckResult {
  const home = getYacoHome();
  if (!existsSync(home)) return fail("yaco-home", `${home} missing — run \`yaco install\``);
  try {
    const st = statSync(home);
    if (!st.isDirectory()) return fail("yaco-home", `${home} is not a directory`);
  } catch (e) {
    return fail("yaco-home", `${home}: ${(e as Error).message}`);
  }
  return pass("yaco-home", home);
}

/** `registry` (stable check name): ${YACO_HOME}/projects.json is readable.
 *
 *  An absent file is a legitimate zero state — `yaco install` writes the "yaco"
 *  entry only when it ran against a checkout, and an `npm i -g yaco-cli` user
 *  registers their own repos with `yaco project add` when they have one. So it
 *  skips, and a file that is there but unreadable still fails.
 *
 *  It no longer asserts a "yaco" entry: nothing reads one any more. `skills-link`
 *  was the last consumer, and it now resolves the manifest from the package. */
function checkRegistry(): CheckResult {
  const path = projectsRegistryPath();
  if (!existsSync(path)) {
    return skip("registry", `${path} absent — no projects registered yet (\`yaco project add\`)`);
  }
  try {
    const projects = readProjects();
    return pass("registry", `${path} (${projects.length} project(s))`);
  } catch (e) {
    return fail("registry", `${path}: ${(e as Error).message}`);
  }
}

/** `skills-link` (stable check name): ~/.claude/skills is a real directory
 *  and every skill this package ships resolves inside it. The manifest is the
 *  packaged agent-config/global/skills/ listing — the same one `yaco install`
 *  plants links from, so the check is independent of cwd and of any checkout.
 *  A same-name entry that is a real directory passes — that is a user
 *  override the installer deliberately keeps.
 *
 *  Package-scoped, so it never skips: a package that cannot show its own skills
 *  is broken, and reporting that as "nothing to check here" would hide the one
 *  failure a partial install produces. */
function checkSkillsLink(): CheckResult {
  const name = "skills-link";
  const claudeSkills = join(userHome(), ".claude", "skills");
  const skillsDir = PACKAGED_SKILLS_DIR;
  let manifestIsDir = false;
  try { manifestIsDir = statSync(skillsDir).isDirectory(); } catch { /* missing */ }
  if (!manifestIsDir) {
    return fail(name, `${skillsDir} missing or not a directory — this yaco-cli installation is incomplete (reinstall it)`);
  }
  let st;
  try {
    st = lstatSync(claudeSkills);
  } catch {
    return fail(name, `${claudeSkills}: missing — run \`yaco install\``);
  }
  if (st.isSymbolicLink()) {
    return fail(
      name,
      `${claudeSkills} is a whole-directory symlink (legacy layout) — re-run \`yaco install\` to migrate to per-skill links`,
    );
  }
  if (!st.isDirectory()) return fail(name, `${claudeSkills}: not a directory`);
  // The same enumeration `yaco install` plants links from, so the two readers
  // of the manifest cannot drift — including in order, which decides *which*
  // three of the missing links the detail below names.
  let skills: string[];
  try {
    skills = listSkillNames(skillsDir);
  } catch (e) {
    return fail(name, `cannot read ${skillsDir}: ${(e as Error).message}`);
  }
  const missing = skills.filter((s) => !existsSync(join(claudeSkills, s)));
  if (missing.length > 0) {
    const shown = missing.slice(0, 3).join(", ");
    const more = missing.length > 3 ? `, +${missing.length - 3} more` : "";
    return fail(name, `${missing.length} skill link(s) missing (${shown}${more}) — re-run \`yaco install\``);
  }
  // Every name resolves, which is the pass condition — but not every one need
  // resolve to *our* copy: install keeps a same-name real directory, and
  // retargets a link the user pointed elsewhere only under --force. Saying how
  // many are theirs is the difference between "22 skills" and a report that
  // reads as a clean install while some of it is somebody else's.
  const overrides = skills.filter((s) => !resolvesInside(join(claudeSkills, s), join(skillsDir, s)));
  const note = overrides.length > 0 ? `; ${overrides.length} user override(s)` : "";
  return pass(name, `${claudeSkills} (${skills.length} skills from ${skillsDir}${note})`);
}

/** Whether `entry` is this package's copy of `target` rather than something the
 *  user put at that name. Compared by realpath, so a symlinked home or an alias
 *  of the same file is not mistaken for an override. */
function resolvesInside(entry: string, target: string): boolean {
  try {
    return realpathSync(entry) === realpathSync(target);
  } catch {
    return false;
  }
}

/** `agent-hook-config` (stable check name): pass when at least one provider has
 *  its yaco-owned hook entries installed. Detail is registry-driven — each
 *  provider with a hooks adapter is probed via `hasInstalledHook`. */
function checkAgentHookConfig(): CheckResult {
  const installed: string[] = [];
  const missing: string[] = [];
  for (const provider of listProviders()) {
    if (!provider.hooks) continue;
    if (provider.hooks.hasInstalledHook()) installed.push(provider.id);
    else missing.push(provider.id);
  }
  if (installed.length === 0) {
    return fail("agent-hook-config", "no yaco-agent-hook entries in provider configs");
  }
  const detail = missing.length > 0
    ? `${installed.join(" + ")} hooks installed (${missing.join(", ")} missing)`
    : `${installed.join(" + ")} hooks installed`;
  return pass("agent-hook-config", detail);
}

function checkAgentWrapper(): CheckResult {
  const path = agentWrapperPath();
  if (!existsSync(path)) return fail("agent-wrapper", `${path} missing — run \`yaco install\``);
  if (!isExecutable(path)) return fail("agent-wrapper", `${path} not executable`);
  return pass("agent-wrapper", path);
}

/** How long an executable gets to answer its version flag. Same bound as
 *  `which()`'s own spawn: a binary that cannot print its version in three
 *  seconds is not one doctor should wait on, and a hung one must not hang the
 *  whole run. */
const PROBE_TIMEOUT_MS = 3000;

/** What running an executable proved. `timeout` is its own outcome, not folded
 *  into `broken`: "it did not answer in time" and "it answered that it is
 *  broken" call for different remedies, and a bound that silently reported the
 *  first as the second would make a slow machine look like a dead binary. */
type Probe =
  | { kind: "ok"; version: string }
  | { kind: "broken"; reason: string }
  | { kind: "timeout" };

/** The version flag each executable is probed with — the cheapest call that
 *  still loads the binary and every one of its shared libraries, which is the
 *  whole point: `which()` plus the executable bit passes a file that cannot
 *  load. `tmux -V` is tmux's only version flag and, unlike every other tmux
 *  subcommand, prints and exits without contacting (or starting) a server.
 *  `git` and the agent CLIs answer `--version` and touch no repo or session. */
const TMUX_VERSION_FLAG = "-V";
const VERSION_FLAG = "--version";

/** `detached` reaches `uv_spawn` from `spawnSync` exactly as it does from
 *  `spawn` — the child becomes its own process-group leader — but @types/node
 *  lists it only on the async options. Widened here rather than at the call. */
type ProbeSpawnOptions = SpawnSyncOptionsWithStringEncoding & { detached: boolean };

/** End everything the probe started, whatever became of the probe itself.
 *
 *  `spawnSync`'s own kill on `timeout` reaches only the process it started, and
 *  on every other outcome nothing kills anything at all — so a binary that
 *  forked before it hung, crashed or exited leaves its children running past
 *  the doctor run. `detached` made the probe a process-group leader so this can
 *  end the group instead of the leader, and doing it on ALL outcomes rather
 *  than on the timeout alone is what makes it an invariant worth stating: a
 *  probe leaves nothing behind. A group with no members left is already gone,
 *  which is the ordinary case and arrives here as ESRCH.
 *
 *  Not race-free, and cannot be while the spawn is synchronous: a pgid is
 *  unrecyclable only while its group still has members, so in the microseconds
 *  between `spawnSync` returning an empty group and this kill, a pid wraparound
 *  could in principle seat a new group leader on that id. Closing that would
 *  cost an async spawn — signalling while the leader is provably alive — and
 *  doctor's checks are synchronous. */
function reapProbeGroup(pid: number | undefined): void {
  if (typeof pid !== "number") return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch { /* ESRCH — the group is already gone, which is the normal case */ }
}

function firstLine(out: string | null): string {
  return (out ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

/** Run `path <flag>` and report what happened. Bounded, and `env` is passed
 *  explicitly for the same reason `which()` does it — the tests build a machine
 *  by mutating `process.env.PATH`.
 *
 *  This probe deliberately lives in `doctor` and not in `which()`: that module
 *  is the one `$PATH` lookup shared with `agent status` (a status-bar render)
 *  and `agent start` (a hot path), and neither should execute a binary — a
 *  provider is a Node program and costs hundreds of milliseconds. doctor is the
 *  command whose entire job is to run the checks. */
function probeExecutable(path: string, flag: string): Probe {
  const options: ProbeSpawnOptions = {
    encoding: "utf-8",
    env: { ...process.env },
    timeout: PROBE_TIMEOUT_MS,
    // Its own process group, so everything the probe started can be ended
    // together — see reapProbeGroup below.
    detached: true,
  };
  const r = spawnSync(path, [flag], options);
  reapProbeGroup(r.pid);
  const err = r.error as NodeJS.ErrnoException | undefined;
  // Node reports a blown `timeout` as ETIMEDOUT (and kills with SIGTERM); every
  // other spawn failure — the file vanished between `which` and here, no exec
  // permission — arrives as a different errno.
  if (err?.code === "ETIMEDOUT") return { kind: "timeout" };
  if (err) return { kind: "broken", reason: err.message };
  if (r.status !== 0 || r.signal !== null) {
    // What the binary SAID is the diagnosis — `dyld: Library not loaded: …` is
    // the whole finding; the exit status alone names nothing.
    const how = r.signal !== null ? `killed by ${r.signal}` : `exit ${r.status}`;
    const said = firstLine(r.stderr) || firstLine(r.stdout);
    return { kind: "broken", reason: said.length > 0 ? `${how}: ${said}` : how };
  }
  // A binary that exits 0 while printing nothing loaded fine but told us
  // nothing — reported as that, never as a version. Reading empty output as a
  // real answer is its own incident on this project.
  return { kind: "ok", version: firstLine(r.stdout) || firstLine(r.stderr) };
}

function versionOrSilence(version: string): string {
  return version.length > 0 ? version : "no version output";
}

/** A command yaco cannot work without: absent is a FAIL, and so is present but
 *  unrunnable — the state that reads as healthy to `which` and dies at the
 *  first exec (a Homebrew symlink into a Cellar whose dylib is long gone). A
 *  pass reports the version the binary PRINTED, which is worth having on its
 *  own: skew between two installed tmux binaries has caused a real incident. */
function checkCommand(name: string, flag: string, hint: string): CheckResult {
  const path = which(name);
  if (!path) return fail(name, hint);
  const probe = probeExecutable(path, flag);
  if (probe.kind === "timeout") {
    return fail(name, `${path}: \`${name} ${flag}\` did not answer within ${PROBE_TIMEOUT_MS}ms`);
  }
  if (probe.kind === "broken") {
    return fail(name, `${path}: cannot execute — ${probe.reason}`);
  }
  return pass(name, `${path} (${versionOrSilence(probe.version)})`);
}

function checkTmux(): CheckResult {
  return checkCommand("tmux", TMUX_VERSION_FLAG, "tmux not on $PATH — agent sessions will not start");
}

function checkGit(): CheckResult {
  return checkCommand("git", VERSION_FLAG, "git not on $PATH");
}

/** `providers` (stable check name): pass when at least one provider executable
 *  is on $PATH AND runs, skip when none is usable. Detail is registry-driven —
 *  each registered provider's `executable` is located with `which` and then
 *  actually run.
 *
 *  A provider that is present but cannot execute does not count as found — it
 *  cannot start an agent — but it is still not a FAIL, for the same reason an
 *  absent one is not: `yaco install` throws on any failing check, and a
 *  provider's state must never block an install. The two situations are told
 *  apart in words instead: "not installed" vs "installed but cannot execute",
 *  naming the path and what running it produced.
 *
 *  YACO ships no agent, so a machine with none installed yet is a legitimate
 *  zero state — the same shape as `registry` and `task-graph` — and the remedy
 *  is outside everything `yaco install` owns: it cannot install `claude` for
 *  you. Failing here would throw the documented first command of anyone who
 *  installed this package before an agent CLI. That is what separates it from
 *  the package-scoped checks, which stay fail-closed because a missing packaged
 *  asset IS something this package owns.
 *
 *  The skip still says so: it names every provider that is missing and what to
 *  do about it, and skips print in text mode and in install's own check lines. */
function checkProviders(): CheckResult {
  const usable: string[] = [];
  const phrases: string[] = [];
  for (const provider of listProviders()) {
    const path = which(provider.executable);
    if (!path) {
      phrases.push(`${provider.id} not installed`);
      continue;
    }
    const probe = probeExecutable(path, VERSION_FLAG);
    if (probe.kind === "ok") {
      usable.push(provider.id);
      phrases.push(`${provider.id}=${path} (${versionOrSilence(probe.version)})`);
    } else if (probe.kind === "timeout") {
      phrases.push(
        `${provider.id}=${path} installed but did not answer \`${VERSION_FLAG}\` within ${PROBE_TIMEOUT_MS}ms`,
      );
    } else {
      phrases.push(`${provider.id}=${path} installed but cannot execute: ${probe.reason}`);
    }
  }
  const detail = phrases.join("; ");
  if (usable.length === 0) {
    return skip("providers", `no usable provider (${detail}) — install one before starting agents`);
  }
  return pass("providers", detail);
}

/** Why a path `existsSync` denies is nonetheless there — some component of it
 *  dangles, or walls us out — or null when it is genuinely absent.
 *
 *  Climbs to the nearest component that exists on disk. `lstat` does not follow
 *  symlinks, so the first component it can stat is either a real ancestor (the
 *  path below it is simply not there) or a link pointing nowhere — which is
 *  breakage at any depth: `plan -> /moved/private-plan` breaks `plan/tasks`
 *  exactly as `plan/tasks -> /moved` does. */
function unreadableReason(path: string): string | null {
  for (let cur = path; ; cur = dirname(cur)) {
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(cur);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") return err.message;
      if (dirname(cur) === cur) return null; // hit the filesystem root
      continue;
    }
    if (!entry.isSymbolicLink() || existsSync(cur)) return null;
    return cur === path ? "dangling symlink" : `dangling symlink at ${cur}`;
  }
}

async function checkTaskGraph(repoRoot: string): Promise<CheckResult> {
  // Validate in-process: callers thread the resolved repoRoot in (install
  // passes --repo through; the doctor handler resolves the flag/env/cwd
  // precedence chain before calling). Spawning `yaco task validate --json`
  // would force a child bun process and re-pay startup cost; the validate
  // primitives are already pure and re-usable.
  try {
    // The skip below claims "this repo has no task graph yet" — a claim that
    // presupposes a repo. A --repo that is not there is bad input, so it
    // fails, and it also bounds the climb in unreadableReason() to the repo.
    if (!existsSync(repoRoot)) {
      return fail("task-graph", `${repoRoot}: repo root does not exist`);
    }
    const paths = readYacoProjectPaths(repoRoot);
    const tasksPath = join(repoRoot, paths.tasks);
    if (!existsSync(tasksPath)) {
      // No tasks tree is the zero state of an unplanned repo (a fresh clone
      // has none), not breakage — skip, so `yaco install` on a fresh clone
      // still exits 0. But existsSync also denies a path that is *there* and
      // merely unreadable — a symlink dangling at an extracted store, a
      // permission wall — and that is breakage, so it fails. So does a tree
      // that loads but does not validate.
      const reason = unreadableReason(tasksPath);
      if (reason === null) {
        return skip("task-graph", `${tasksPath} absent — no task graph yet (\`yaco task set\` creates one)`);
      }
      return fail("task-graph", `${tasksPath}: ${reason}`);
    }
    const store = await loadTaskStore(tasksPath);
    const report = validateGraph(store.tasks);
    if (report.malformed) {
      const problems = report.details ?? {};
      const count = Object.values(problems).flat().length;
      return fail("task-graph", `${count} integrity problem(s) in ${tasksPath}`);
    }
    // A stale blockReason is not breakage: the graph loads, and the next
    // `yaco task set` on that task drops it. Failing here would make one
    // leftover field throw `yaco install` — see ValidationReport.malformed.
    // Named, not fatal.
    const stale = report.details?.staleBlockReason.length ?? 0;
    if (stale > 0) {
      return pass(
        "task-graph",
        `${tasksPath} ok — ${stale} task(s) carry a stale blockReason ` +
          "(`yaco task validate` lists them)",
      );
    }
    return pass("task-graph", `${tasksPath} ok`);
  } catch (e) {
    return fail("task-graph", (e as Error).message);
  }
}

/** Resolve the repo used by the task-graph check: explicit > env > cwd. */
export function resolveDoctorRepo(repoFlag?: string): string {
  if (repoFlag && repoFlag.length > 0) return repoFlag;
  const env = process.env["YACO_REPO_ROOT"];
  if (env && env.length > 0) return env;
  return process.cwd();
}

/** Run all 11 required checks and return a structured report. Pure: no
 *  process.exit; callers decide how to react. */
export async function runAllChecks(repoRoot?: string): Promise<DoctorReport> {
  const resolvedRepo = resolveDoctorRepo(repoRoot);
  const checks: CheckResult[] = [
    checkBinary(),
    checkVersion(),
    checkYacoHome(),
    checkRegistry(),
    checkSkillsLink(),
    checkAgentHookConfig(),
    checkAgentWrapper(),
    checkTmux(),
    checkGit(),
    checkProviders(),
    await checkTaskGraph(resolvedRepo),
  ];
  const summary = { pass: 0, fail: 0 };
  for (const c of checks) {
    if (c.status === "pass") summary.pass++;
    else if (c.status === "fail") summary.fail++;
    // skip is omitted from the summary per the doctor envelope contract.
  }
  return { checks, summary };
}

/** Render a doctor report as human-readable text. */
function renderText(report: DoctorReport): string {
  const lines: string[] = ["yaco doctor"];
  for (const c of report.checks) {
    const tag = c.status === "pass" ? "PASS " : c.status === "fail" ? "FAIL " : "SKIP ";
    lines.push(`  ${tag} ${c.name.padEnd(20)} ${c.detail}`);
  }
  lines.push(`  ${report.summary.pass} pass, ${report.summary.fail} fail`);
  return lines.join("\n") + "\n";
}

export async function handleDoctor(
  argv: string[],
  outer: { json: boolean },
): Promise<Result<unknown>> {
  let json = outer.json;
  let repoFlag: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") return ok({ help: HELP });
    if (a === "--json") { json = true; continue; }
    if (a === "--repo" || a.startsWith("--repo=")) {
      const v = a.startsWith("--repo=") ? a.slice("--repo=".length) : argv[++i];
      if (!v) throw new CliError(ErrCode.USAGE, "--repo requires a value");
      repoFlag = v;
      continue;
    }
    throw new CliError(ErrCode.USAGE, `unknown doctor flag: ${a}`);
  }
  const report = await runAllChecks(repoFlag);
  // doctor is a STATUS command: the --json envelope ALWAYS uses the success
  // shape so the data.checks / data.summary schema is stable even when checks
  // fail. The exit code (0 vs 1) carries the pass/fail signal, mirroring the
  // align poll convention. Bypass the dispatcher's render path because it
  // would map any non-zero exit to an error envelope.
  if (json) {
    emit({ ok: true, data: report });
    process.exit(report.summary.fail > 0 ? 1 : 0);
  }
  process.stdout.write(renderText(report));
  process.exit(report.summary.fail > 0 ? 1 : 0);
}
