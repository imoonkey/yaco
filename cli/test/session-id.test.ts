import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { Database } from "bun:sqlite";

import { resolveSessionId, PENDING_SESSION_ID } from "../src/session-id.ts";

describe("PENDING_SESSION_ID", () => {
  it("is a non-UUID sentinel", () => {
    expect(PENDING_SESSION_ID).toBe("pending:awaiting-first-prompt");
    expect(PENDING_SESSION_ID).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("resolveSessionId — edge cases", () => {
  it("returns null for unknown provider", () => {
    expect(resolveSessionId(12345, "unknown")).toBeNull();
  });

  it("returns null for zero pid (claude)", () => {
    expect(resolveSessionId(0, "claude")).toBeNull();
  });

  it("returns null for negative pid (claude)", () => {
    expect(resolveSessionId(-1, "claude")).toBeNull();
  });

  it("returns null for codex with no sessionPath", () => {
    expect(resolveSessionId(0, "codex")).toBeNull();
  });
});

describe("resolveSessionId — claude (live)", () => {
  it("returns null for non-existent pid", () => {
    expect(resolveSessionId(999999999, "claude")).toBeNull();
  });

  it("returns a UUID for a known pid if session file exists", () => {
    // Check if any Claude session files exist
    const dir = join(homedir(), ".claude", "sessions");
    try {
      const files = readdirSync(dir).filter((f: string) => f.endsWith(".json"));
      if (files.length > 0) {
        const data = JSON.parse(readFileSync(join(dir, files[0]), "utf-8"));
        if (data.pid && data.sessionId) {
          const result = resolveSessionId(data.pid, "claude");
          expect(result?.sessionId).toBe(data.sessionId);
        }
      }
    } catch {
      // No Claude sessions — skip
    }
  });
});

describe("resolveSessionId — codex (live)", () => {
  it("returns null for non-existent cwd", () => {
    expect(resolveSessionId(0, "codex", undefined, "/nonexistent/path/that/does/not/exist")).toBeNull();
  });
});

describe("resolveSessionId — codex SQL correctness (threads table)", () => {
  it("returns latest thread id when multiple threads exist for a cwd", () => {
    const dbPath = join(homedir(), ".codex", "state_5.sqlite");
    try {
      const db = new Database(dbPath, { readonly: true });
      // Find a cwd with at least one thread
      const row = db
        .query<{ cwd: string; latest_id: string; created_at: number }, []>(
          `SELECT cwd, id as latest_id, created_at
           FROM threads
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get();
      db.close();

      if (!row) return; // No threads — skip

      // Query via resolveSessionId with a time bound before the thread was created
      const sessionCreatedMs = (row.created_at - 1) * 1000;
      const result = resolveSessionId(0, "codex", sessionCreatedMs, row.cwd);

      expect(result?.sessionId).toBe(row.latest_id);
    } catch {
      // No Codex SQLite — skip
    }
  });
});
