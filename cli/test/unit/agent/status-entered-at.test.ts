/** T2: setStatus stamps the durable status-edge generation key (statusEnteredAt)
 *  on a real transition, and leaves it untouched when the same status is
 *  re-affirmed — so re-seeing the same edge never mints a new generation. */
import { describe, it, expect } from "bun:test";
import { setStatus } from "../../../src/lib/core/agent/model.ts";

describe("setStatus — statusEnteredAt", () => {
  it("stamps statusEnteredAt on a real transition", () => {
    const s: { status: string; statusEnteredAt?: string; blockReason?: string } = { status: "starting" };
    setStatus(s as never, "idle");
    expect(s.status).toBe("idle");
    expect(typeof s.statusEnteredAt).toBe("string");
    expect(new Date(s.statusEnteredAt!).toISOString()).toBe(s.statusEnteredAt);
  });

  it("does not re-stamp when the same status is re-affirmed (stable generation)", () => {
    const fixed = "2026-01-01T00:00:00.000Z";
    const s: { status: string; statusEnteredAt?: string } = { status: "idle", statusEnteredAt: fixed };
    setStatus(s as never, "idle");
    expect(s.statusEnteredAt).toBe(fixed);
  });

  it("re-stamps and clears blockReason across distinct transitions", () => {
    const s: { status: string; statusEnteredAt?: string; blockReason?: string } = {
      status: "idle",
      statusEnteredAt: "2020-01-01T00:00:00.000Z",
    };
    setStatus(s as never, "blocked", "question" as never);
    expect(s.status).toBe("blocked");
    expect(s.blockReason).toBe("question");
    expect(s.statusEnteredAt).not.toBe("2020-01-01T00:00:00.000Z"); // transition → new stamp
    setStatus(s as never, "idle");
    expect(s.blockReason).toBeUndefined();
  });
});
