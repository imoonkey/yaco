/** `yaco doctor` — required health checks for a YACO install.
 *
 *  Twelve stable check names per the install/distribution design:
 *    binary, version, yaco-home, registry, skills-link, claude-md-link,
 *    agent-hook-config, agent-wrapper, tmux, git, providers, task-graph
 *
 *  Each check returns { name, status: 'pass'|'fail'|'skip', detail }.
 *  --json envelope: { checks: CheckResult[], summary: { pass, fail } }.
 *
 *  `gh` is intentionally NOT included as a separate check — only ever
 *  reported as part of `providers` if at all; doctor's required surface
 *  is exactly the 12 names above so consumers can rely on the contract.
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { ok, type Result } from "../lib/core/result.ts";
import { CliError, ErrCode } from "../lib/core/errors.ts";
import {
  agentWrapperPath,
  getYacoHome,
  projectsRegistryPath,
  readProjects,
  readYacoProjectPaths,
} from "../lib/core/paths/index.ts";
import { loadTasks, validateGraph } from "../lib/core/task/index.ts";

const HELP = `yaco doctor — run YACO health checks

Usage:
  yaco doctor [--json]
  yaco doctor --help

Reports the status of: binary, version, yaco-home, registry, skills-link,
claude-md-link, agent-hook-config, agent-wrapper, tmux, git, providers,
task-graph.
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

/** The 12 required check names — stable contract per the design. Tests
 *  assert this exact list shows up in `yaco doctor --json` output. */
export const REQUIRED_CHECKS = [
  "binary",
  "version",
  "yaco-home",
  "registry",
  "skills-link",
  "claude-md-link",
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
    // import.meta.url-rooted resolution would be more robust, but doctor is
    // already in src/commands/; reading package.json via a relative URL is
    // bun-friendly. Fall through to "0.0.0" on any read failure.
    const url = new URL("../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(url, "utf-8"));
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

function checkSymlinkPresent(name: string, path: string): CheckResult {
  try {
    const st = lstatSync(path);
    if (!st.isSymbolicLink()) return fail(name, `${path}: not a symlink`);
    const target = readlinkSync(path);
    if (!existsSync(path)) return fail(name, `${path} → ${target} (dangling)`);
    return pass(name, `${path} → ${target}`);
  } catch {
    return fail(name, `${path}: missing`);
  }
}

function checkSkillsLink(): CheckResult {
  return checkSymlinkPresent("skills-link", join(userHome(), ".claude", "skills"));
}

function checkClaudeMdLink(): CheckResult {
  return checkSymlinkPresent("claude-md-link", join(userHome(), ".claude", "CLAUDE.md"));
}

function fileContainsYacoHook(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const settings = JSON.parse(readFileSync(path, "utf-8"));
    const hooks = settings?.hooks;
    if (!hooks || typeof hooks !== "object") return false;
    for (const ev of Object.keys(hooks)) {
      const groups = hooks[ev];
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        if (g?.matcher === "yaco-agent-hook") return true;
        for (const h of g?.hooks ?? []) {
          if (typeof h?.command === "string" &&
              /hook-event-bin\.ts\b|\bagent\s+hook-event\b/.test(h.command)) {
            return true;
          }
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

function checkAgentHookConfig(): CheckResult {
  const claude = join(userHome(), ".claude", "settings.json");
  const codex = join(userHome(), ".codex", "hooks.json");
  const okClaude = fileContainsYacoHook(claude);
  const okCodex = fileContainsYacoHook(codex);
  if (okClaude && okCodex) return pass("agent-hook-config", "claude + codex hooks installed");
  if (okClaude) return pass("agent-hook-config", "claude hooks installed (codex missing)");
  if (okCodex) return pass("agent-hook-config", "codex hooks installed (claude missing)");
  return fail("agent-hook-config", "no yaco-agent-hook entries in claude/codex configs");
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

function checkProviders(): CheckResult {
  const claudeP = which("claude");
  const codexP = which("codex");
  if (claudeP && codexP) return pass("providers", `claude=${claudeP}; codex=${codexP}`);
  if (claudeP) return pass("providers", `claude=${claudeP}; codex missing`);
  if (codexP) return pass("providers", `codex=${codexP}; claude missing`);
  return fail("providers", "neither claude nor codex on $PATH");
}

function checkTaskGraph(): CheckResult {
  // Validate in-process against the current repo (YACO_REPO_ROOT env if set,
  // else process.cwd()). Spawning `yaco task validate --json` would force a
  // child bun process and re-pay startup cost; the validate primitives are
  // already pure and re-usable.
  const repoEnv = process.env["YACO_REPO_ROOT"];
  const repoRoot = repoEnv && repoEnv.length > 0 ? repoEnv : process.cwd();
  try {
    const paths = readYacoProjectPaths(repoRoot);
    const tasksFile = join(repoRoot, paths.tasks);
    if (!existsSync(tasksFile)) return fail("task-graph", `${tasksFile} missing`);
    const tasks = loadTasks(tasksFile);
    const report = validateGraph(tasks);
    if (!report.ok) {
      const problems = (report.details as any)?.problems ?? {};
      const count = Object.values(problems).flat().length;
      return fail("task-graph", `${count} integrity problem(s) in ${tasksFile}`);
    }
    return pass("task-graph", `${tasksFile} ok`);
  } catch (e) {
    return fail("task-graph", (e as Error).message);
  }
}

/** Run all 12 required checks and return a structured report. Pure: no
 *  process.exit; callers decide how to react. */
export function runAllChecks(): DoctorReport {
  const checks: CheckResult[] = [
    checkBinary(),
    checkVersion(),
    checkYacoHome(),
    checkRegistry(),
    checkSkillsLink(),
    checkClaudeMdLink(),
    checkAgentHookConfig(),
    checkAgentWrapper(),
    checkTmux(),
    checkGit(),
    checkProviders(),
    checkTaskGraph(),
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
  for (const a of argv) {
    if (a === "--help" || a === "-h") return ok({ help: HELP });
    if (a === "--json") { json = true; continue; }
    throw new CliError(ErrCode.USAGE, `unknown doctor flag: ${a}`);
  }
  const report = runAllChecks();
  if (report.summary.fail > 0) {
    // Non-zero exit via INVALID; include the report in the error details so
    // a --json consumer can still see which check failed.
    throw new CliError(
      ErrCode.INVALID,
      `yaco doctor: ${report.summary.fail} check(s) failed`,
      report,
    );
  }
  if (json) return ok(report);
  return ok({ text: renderText(report) });
}
