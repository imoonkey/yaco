import { describe, it, expect } from "bun:test";
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

  it("routes a known area to its stub handler", async () => {
    const { result, area } = await dispatch(["task"]);
    expect(area).toBe("task");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const v = result.value as { area: string; status: string };
      expect(v.area).toBe("task");
      expect(v.status).toBe("stub");
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
    // Stub handler with --help returns AREA_HELP for that area; we just check
    // that the handler ran and got the trailing args (not the area).
    const { result } = await dispatch(["task", "--help"]);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const v = result.value as { area: string; help: string };
      expect(v.area).toBe("task");
      expect(v.help).toContain("task graph");
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
