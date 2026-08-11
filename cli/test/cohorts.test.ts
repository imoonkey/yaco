/** The dual runner's two rules, which together decide whether a test file runs at all.
 *
 *  `cohort partition` covers the ways a file could be assigned to a cohort by
 *  prose rather than by an import — which reads as covered while the file runs
 *  nothing. `bun cohort verdict` covers the other half: a run reported as a
 *  pass that executed no test. Both halves of that verdict are pinned here,
 *  because they draw on different evidence — the file's own source, read before
 *  bun is spawned, and bun's JUnit report afterwards.
 *
 *  Dies with `test/cohorts.mjs` in `cli-sqlite-hop`.
 */
import { describe, it, expect } from "vitest";
import { classify, runBunFile } from "./cohorts.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const withTest = (head: string) => `${head}\nit("x", () => {});\n`;

describe("cohort partition", () => {
  it("reads ownership from an import declaration", () => {
    expect(classify(withTest(`import { it } from "vitest";`))).toBe("vitest");
    expect(classify(withTest(`import { it } from "bun:test";`))).toBe("bun");
  });

  it("reads a braced multi-line import", () => {
    expect(classify(withTest(`import {\n  describe,\n  it,\n} from "vitest";`))).toBe("vitest");
  });

  it("does not read ownership out of a comment", () => {
    // The whole hazard: a file that only talks about a runner would be
    // classified into that cohort and then run nothing.
    const prose = withTest(` * This file will migrate from "bun:test" later.\n// import { it } from "vitest";`);
    expect(() => classify(prose, "prose.test.ts")).toThrow(/imports neither/);
  });

  it("rejects a file that names no runner", () => {
    expect(() => classify(withTest(`import { ok } from "node:assert";`), "orphan.test.ts"))
      .toThrow(/imports neither bun:test nor vitest/);
  });

  it("rejects a file that names both runners", () => {
    const both = withTest(`import { describe } from "bun:test";\nimport { expect } from "vitest";`);
    expect(() => classify(both, "both.test.ts")).toThrow(/imports both/);
  });

  it("accepts a qualified test call", () => {
    expect(classify(`import { it } from "vitest";\nit.sequential("x", () => {});\n`)).toBe("vitest");
  });
});

describe("bun cohort verdict", () => {
  /** Outside the checkout entirely, so a crash between here and the `finally`
   *  cannot leave a stray test file for the next cohort scan — or for
   *  `git status` — to find. */
  function fixture(body: string): { path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "yaco-cohorts-fixture-"));
    const path = join(dir, "case.test.ts");
    writeFileSync(path, body);
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("refuses a zero-test file that prints its own positive summary", () => {
    // `bun test` exits 0 here and the console is shared with the test, so a
    // console-scraping check reads the lie.
    const { path, cleanup } = fixture(
      `import { test } from "bun:test";\n` +
        `console.log("Ran 1 test across 1 file");\n` +
        `console.error('<testsuites name="bun test" tests="99" />');\n`,
    );
    try {
      expect(runBunFile(path)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("refuses a zero-test file that forges the runner's own report", () => {
    // The report path is on the child's `argv` and its directory is enumerable
    // by anyone with the same uid, so a test file can write the report itself.
    // The verdict therefore does not start from anything the run produced: a
    // file that declares no test is rejected before bun is spawned, so the
    // forgery below never executes.
    const { path, cleanup } = fixture(
      `import { test } from "bun:test";\n` +
        `import { readdirSync, writeFileSync } from "node:fs";\n` +
        `import { tmpdir } from "node:os";\n` +
        `import { join } from "node:path";\n` +
        `for (const dir of readdirSync(tmpdir())) {\n` +
        `  if (!dir.startsWith("yaco-cohorts-")) continue;\n` +
        `  writeFileSync(join(tmpdir(), dir, "junit.xml"), '<testsuites name="bun test" tests="99" />');\n` +
        `}\n`,
    );
    try {
      expect(runBunFile(path)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("refuses a file whose declared tests never run", () => {
    // The other half: the source says `test(`, and the run reaches none of it.
    // `bun test` exits 0 and writes no report, which is what catches this.
    const { path, cleanup } = fixture(
      `import { test, expect } from "bun:test";\nprocess.exit(0);\ntest("x", () => expect(1).toBe(1));\n`,
    );
    try {
      expect(runBunFile(path)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("refuses a file whose every case is parked", () => {
    // `skip` and `todo` are counted by bun's `tests` attribute, so the report
    // says 1 for a file that executed nothing.
    for (const parked of ["skip", "todo"]) {
      const { path, cleanup } = fixture(`import { test } from "bun:test";\ntest.${parked}("x", () => {});\n`);
      try {
        expect(runBunFile(path), parked).toBe(false);
      } finally {
        cleanup();
      }
    }
  });

  it("accepts an aliased declarer", () => {
    // `$` and `_` are identifier characters that `\b` does not treat as such.
    const { path, cleanup } = fixture(
      `import { test as $test, expect } from "bun:test";\n$test("x", () => expect(1).toBe(1));\n`,
    );
    try {
      expect(runBunFile(path)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("accepts a file that really runs a test", () => {
    const { path, cleanup } = fixture(`import { test, expect } from "bun:test";\ntest("x", () => expect(1).toBe(1));\n`);
    try {
      expect(runBunFile(path)).toBe(true);
    } finally {
      cleanup();
    }
  });
});
