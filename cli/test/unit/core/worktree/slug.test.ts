/** Pure slug-validation tests — no git, no fs. */
import { describe, expect, it } from "vitest";

import { validateSlug } from "../../../../src/lib/core/worktree/slug.ts";

function isCliError(e: unknown): e is Error & { code?: string } {
  return e instanceof Error;
}

function expectInvalid(slug: string): void {
  let thrown: unknown = null;
  try {
    validateSlug(slug);
  } catch (e) {
    thrown = e;
  }
  if (!isCliError(thrown)) throw new Error(`expected throw for slug='${slug}'`);
  expect((thrown as { code?: string }).code).toBe("USAGE");
}

describe("validateSlug", () => {
  it("accepts simple lowercase alphanumeric", () => {
    expect(() => validateSlug("foo")).not.toThrow();
    expect(() => validateSlug("foo1")).not.toThrow();
    expect(() => validateSlug("1foo")).not.toThrow();
  });

  it("accepts hyphenated slugs", () => {
    expect(() => validateSlug("foo-bar")).not.toThrow();
    expect(() => validateSlug("a-b-c-d")).not.toThrow();
    expect(() => validateSlug("yc-worktree-ts")).not.toThrow();
  });

  it("rejects uppercase", () => {
    expectInvalid("Foo");
    expectInvalid("FOO");
    expectInvalid("foo-Bar");
  });

  it("rejects leading or trailing hyphen", () => {
    expectInvalid("-foo");
    expectInvalid("foo-");
    expectInvalid("-foo-");
  });

  it("rejects whitespace and special characters", () => {
    expectInvalid("foo bar");
    expectInvalid("foo_bar");
    expectInvalid("foo.bar");
    expectInvalid("foo/bar");
  });

  it("rejects empty string", () => {
    expectInvalid("");
  });
});
