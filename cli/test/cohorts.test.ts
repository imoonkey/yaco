/** The dual runner's partition rule, which decides whether a test file runs at all.
 *
 *  Every case here is a way a file has been, or could be, assigned to a cohort
 *  by prose rather than by an import — which reads as covered while the file
 *  runs nothing. The other half of that hazard, a cohort reporting success
 *  without running what it was handed, is checked against `bun test`'s run
 *  summary in `cohorts.mjs` itself.
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
    // console-scraping check reads the lie. The JUnit report is not written at
    // all when nothing ran, and only the runner writes it.
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

  it("accepts a file that really runs a test", () => {
    const { path, cleanup } = fixture(`import { test, expect } from "bun:test";\ntest("x", () => expect(1).toBe(1));\n`);
    try {
      expect(runBunFile(path)).toBe(true);
    } finally {
      cleanup();
    }
  });
});
