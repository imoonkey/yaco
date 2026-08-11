#!/usr/bin/env node
/** The temporary dual runner (design §5 stage 2).
 *
 *  While the suite is half-migrated, which runner owns a test file is a fact
 *  about the file: it imports `vitest` or it imports `bun:test`. This script
 *  reads that fact and runs both cohorts, so no hand-maintained list can drift
 *  from the tree — the drift that left `test/wrapper-resolve.test.ts` in no
 *  suite at all for a whole task.
 *
 *  Fail-closed in three places, because "this file ran somewhere" is the whole
 *  point and each of these has silently been false: a file that names neither
 *  runner or both, a suite that selects no files, and a cohort that reports
 *  success without running what it was given — `vitest run` rejects a file with
 *  no test, but `bun test` reports `0 pass / 0 fail` and exits 0.
 *
 *  Usage: `node test/cohorts.mjs unit|integration`
 *  Deleted by `cli-sqlite-hop`, which leaves `vitest run`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_ROOT = join(CLI_ROOT, "test");

const SUITES = {
  unit: (rel) => !rel.startsWith("test/integration/"),
  integration: (rel) => rel.startsWith("test/integration/"),
};

/** An `import`/`export … from "<runner>"` **declaration**, not a mention of one.
 *  Anchored to the start of a line so a `*`-prefixed comment body cannot match,
 *  and `[^;]` spans newlines so a braced multi-line import still does. */
const declares = (source, runner) =>
  new RegExp(`^\\s*(?:import|export)\\b[^;]*?from\\s*["']${runner}["']`, "m").test(source);

/** Which cohort this file's source puts it in. Exactly one, or the tree is broken. */
export function classify(source, rel = "<source>") {
  const bun = declares(source, "bun:test");
  const vitest = declares(source, "vitest");
  if (bun && vitest) throw new Error(`${rel} imports both bun:test and vitest — pick one`);
  if (!bun && !vitest) throw new Error(`${rel} imports neither bun:test nor vitest — it would run in no cohort`);
  return bun ? "bun" : "vitest";
}

function testFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(path));
    else if (/\.(test|integration)\.ts$/.test(entry.name)) out.push(relative(CLI_ROOT, path));
  }
  return out;
}

function announce(label, command, args) {
  console.error(`\n=== ${label}: ${command} ${args.slice(0, 3).join(" ")} … (${args.length} args)`);
}

/** Vitest fails a file that declares no test, so its exit code is the whole answer. */
function runVitest(args) {
  announce("vitest cohort", "npx", args);
  return spawnSync("npx", args, { cwd: CLI_ROOT, stdio: "inherit" }).status === 0;
}

/** The names a file bound from `bun:test` that declare tests — `it`, `test`, and
 *  any `as` alias of them. `expect` and the hooks are deliberately not here: a
 *  file full of `expect(` still declares nothing. */
const DECLARERS = new Set(["it", "test"]);
function declaresTest(source) {
  const braces = /^\s*import\s*\{([^}]*)\}\s*from\s*["']bun:test["']/m.exec(source);
  if (!braces) return false;
  return braces[1].split(",").some((spec) => {
    const [imported, local = imported] = spec.trim().split(/\s+as\s+/).map((s) => s.trim());
    return DECLARERS.has(imported) && new RegExp(`\\b${local}(?:\\.\\w+)*\\s*\\(`).test(source);
  });
}

/** `bun test` exits 0 on a file that declares no test, and a batch's summary
 *  counts that file among the ones it ran — so the exit code is not the whole
 *  answer and a batch tells you nothing about one file. Hence one invocation per
 *  file, and two independent checks around it.
 *
 *  The **source** check is the authoritative one, because it is the only
 *  evidence the child cannot touch: it is read from the checked-in file before
 *  the child exists. Everything the run produces — console output, exit status,
 *  and the report file, whose path the child can read off its own `argv` — is
 *  written by the same process as the tests, so none of it can be authoritative
 *  against a file that sets out to lie. (A file that declares a test and then
 *  never registers it could still forge a count. That is a lie in the tree, not
 *  drift; this runner detects drift.)
 *
 *  The **report** check is the one that catches a file whose declared tests
 *  don't run — an early `process.exit(0)`, a guard that registers nothing. With
 *  zero tests bun writes no report at all, which is the signal. The report is
 *  used rather than the console summary because console output is shared with
 *  the tests, which can print a summary-shaped line of their own.
 *
 *  The path is spelled absolutely because a *bare* path is a name filter to
 *  `bun test`, and an `.integration.ts` file matches no filter at all. */
export function runBunFile(file) {
  const path = resolve(CLI_ROOT, file);
  if (!declaresTest(readFileSync(path, "utf-8"))) {
    console.error(`bun cohort: ${file} imports bun:test and declares no test — nothing the run reports can change that`);
    return false;
  }

  const report = join(mkdtempSync(join(tmpdir(), "yaco-cohorts-")), "junit.xml");
  const args = ["test", "--reporter=junit", `--reporter-outfile=${report}`, path];
  announce("bun cohort", "bun", args);
  try {
    if (spawnSync("bun", args, { cwd: CLI_ROOT, stdio: "inherit" }).status !== 0) return false;

    const tests = existsSync(report) && /<testsuites\b[^>]*\btests="(\d+)"/.exec(readFileSync(report, "utf-8"));
    if (!tests) {
      console.error(`bun cohort: ${file} exited 0 and wrote no test report — refusing to call that a pass`);
      return false;
    }
    if (Number(tests[1]) === 0) {
      console.error(`bun cohort: ${file} ran 0 tests`);
      return false;
    }
    return true;
  } finally {
    rmSync(dirname(report), { recursive: true, force: true });
  }
}

function main(suite) {
  if (!Object.hasOwn(SUITES, suite)) {
    console.error(`usage: node test/cohorts.mjs ${Object.keys(SUITES).join("|")}`);
    process.exit(2);
  }

  const files = testFiles(TEST_ROOT).filter(SUITES[suite]);
  if (files.length === 0) throw new Error(`${suite}: no test files found — the suite would pass by running nothing`);

  const cohorts = { bun: [], vitest: [] };
  for (const file of files) cohorts[classify(readFileSync(join(CLI_ROOT, file), "utf-8"), file)].push(file);

  console.error(`${suite}: ${cohorts.vitest.length} vitest + ${cohorts.bun.length} bun = ${files.length} files`);

  // Integration files own tmux sessions, the installed binary, and real
  // checkouts; they have always run one at a time and still must. (The bun
  // cohort runs one file per process regardless — see `runBunFile`.)
  const sequential = suite === "integration";

  const results = [];
  if (cohorts.vitest.length) {
    results.push(["vitest", runVitest(["vitest", "run", ...(sequential ? ["--no-file-parallelism"] : []), ...cohorts.vitest])]);
  }
  for (const file of cohorts.bun) results.push(["bun", runBunFile(file)]);

  console.error(`\n=== ${suite} cohorts`);
  for (const [name, ok] of results) console.error(`  ${name}: ${ok ? "pass" : "FAIL"}`);
  process.exit(results.every(([, ok]) => ok) ? 0 : 1);
}

if (import.meta.main) main(process.argv[2]);
