/** T2: setStatus stamps the durable status-edge generation key (statusEnteredAt)
 *  on a real transition, and leaves it untouched when the same status is
 *  re-affirmed — so re-seeing the same edge never mints a new generation. */
import { describe, it, expect } from "bun:test";
import { setStatus, type BlockReason } from "../../../src/lib/core/agent/model.ts";

type TestStatus = "starting" | "idle" | "blocked";
type TestState = { status: TestStatus; statusEnteredAt?: string; blockReason?: BlockReason };

describe("setStatus — statusEnteredAt", () => {
  it("stamps statusEnteredAt on a real transition", () => {
    const s: TestState = { status: "starting" };
    setStatus(s, "idle");
    expect(s.status).toBe("idle");
    expect(typeof s.statusEnteredAt).toBe("string");
    const stamped = s.statusEnteredAt!;
    expect(new Date(stamped).toISOString()).toBe(stamped);
  });

  it("does not re-stamp when the same status is re-affirmed (stable generation)", () => {
    const fixed = "2026-01-01T00:00:00.000Z";
    const s: TestState = { status: "idle", statusEnteredAt: fixed };
    setStatus(s, "idle");
    expect(s.statusEnteredAt).toBe(fixed);
  });

  it("re-stamps and clears blockReason across distinct transitions", () => {
    const s: TestState = {
      status: "idle",
      statusEnteredAt: "2020-01-01T00:00:00.000Z",
    };
    setStatus(s, "blocked", "question");
    expect(s.status).toBe("blocked");
    expect(s.blockReason).toBe("question");
    expect(s.statusEnteredAt).not.toBe("2020-01-01T00:00:00.000Z"); // transition → new stamp
    setStatus(s, "idle");
    expect(s.blockReason).toBeUndefined();
  });
});
