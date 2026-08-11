/** `yaco doctor` — required health checks for a YACO install.
 *
 *  Eleven stable check names per the install/distribution design:
 *    binary, version, yaco-home, registry, skills-link,
 *    agent-hook-config, agent-wrapper, tmux, git, providers, task-graph
 *
 *  Each check returns { name, status: 'pass'|'fail'|'skip', detail }. `skip`
 *  means "nothing to check here" (a legitimate zero state, e.g. a repo that
 *  has no task graph yet) and is counted in neither summary bucket, so it
 *  never trips the exit code.
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
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import { packagedAssetPath } from "../package-root.ts";
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

function which(cmd: string): string | null {
  // Pass env explicitly so process.env mutations (notably PATH overrides in
  // tests) propagate into the child — bun's spawnSync otherwise caches the
  // process-start PATH and ignores later writes to process.env.PATH.
  const r = spawnSync("which", [cmd], { encoding: "utf-8", env: { ...process.env } });
  if (r.status !== 0) return null;
  const out = (r.stdout ?? "").trim();
  return out.length > 0 ? out : null;
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

function checkRegistry(): CheckResult {
  const path = projectsRegistryPath();
  if (!existsSync(path)) return fail("registry", `${path} missing — run \`yaco install\``);
  try {
    const projects = readProjects();
    const yaco = projects.find((p) => p.name === "yaco");
    if (!yaco) return fail("registry", `${path}: no 'yaco' entry`);
    return pass("registry", `${path} (yaco → ${yaco.path})`);
  } catch (e) {
    return fail("registry", `${path}: ${(e as Error).message}`);
  }
}

/** `skills-link` (stable check name): ~/.claude/skills is a real directory
 *  and every skill shipped by the registered yaco checkout resolves inside
 *  it. The manifest is the checkout's agent-config/global/skills/ listing,
 *  resolved via the registry's `yaco` entry so the check is cwd-independent.
 *  A same-name entry that is a real directory passes — that is a user
 *  override the installer deliberately keeps. */
function checkSkillsLink(): CheckResult {
  const name = "skills-link";
  const claudeSkills = join(userHome(), ".claude", "skills");
  let repoPath: string;
  try {
    const yaco = readProjects().find((p) => p.name === "yaco");
    if (!yaco) return fail(name, `no 'yaco' registry entry — run \`yaco install\``);
    repoPath = yaco.path;
  } catch (e) {
    return fail(name, `cannot resolve yaco repo from registry: ${(e as Error).message}`);
  }
  const skillsDir = join(repoPath, "agent-config", "global", "skills");
  let manifestIsDir = false;
  try { manifestIsDir = statSync(skillsDir).isDirectory(); } catch { /* missing */ }
  if (!manifestIsDir) {
    return fail(name, `${skillsDir} missing or not a directory — checkout moved? re-run \`yaco install\``);
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
  let skills: string[];
  try {
    skills = readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (e) {
    return fail(name, `cannot read ${skillsDir}: ${(e as Error).message}`);
  }
  const missing = skills.filter((s) => !existsSync(join(claudeSkills, s)));
  if (missing.length > 0) {
    const shown = missing.slice(0, 3).join(", ");
    const more = missing.length > 3 ? `, +${missing.length - 3} more` : "";
    return fail(name, `${missing.length} skill link(s) missing (${shown}${more}) — re-run \`yaco install\``);
  }
  return pass(name, `${claudeSkills} (${skills.length} skills from ${skillsDir})`);
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

function checkCommand(name: string, hint?: string): CheckResult {
  const path = which(name);
  if (!path) return fail(name, hint ?? `${name} not on $PATH`);
  return pass(name, path);
}

function checkTmux(): CheckResult {
  return checkCommand("tmux", "tmux not on $PATH — agent sessions will not start");
}

function checkGit(): CheckResult {
  return checkCommand("git", "git not on $PATH");
}

/** `providers` (stable check name): pass when at least one provider executable
 *  is on $PATH. Detail is registry-driven — each registered provider's
 *  `executable` is probed via `which`. */
function checkProviders(): CheckResult {
  const found: string[] = [];
  const missing: string[] = [];
  for (const provider of listProviders()) {
    const path = which(provider.executable);
    if (path) found.push(`${provider.id}=${path}`);
    else missing.push(provider.id);
  }
  if (found.length === 0) {
    return fail("providers", `no provider executable on $PATH (${missing.join(", ")})`);
  }
  const detail = missing.length > 0
    ? `${found.join("; ")}; ${missing.join(", ")} missing`
    : found.join("; ");
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
    if (!report.ok) {
      const problems = report.details ?? {};
      const count = Object.values(problems).flat().length;
      return fail("task-graph", `${count} integrity problem(s) in ${tasksPath}`);
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
