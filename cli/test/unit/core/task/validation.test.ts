/** Unit tests for validation predicates (validateTypes + isAcceptCriteriaBlank). */

import { describe, it, expect } from "bun:test";

import {
  isAcceptCriteriaBlank,
  validateTypes,
} from "../../../../src/lib/core/task/index.ts";

describe("validateTypes", () => {
  it("accepts a well-formed payload", () => {
    expect(() =>
      validateTypes({
        parent: null,
        depends: [],
        state: "ready",
        title: "x",
        description: "y",
        acceptCriteria: "ok",
        scope: ["a/**"],
        requireHumanReview: false,
        priority: "high",
        agent: "w-x",
        tags: ["a"],
        estimate: "s",
        worktree: "feat-x",
        workset: "backlog",
      }),
    ).not.toThrow();
  });

  it("rejects bad parent type", () => {
    expect(() => validateTypes({ parent: 1 as unknown })).toThrow(/'parent'/);
  });

  it("rejects bad depends type", () => {
    expect(() => validateTypes({ depends: "x" as unknown })).toThrow(/'depends'/);
  });

  it("rejects unknown priority", () => {
    expect(() => validateTypes({ priority: "urgent" })).toThrow(/priority must be/);
  });

  it("rejects empty agent string", () => {
    expect(() => validateTypes({ agent: "  " })).toThrow(/agent must not be empty/);
  });

  it("rejects non-string tag entries", () => {
    expect(() => validateTypes({ tags: ["ok", 1 as unknown] })).toThrow(/tags must be list of strings/);
  });

  it("rejects blank tag entries", () => {
    expect(() => validateTypes({ tags: ["ok", "  "] })).toThrow(/must not contain empty/);
  });

  it("rejects unknown estimate", () => {
    expect(() => validateTypes({ estimate: "xxl" })).toThrow(/estimate must be/);
  });

  it("rejects unknown blockReason", () => {
    expect(() => validateTypes({ blockReason: "bad" })).toThrow(/blockReason must be/);
  });

  it("rejects bad worktree slug", () => {
    expect(() => validateTypes({ worktree: "-bad-" })).toThrow(/worktree must be a valid slug/);
  });

  it("rejects unknown workset", () => {
    expect(() => validateTypes({ workset: "later" })).toThrow(/workset must be/);
  });

  it("allows null worktree (delete signal)", () => {
    expect(() => validateTypes({ worktree: null })).not.toThrow();
  });

  it("accepts acceptCriteria string and list[str]", () => {
    expect(() => validateTypes({ acceptCriteria: "ok" })).not.toThrow();
    expect(() => validateTypes({ acceptCriteria: ["a", "b"] })).not.toThrow();
  });

  it("rejects acceptCriteria with non-string list entries", () => {
    expect(() => validateTypes({ acceptCriteria: ["a", 1 as unknown] })).toThrow(/acceptCriteria list items/);
  });

  it("rejects acceptCriteria of wrong type", () => {
    expect(() => validateTypes({ acceptCriteria: { x: 1 } })).toThrow(/acceptCriteria must be/);
  });
});

describe("isAcceptCriteriaBlank", () => {
  it("is true for undefined/null/empty/whitespace", () => {
    expect(isAcceptCriteriaBlank(undefined)).toBe(true);
    expect(isAcceptCriteriaBlank(null)).toBe(true);
    expect(isAcceptCriteriaBlank("")).toBe(true);
    expect(isAcceptCriteriaBlank("   ")).toBe(true);
    expect(isAcceptCriteriaBlank([])).toBe(true);
    expect(isAcceptCriteriaBlank([" ", ""])).toBe(true);
  });

  it("is false for any non-blank string or list item", () => {
    expect(isAcceptCriteriaBlank("ok")).toBe(false);
    expect(isAcceptCriteriaBlank(["", "real"])).toBe(false);
  });
});
