import { describe, it, expect } from "vitest";
import { AREAS, dispatch, helpText } from "../../src/main.ts";
import { isOk, isErr } from "../../src/lib/core/result.ts";

describe("helpText", () => {
  const text = helpText();

  it("lists all eight top-level areas", () => {
    for (const area of AREAS) {
      expect(text).toContain(area);
    }
  });

  it("documents --json and --help global flags", () => {
    expect(text).toContain("--json");
    expect(text).toContain("--help");
  });
});

describe("dispatch", () => {
  it("returns help on empty argv", async () => {
    const { result, json } = await dispatch([]);
    expect(json).toBe(false);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const v = result.value as { help: string };
      expect(v.help).toContain("yaco — YACO unified CLI");
    }
  });

  it("returns help on --help", async () => {
    const { result } = await dispatch(["--help"]);
    expect(isOk(result)).toBe(true);
  });

  it("treats bare --json as 'no area, please show help' rather than an unknown area", async () => {
    const { result, json } = await dispatch(["--json"]);
    expect(json).toBe(true);
    expect(isOk(result)).toBe(true);
  });

  it("routes a known area to its handler (no stubs remain — install is live)", async () => {
    // Pre yc-install-doctor, install/doctor were stub handlers returning
    // {area, status: "stub"}. Both are now live; routing is exercised by
    // confirming the dispatcher hands `paths` to its live handler whose
    // --json output is the runtime path map. (Text mode now returns a
    // `{text}` envelope per the text-render convention, so we assert on JSON.)
    const { result, area } = await dispatch(["paths", "runtime", "--json"]);
    expect(area).toBe("paths");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const v = result.value as { yacoHome: string };
      expect(typeof v.yacoHome).toBe("string");
    }
  });

  it("returns USAGE error for an unknown area", async () => {
    const { result } = await dispatch(["wat"]);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.code).toBe("USAGE");
      expect(result.message).toContain("unknown area");
    }
  });

  it("strips the area token before handing argv to the handler", async () => {
    // `install --help` lands at handleInstall(["--help"]) and returns the
    // install-specific help shape. The dispatcher's job is to peel the area
    // token; the help body is the handler's marker that it actually ran.
    const { result, area } = await dispatch(["install", "--help"]);
    expect(area).toBe("install");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const v = result.value as { help?: string };
      expect(typeof v.help).toBe("string");
      expect(v.help).toContain("yaco install");
    }
  });

  it("task area is live: bare `yaco task` returns help, not a stub", async () => {
    const { result, area } = await dispatch(["task"]);
    expect(area).toBe("task");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const v = result.value as { help?: string };
      expect(typeof v.help).toBe("string");
      expect(v.help).toContain("yaco task");
    }
  });

  it("worktree area is live: bare `yaco worktree` returns help, not a stub", async () => {
    const { result, area } = await dispatch(["worktree"]);
    expect(area).toBe("worktree");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const v = result.value as { help?: string; status?: string };
      expect(typeof v.help).toBe("string");
      expect(v.help).toContain("yaco worktree");
      expect(v.status).toBeUndefined();
    }
  });

  it("agent area is live: bare `yaco agent` returns help, not a stub", async () => {
    const { result, area } = await dispatch(["agent"]);
    expect(area).toBe("agent");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const v = result.value as { help?: string };
      expect(typeof v.help).toBe("string");
      expect(v.help).toContain("yaco agent");
    }
  });

  it("rejects mid-layer provider shortcut `yaco agent claude` with USAGE", async () => {
    const { result } = await dispatch(["agent", "claude"]);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.code).toBe("USAGE");
      expect(result.message).toContain("yaco agent start");
    }
  });
});
