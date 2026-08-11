/** Unit tests for the `yaco agent messages` command layer: the strict arg
 *  parser and the compact text renderer. Both are pure; the IO path
 *  (runMessages) and JSON envelopes are covered end-to-end in
 *  test/agent-messages.test.ts. */

import { describe, it, expect } from "vitest";
import { parseMessagesArgs, renderMetaTable } from "../../src/commands/agent/messages.ts";
import { CliError } from "../../src/lib/core/errors.ts";
import type { MessageMeta } from "../../src/lib/core/agent/providers/types.ts";

describe("parseMessagesArgs", () => {
  it("defaults to meta mode", () => {
    expect(parseMessagesArgs(["h"])).toEqual({ handle: "h", mode: { kind: "meta", ts: false } });
    expect(parseMessagesArgs(["h", "--meta"])).toMatchObject({ mode: { kind: "meta" } });
  });

  it("parses index mode, including negative and equal forms", () => {
    expect(parseMessagesArgs(["h", "--index", "3"])).toEqual({ handle: "h", mode: { kind: "index", index: 3 } });
    expect(parseMessagesArgs(["h", "--index", "-1"]).mode).toEqual({ kind: "index", index: -1 });
    expect(parseMessagesArgs(["h", "--index=-2"]).mode).toEqual({ kind: "index", index: -2 });
  });

  it("parses range with open ends and negatives", () => {
    expect(parseMessagesArgs(["h", "--range", "5..10"]).mode).toMatchObject({ range: { from: 5, to: 10 } });
    expect(parseMessagesArgs(["h", "--range", "-20.."]).mode).toMatchObject({ range: { from: -20, to: null } });
    expect(parseMessagesArgs(["h", "--range", "..49"]).mode).toMatchObject({ range: { from: null, to: 49 } });
    expect(parseMessagesArgs(["h", "--range=-10..-1"]).mode).toMatchObject({ range: { from: -10, to: -1 } });
  });

  it("parses role, type, preview, ts (split and equal forms)", () => {
    const m = parseMessagesArgs(["h", "--role", "assistant", "--type=tool_use", "--preview", "--ts"]).mode;
    expect(m).toMatchObject({ kind: "meta", role: "assistant", type: "tool_use", preview: 100, ts: true });
    expect(parseMessagesArgs(["h", "--preview=40"]).mode).toMatchObject({ preview: 40 });
  });

  it("rejects malformed values", () => {
    for (const args of [
      ["h", "--index", "abc"],
      ["h", "--index"],
      ["h", "--range", "1.2.3"],
      ["h", "--role", "bad"],
      ["h", "--preview=0"],
      ["h", "--preview=2000"],
    ]) {
      expect(() => parseMessagesArgs(args)).toThrow(CliError);
    }
  });

  it("rejects missing handle, unknown flags, and extra positionals", () => {
    expect(() => parseMessagesArgs([])).toThrow(CliError);
    expect(() => parseMessagesArgs(["h", "--bogus"])).toThrow(CliError);
    expect(() => parseMessagesArgs(["h", "extra"])).toThrow(CliError);
  });

  it("enforces index/meta-filter exclusivity", () => {
    for (const extra of [["--meta"], ["--role", "user"], ["--type", "text"], ["--range", "0..1"], ["--preview"], ["--ts"]]) {
      expect(() => parseMessagesArgs(["h", "--index", "1", ...extra])).toThrow(CliError);
    }
  });

  it("parses summary mode and rejects combining it with other flags", () => {
    expect(parseMessagesArgs(["h", "--summary"])).toEqual({ handle: "h", mode: { kind: "summary" } });
    for (const extra of [["--index", "1"], ["--meta"], ["--role", "user"], ["--range", "0..1"], ["--preview"], ["--ts"]]) {
      expect(() => parseMessagesArgs(["h", "--summary", ...extra])).toThrow(CliError);
    }
  });
});

describe("renderMetaTable", () => {
  const rows: MessageMeta[] = [
    { index: 0, role: "user", types: ["text"], chars: 540 },
    { index: 1, role: "assistant", types: ["tool_use:Bash"], chars: 1840 },
  ];

  it("renders empty as a sentinel", () => {
    expect(renderMetaTable([], { ts: false, preview: false })).toBe("(no messages)\n");
  });

  it("uses single-letter roles and human-readable chars", () => {
    const out = renderMetaTable(rows, { ts: false, preview: false });
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toContain(" U ");
    expect(lines[0]).toContain("540");
    expect(lines[1]).toContain(" A ");
    expect(lines[1]).toContain("1.8k");
    expect(lines[1]).toContain("tool_use:Bash");
  });

  it("renders first ts absolute and later ts as relative deltas", () => {
    const t0 = "2026-06-11T06:44:00.000Z";
    const t1 = "2026-06-11T06:44:05.000Z"; // +5s
    const withTs: MessageMeta[] = [
      { ...rows[0]!, ts: t0 },
      { ...rows[1]!, ts: t1 },
    ];
    const lines = renderMetaTable(withTs, { ts: true, preview: false }).trimEnd().split("\n");
    expect(lines[0]).toContain("06:44:00");
    expect(lines[1]).toContain("+5s");
  });

  it("renders a missing timestamp as '-'", () => {
    const mixed: MessageMeta[] = [{ ...rows[0]! }]; // ts undefined
    expect(renderMetaTable(mixed, { ts: true, preview: false })).toContain("-");
  });

  it("date-prefixes the anchor only when shown rows span multiple days", () => {
    const spanning: MessageMeta[] = [
      { ...rows[0]!, ts: "2026-06-11T23:59:00.000Z" },
      { ...rows[1]!, ts: "2026-06-12T00:01:00.000Z" }, // +2m, next day
    ];
    const lines = renderMetaTable(spanning, { ts: true, preview: false }).trimEnd().split("\n");
    expect(lines[0]).toContain("2026-06-11 23:59:00");
    expect(lines[1]).toContain("+2m");
  });

  it("appends preview when present", () => {
    const withPrev: MessageMeta[] = [{ ...rows[0]!, preview: "hello there" }];
    expect(renderMetaTable(withPrev, { ts: false, preview: true })).toContain("hello there");
  });
});
