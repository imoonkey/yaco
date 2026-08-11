#!/usr/bin/env node
/** The temporary dual runner (design §5 stage 2).
 *
 *  While the suite is half-migrated, which runner owns a test file is a fact
 *  about the file: it imports `vitest` or it imports `bun:test`. This script
 *  reads that fact and runs both cohorts, so no hand-maintained list can drift
 *  from the tree — the drift that left `test/wrapper-resolve.test.ts` in no
 *  suite at all for a whole task.
 *
 *  Fail-closed: a test file that names neither runner, or both, is an error
 *  rather than a file that quietly runs nowhere.
 *
 *  Usage: `node test/cohorts.mjs unit|integration`
 *  Deleted by `cli-sqlite-hop`, which leaves `vitest run`.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_ROOT = join(CLI_ROOT, "test");

const SUITES = {
  unit: (rel) => !rel.startsWith("test/integration/"),
  integration: (rel) => rel.startsWith("test/integration/"),
};

function testFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(path));
    else if (/\.(test|integration)\.ts$/.test(entry.name)) out.push(relative(CLI_ROOT, path));
  }
  return out;
}

/** Which runner the file imports. Exactly one, or the tree is broken. */
function cohortOf(rel) {
  const source = readFileSync(join(CLI_ROOT, rel), "utf-8");
  const bun = /from\s*["']bun:test["']/.test(source);
  const vitest = /from\s*["']vitest["']/.test(source);
  if (bun && vitest) throw new Error(`${rel} imports both bun:test and vitest — pick one`);
  if (!bun && !vitest) throw new Error(`${rel} imports neither bun:test nor vitest — it would run in no cohort`);
  return bun ? "bun" : "vitest";
}

function run(label, command, args) {
  console.error(`\n=== ${label}: ${command} ${args.slice(0, 3).join(" ")} … (${args.length} args)`);
  const result = spawnSync(command, args, { cwd: CLI_ROOT, stdio: "inherit" });
  return result.status === 0;
}

const suite = process.argv[2];
if (!Object.hasOwn(SUITES, suite)) {
  console.error(`usage: node test/cohorts.mjs ${Object.keys(SUITES).join("|")}`);
  process.exit(2);
}

const files = testFiles(TEST_ROOT).filter(SUITES[suite]);
const cohorts = { bun: [], vitest: [] };
for (const file of files) cohorts[cohortOf(file)].push(file);

console.error(`${suite}: ${cohorts.vitest.length} vitest + ${cohorts.bun.length} bun = ${files.length} files`);

// Integration files own tmux sessions, the installed binary, and real
// checkouts; they have always run one at a time and still must.
const sequential = suite === "integration";

const results = [];
if (cohorts.vitest.length) {
  const args = ["vitest", "run", ...(sequential ? ["--no-file-parallelism"] : []), ...cohorts.vitest];
  results.push(["vitest", run("vitest cohort", "npx", args)]);
}
// `./` matters: a bare path is a name *filter* to `bun test`, and an
// `.integration.ts` file matches no filter at all.
const bunPaths = cohorts.bun.map((file) => `./${file}`);
for (const batch of bunPaths.length === 0 ? [] : sequential ? bunPaths.map((f) => [f]) : [bunPaths]) {
  results.push(["bun", run("bun cohort", "bun", ["test", ...batch])]);
}

console.error(`\n=== ${suite} cohorts`);
for (const [name, ok] of results) console.error(`  ${name}: ${ok ? "pass" : "FAIL"}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
