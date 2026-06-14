/** Store tests — the fs side: fingerprinting, bundle resolution, open-turn
 *  snapshots, and the blocking wait loop driven by a stubbed clock.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearOpenTurn,
  hashFinal,
  initBundle,
  openTurn,
  readOpenTurn,
  resolveBundle,
  resolveWaitBundle,
  waitForTurn,
} from "../../../../src/commands/align/store.ts";

const ROOTS: string[] = [];
function bundle(): string {
  const dir = mkdtempSync(join(tmpdir(), "yaco-align-store-"));
  ROOTS.push(dir);
  return dir;
}
afterAll(() => ROOTS.forEach((d) => rmSync(d, { recursive: true, force: true })));

function writeFinal(dir: string, rel: string, content: string): void {
  const p = join(dir, "final", rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf-8");
}

describe("hashFinal", () => {
  it("is stable across mtime changes (content-only)", () => {
    const dir = bundle();
    writeFinal(dir, "design.md", "hello");
    const h1 = hashFinal(dir);
    // bump mtime far into the past — content unchanged
    utimesSync(join(dir, "final", "design.md"), new Date(0), new Date(0));
    expect(hashFinal(dir)).toBe(h1);
  });

  it("changes when any file content changes", () => {
    const dir = bundle();
    writeFinal(dir, "design.md", "hello");
    const h1 = hashFinal(dir);
    writeFinal(dir, "design.md", "hello world");
    expect(hashFinal(dir)).not.toBe(h1);
  });

  it("changes when a nested file is added", () => {
    const dir = bundle();
    writeFinal(dir, "a.md", "a");
    const h1 = hashFinal(dir);
    writeFinal(dir, "sub/b.md", "b");
    expect(hashFinal(dir)).not.toBe(h1);
  });

  it("hashes an absent final/ to a stable empty digest", () => {
    expect(hashFinal(bundle())).toBe(hashFinal(bundle()));
  });

  it("counts a symlink-to-file in final/ as content", () => {
    const dir = bundle();
    writeFinal(dir, "real.md", "payload");
    const before = hashFinal(dir);
    symlinkSync(join(dir, "final", "real.md"), join(dir, "final", "link.md"));
    expect(hashFinal(dir)).not.toBe(before);
  });
});

describe("resolveBundle", () => {
  it("rejects a raw status.txt path (USAGE)", () => {
    const dir = bundle();
    initBundle(dir, "CODEX");
    expect(() => resolveBundle(join(dir, "discussion", "status.txt"))).toThrow(/bundle directory/);
  });

  it("NOT_FOUND when the explicit dir has no status.txt", () => {
    expect(() => resolveBundle(bundle())).toThrow(/not an alignment bundle/);
  });

  it("returns the explicit dir when initialized", () => {
    const dir = bundle();
    initBundle(dir, "CODEX");
    expect(resolveBundle(dir)).toBe(dir);
  });
});

describe("resolveWaitBundle", () => {
  it("takes an explicit dir as-is without requiring status.txt", () => {
    const dir = bundle();
    expect(resolveWaitBundle(dir)).toBe(dir);
  });
});

describe("openTurn / readOpenTurn", () => {
  it("snapshots the pre-turn hash and is idempotent on re-open", () => {
    const dir = bundle();
    initBundle(dir, "CODEX");
    writeFinal(dir, "design.md", "draft");
    const first = openTurn(dir, "CODEX", 1);
    // The agent edits final/ mid-turn; re-running wait must NOT move the baseline.
    writeFinal(dir, "design.md", "draft edited");
    const second = openTurn(dir, "CODEX", 1);
    expect(second.baseHash).toBe(first.baseHash);
    expect(readOpenTurn(dir)).toEqual(first);
  });

  it("re-snapshots for a new turn number", () => {
    const dir = bundle();
    initBundle(dir, "CODEX");
    const t1 = openTurn(dir, "CODEX", 1);
    writeFinal(dir, "design.md", "content");
    const t3 = openTurn(dir, "CODEX", 3);
    expect(t3.turnSeq).toBe(3);
    expect(t3.baseHash).not.toBe(t1.baseHash);
  });

  it("clearOpenTurn removes the snapshot", () => {
    const dir = bundle();
    initBundle(dir, "CODEX");
    openTurn(dir, "CODEX", 1);
    expect(readOpenTurn(dir)).not.toBeNull();
    clearOpenTurn(dir);
    expect(readOpenTurn(dir)).toBeNull();
  });

  it("treats a structurally-incomplete snapshot (no baseHash) as no open turn", () => {
    const dir = bundle();
    initBundle(dir, "CODEX");
    mkdirSync(join(dir, "discussion", ".align"), { recursive: true });
    writeFileSync(join(dir, "discussion", ".align", "turn.json"), JSON.stringify({ turnSeq: 1, role: "CODEX" }));
    expect(readOpenTurn(dir)).toBeNull();
  });
});

describe("waitForTurn (stubbed clock)", () => {
  const driver = () => {
    let virtual = 0;
    return {
      now: () => virtual,
      sleeps: 0,
      mk(onSleep?: (n: number) => void) {
        return async (ms: number) => {
          this.sleeps++;
          virtual += ms;
          onSleep?.(this.sleeps);
        };
      },
    };
  };

  it("returns YOUR_TURN immediately when NEXT matches", async () => {
    const dir = bundle();
    initBundle(dir, "CLAUDE");
    const out = await waitForTurn({ bundle: dir, role: "CLAUDE", intervalMs: 1000, timeoutMs: 5000, silent: true });
    expect(out.status).toBe("YOUR_TURN");
    expect(out.parsed?.seq).toBe(0);
  });

  it("returns DONE regardless of role", async () => {
    const dir = bundle();
    initBundle(dir, "CODEX");
    writeFileSync(join(dir, "discussion", "status.txt"), "SEQ=4 NEXT=DONE CODEX=APPROVE CLAUDE=APPROVE\n");
    const out = await waitForTurn({ bundle: dir, role: "CLAUDE", intervalMs: 1000, timeoutMs: 5000, silent: true });
    expect(out.status).toBe("DONE");
  });

  it("ERROR when the bundle has no status (uninitialized)", async () => {
    const out = await waitForTurn({ bundle: bundle(), role: "CODEX", intervalMs: 1000, timeoutMs: 5000, silent: true });
    expect(out.status).toBe("ERROR");
  });

  it("TIMEOUT after the deadline when NEXT stays on the other role", async () => {
    const dir = bundle();
    initBundle(dir, "CODEX"); // NEXT=CODEX, we wait as CLAUDE
    const d = driver();
    const out = await waitForTurn({
      bundle: dir,
      role: "CLAUDE",
      intervalMs: 1000,
      timeoutMs: 3000,
      silent: true,
      sleep: d.mk(),
      now: d.now,
    });
    expect(out.status).toBe("TIMEOUT");
    expect(d.sleeps).toBe(3);
  });

  it("flips to YOUR_TURN when status changes between polls", async () => {
    const dir = bundle();
    initBundle(dir, "CODEX"); // NEXT=CODEX, we wait as CLAUDE
    const d = driver();
    const out = await waitForTurn({
      bundle: dir,
      role: "CLAUDE",
      intervalMs: 1000,
      timeoutMs: 10000,
      silent: true,
      sleep: d.mk((n) => {
        if (n === 2) {
          writeFileSync(join(dir, "discussion", "status.txt"), "SEQ=1 NEXT=CLAUDE CODEX=CHANGES CLAUDE=PENDING\n");
        }
      }),
      now: d.now,
    });
    expect(out.status).toBe("YOUR_TURN");
    expect(out.parsed?.seq).toBe(1);
  });
});
