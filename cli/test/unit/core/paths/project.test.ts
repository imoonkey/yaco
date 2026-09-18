/** Tests for the fixed project layout's one probe, resolveDocDir. */

import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDocDir } from "../../../../src/lib/core/paths/project.ts";

const TMP_ROOTS: string[] = [];

function tempRepo(...dirs: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "yaco-project-test-"));
  TMP_ROOTS.push(root);
  for (const d of dirs) mkdirSync(join(root, d));
  return root;
}

afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

describe("resolveDocDir", () => {
  it("defaults to docs/ when neither folder exists", () => {
    const root = tempRepo();
    expect(resolveDocDir(root)).toBe(join(root, "docs"));
  });

  it("uses an existing doc/", () => {
    const root = tempRepo("doc");
    expect(resolveDocDir(root)).toBe(join(root, "doc"));
  });

  it("prefers docs/ when both exist", () => {
    const root = tempRepo("doc", "docs");
    expect(resolveDocDir(root)).toBe(join(root, "docs"));
  });
});
