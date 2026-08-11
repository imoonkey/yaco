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
import { classify } from "./cohorts.mjs";

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
