/** Tests for the fixed project layout's one probe, resolveDocsDir. */

import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDocsDir } from "../../../../src/lib/core/paths/project.ts";

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

describe("resolveDocsDir", () => {
  it("defaults to docs/ when neither folder exists", () => {
    const root = tempRepo();
    expect(resolveDocsDir(root)).toBe(join(root, "docs"));
  });

  it("uses an existing doc/", () => {
    const root = tempRepo("doc");
    expect(resolveDocsDir(root)).toBe(join(root, "doc"));
  });

  it("prefers docs/ when both exist", () => {
    const root = tempRepo("doc", "docs");
    expect(resolveDocsDir(root)).toBe(join(root, "docs"));
  });

  it("skips a regular file named like a doc folder", () => {
    const root = tempRepo("doc");
    writeFileSync(join(root, "docs"), "not a folder\n");
    expect(resolveDocsDir(root)).toBe(join(root, "doc"));
  });

  it("accepts a directory symlink", () => {
    const root = tempRepo("real-docs");
    symlinkSync(join(root, "real-docs"), join(root, "docs"));
    expect(resolveDocsDir(root)).toBe(join(root, "docs"));
  });
});
