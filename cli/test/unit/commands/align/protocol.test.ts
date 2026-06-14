/** Pure protocol tests — grammar round-trip + the full transition matrix.
 *
 *  No filesystem: this is the state machine's contract surface. The fs side
 *  (hashing, snapshots, blocking wait) is covered in store.test.ts and the
 *  subprocess suite in align-cli.test.ts.
 */
import { describe, expect, it } from "bun:test";

import {
  formatStatus,
  parseStatus,
  transition,
  type Status,
} from "../../../../src/commands/align/protocol.ts";

describe("parseStatus / formatStatus", () => {
  it("round-trips a well-formed line", () => {
    const s: Status = { seq: 3, next: "CLAUDE", codex: "APPROVE", claude: "PENDING" };
    expect(parseStatus(formatStatus(s))).toEqual(s);
    expect(formatStatus(s)).toBe("SEQ=3 NEXT=CLAUDE CODEX=APPROVE CLAUDE=PENDING");
  });

  it("accepts NEXT=DONE with both APPROVE", () => {
    expect(parseStatus("SEQ=4 NEXT=DONE CODEX=APPROVE CLAUDE=APPROVE")).toEqual({
      seq: 4,
      next: "DONE",
      codex: "APPROVE",
      claude: "APPROVE",
    });
  });

  it.each([
    ["missing NEXT", "SEQ=1 CODEX=PENDING CLAUDE=PENDING"],
    ["missing SEQ", "NEXT=CODEX CODEX=PENDING CLAUDE=PENDING"],
    ["lowercase role", "SEQ=1 NEXT=codex CODEX=PENDING CLAUDE=PENDING"],
    ["bad vote", "SEQ=1 NEXT=CODEX CODEX=YES CLAUDE=PENDING"],
    ["non-numeric SEQ", "SEQ=x NEXT=CODEX CODEX=PENDING CLAUDE=PENDING"],
    ["missing a vote field", "SEQ=1 NEXT=CODEX CODEX=PENDING"],
    ["empty", ""],
  ])("rejects malformed: %s", (_label, line) => {
    expect(parseStatus(line)).toBeNull();
  });
});

describe("transition", () => {
  const codexTurn: Status = { seq: 0, next: "CODEX", codex: "PENDING", claude: "PENDING" };

  it("CHANGES records the vote and resets the other to PENDING", () => {
    // CODEX previously approved; CLAUDE now makes changes → CODEX reset.
    const claudeTurn: Status = { seq: 1, next: "CLAUDE", codex: "APPROVE", claude: "PENDING" };
    expect(transition(claudeTurn, "CLAUDE", "CHANGES")).toEqual({
      seq: 2,
      next: "CODEX",
      codex: "PENDING",
      claude: "CHANGES",
    });
  });

  it("first-mover CHANGES hands to the other, other already PENDING", () => {
    expect(transition(codexTurn, "CODEX", "CHANGES")).toEqual({
      seq: 1,
      next: "CLAUDE",
      codex: "CHANGES",
      claude: "PENDING",
    });
  });

  it("APPROVE while the other is not APPROVE hands off, not DONE", () => {
    const claudeTurn: Status = { seq: 2, next: "CLAUDE", codex: "CHANGES", claude: "PENDING" };
    expect(transition(claudeTurn, "CLAUDE", "APPROVE")).toEqual({
      seq: 3,
      next: "CODEX",
      codex: "CHANGES",
      claude: "APPROVE",
    });
  });

  it("APPROVE when the other already APPROVED reaches DONE", () => {
    const claudeTurn: Status = { seq: 3, next: "CLAUDE", codex: "APPROVE", claude: "PENDING" };
    expect(transition(claudeTurn, "CLAUDE", "APPROVE")).toEqual({
      seq: 4,
      next: "DONE",
      codex: "APPROVE",
      claude: "APPROVE",
    });
  });

  it("seq always advances by exactly 1", () => {
    let s: Status = codexTurn;
    s = transition(s, "CODEX", "CHANGES");
    expect(s.seq).toBe(1);
    s = transition(s, "CLAUDE", "CHANGES");
    expect(s.seq).toBe(2);
  });

  it("DONE is only reachable through mutual APPROVE", () => {
    // A CHANGES handoff can never produce DONE, even if the other was APPROVE.
    const claudeTurn: Status = { seq: 1, next: "CLAUDE", codex: "APPROVE", claude: "PENDING" };
    expect(transition(claudeTurn, "CLAUDE", "CHANGES").next).toBe("CODEX");
  });
});
