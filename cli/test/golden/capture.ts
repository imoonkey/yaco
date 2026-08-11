/** Golden-matrix capture.
 *
 *  Runs every frozen case against a freshly built hermetic sandbox and records
 *  the four observable outputs the parity baseline is defined over: exit code,
 *  stdout, stderr, and the durable state left under `$YACO_HOME`. Machine-
 *  specific paths are redacted, so a matrix is comparable across checkouts and
 *  runtimes and the only thing a diff can report is behavior.
 *
 *  Usage: `node test/golden/capture.ts --out test/golden/matrix.json` */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { encodeClaudeCwd } from "../../src/lib/core/project/encode.ts";
import { runCli } from "../helpers/cli-process.ts";
import { buildSandbox, type Sandbox } from "./fixture.ts";
import { CASES, CASES_DIGEST, type GoldenCase } from "./cases.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

export interface CaseResult {
  id: string;
  argv: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Redacted-content digest per file under `$YACO_HOME`, path-sorted. */
  durable: Record<string, string>;
}

export interface GoldenMatrix {
  casesDigest: string;
  cases: CaseResult[];
}

/** Strip every path that varies by machine or run. Longest-lived first: the
 *  sandbox root is nested under nothing else we redact. */
function redactor(sandbox: Sandbox): (text: string) => string {
  const encodedRoot = encodeClaudeCwd(sandbox.root);
  return (text) =>
    text
      .replaceAll(sandbox.root, "{SANDBOX}")
      .replaceAll(encodedRoot, "{SANDBOX_ENC}")
      .replaceAll(REPO_ROOT, "{REPO}");
}

/** Every file under `dir`, as repo-independent relative paths, sorted. */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path, base));
    else out.push(relative(base, path));
  }
  return out.sort();
}

function durableState(sandbox: Sandbox, redact: (t: string) => string): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const rel of walk(sandbox.yacoHome)) {
    const content = redact(readFileSync(join(sandbox.yacoHome, rel), "utf-8"));
    digests[rel] = createHash("sha256").update(content).digest("hex").slice(0, 16);
  }
  return digests;
}

function runCase(testCase: GoldenCase): CaseResult {
  const sandbox = buildSandbox();
  const redact = redactor(sandbox);
  const expand = (arg: string): string =>
    arg.replaceAll("{ALPHA}", sandbox.projects.alpha).replaceAll("{BETA}", sandbox.projects.beta);
  const cwd = testCase.cwd === "root" ? sandbox.root : sandbox.projects[testCase.cwd];

  try {
    // The child's PATH is deliberately empty, so the runtime must be named
    // absolutely — which is exactly what `runCli` owns.
    const run = runCli(testCase.argv.map(expand), { cwd, env: sandbox.env });
    return {
      id: testCase.id,
      argv: testCase.argv,
      cwd: testCase.cwd,
      exitCode: run.status,
      stdout: redact(run.stdout ?? ""),
      stderr: redact(run.stderr ?? ""),
      durable: durableState(sandbox, redact),
    };
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
}

export function captureMatrix(): GoldenMatrix {
  return { casesDigest: CASES_DIGEST, cases: CASES.map(runCase) };
}

if (import.meta.main) {
  const outFlag = process.argv.indexOf("--out");
  if (outFlag < 0 || !process.argv[outFlag + 1]) {
    console.error("usage: node test/golden/capture.ts --out <file>");
    process.exit(2);
  }
  const out = resolve(process.argv[outFlag + 1]!);
  writeFileSync(out, JSON.stringify(captureMatrix(), null, 2) + "\n");
  console.error(`captured ${CASES.length} cases (digest ${CASES_DIGEST}) → ${out}`);
}
