/** Tests for the project-registry sync I/O helpers. */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  projectsRegistryPath,
  readProjects,
  writeProjects,
} from "../../../../src/lib/core/paths/project-registry.ts";

const ORIGINAL = process.env["YACO_HOME"];
const TMP_ROOTS: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "yaco-registry-test-"));
  TMP_ROOTS.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

describe("project-registry", () => {
  beforeEach(() => {
    process.env["YACO_HOME"] = tempRoot();
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env["YACO_HOME"];
    else process.env["YACO_HOME"] = ORIGINAL;
  });

  it("projectsRegistryPath sits inside YACO_HOME", () => {
    expect(projectsRegistryPath()).toBe(
      join(process.env["YACO_HOME"]!, "projects.json"),
    );
  });

  it("readProjects returns [] when projects.json is missing", () => {
    expect(readProjects()).toEqual([]);
  });

  it("writeProjects creates YACO_HOME and persists records as {id, path}", () => {
    writeProjects([{ name: "alpha", path: "/repos/alpha" }]);
    const raw = readFileSync(projectsRegistryPath(), "utf-8");
    expect(JSON.parse(raw)).toEqual([{ id: "alpha", path: "/repos/alpha" }]);
  });

  it("readProjects normalizes on-disk {id, path} to {name, path}", () => {
    writeFileSync(
      projectsRegistryPath(),
      JSON.stringify([{ id: "beta", path: "/repos/beta/" }]),
      "utf-8",
    );
    expect(readProjects()).toEqual([{ name: "beta", path: "/repos/beta" }]);
  });

  it("normalizes trailing slashes and preserves root path", () => {
    writeProjects([
      { name: "root", path: "/" },
      { name: "trail", path: "/x/y///" },
    ]);
    expect(readProjects()).toEqual([
      { name: "root", path: "/" },
      { name: "trail", path: "/x/y" },
    ]);
  });

  it("write/read roundtrip preserves order", () => {
    const projects = [
      { name: "one", path: "/p1" },
      { name: "two", path: "/p2" },
      { name: "three", path: "/p3" },
    ];
    writeProjects(projects);
    expect(readProjects()).toEqual(projects);
    expect(existsSync(projectsRegistryPath())).toBe(true);
  });
});
