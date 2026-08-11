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
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));

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
  /** A fixture under `cli/` so `runBunFile`'s CLI_ROOT-relative path resolves,
   *  and outside `test/` so the real cohort scan never sees it. */
  function fixture(body: string): { rel: string; cleanup: () => void } {
    const dir = mkdtempSync(join(CLI_ROOT, ".cohorts-fixture-"));
    writeFileSync(join(dir, "case.test.ts"), body);
    return {
      rel: `${basename(dir)}/case.test.ts`,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  it("refuses a zero-test file that prints its own positive summary", () => {
    // `bun test` exits 0 here and the console is shared with the test, so a
    // console-scraping check reads the lie. The JUnit report is not written at
    // all when nothing ran, and only the runner writes it.
    const { rel, cleanup } = fixture(
      `import { test } from "bun:test";\n` +
        `console.log("Ran 1 test across 1 file");\n` +
        `console.error('<testsuites name="bun test" tests="99" />');\n`,
    );
    try {
      expect(runBunFile(rel)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("accepts a file that really runs a test", () => {
    const { rel, cleanup } = fixture(`import { test, expect } from "bun:test";\ntest("x", () => expect(1).toBe(1));\n`);
    try {
      expect(runBunFile(rel)).toBe(true);
    } finally {
      cleanup();
    }
  });
});
