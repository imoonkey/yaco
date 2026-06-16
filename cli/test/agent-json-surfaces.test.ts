/** CLI contract tests for the agent JSON surfaces added in this slice:
 *  `history`, `summaries`, and the `providers` catalog. These spawn the real
 *  source entry (`src/main.ts`) and assert the dispatcher's success-envelope
 *  shape — `{ ok: true, data }` on stdout, exit 0 — without needing tmux,
 *  provider homes, or live sessions (help + catalog touch no provider files). */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve, join } from "path";
import { encodeClaudeCwd } from "../src/lib/core/project/encode.ts";

const BIN = resolve(import.meta.dir, "../src/main.ts");

function runJson(
  args: string[],
  extraEnv: Record<string, string> = {},
): { status: number | null; data: unknown; stderr: string } {
  const r = spawnSync("bun", ["run", BIN, ...args], {
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1", ...extraEnv },
  });
  let data: unknown;
  try {
    data = JSON.parse((r.stdout ?? "").trim());
  } catch {
    data = undefined;
  }
  return { status: r.status, data, stderr: r.stderr ?? "" };
}

describe("agent help envelopes", () => {
  for (const sub of ["history", "summaries", "providers"]) {
    it(`\`agent ${sub} --help --json\` returns a success envelope`, () => {
      const { status, data } = runJson(["agent", sub, "--help", "--json"]);
      expect(status).toBe(0);
      expect(data).toMatchObject({ ok: true, data: { help: expect.any(String) } });
    });
  }

  it("`agent wait --help --json` returns a success envelope", () => {
    const { status, data } = runJson(["agent", "wait", "--help", "--json"]);
    expect(status).toBe(0);
    expect(data).toMatchObject({ ok: true, data: { help: expect.any(String) } });
  });
});

describe("agent list/status surface split", () => {
  // Hermetic: empty HOME + empty sessions dir so the result depends only on the
  // command surface, not the dev machine's live sessions.
  function hermetic(): Record<string, string> {
    const sandbox = mkdtempSync(join(tmpdir(), "yaco-list-"));
    return { HOME: sandbox, YACO_AGENT_SESSIONS_DIR: join(sandbox, "sessions") };
  }

  it("`agent list --all --json` returns an ok envelope with an array payload", () => {
    const { status, data } = runJson(["agent", "list", "--all", "--json"], hermetic());
    expect(status).toBe(0);
    const envelope = data as { ok: boolean; data: unknown };
    expect(envelope.ok).toBe(true);
    expect(Array.isArray(envelope.data)).toBe(true);
  });

  it("`agent status` without a handle exits non-zero with a USAGE error", () => {
    const r = spawnSync("bun", ["run", BIN, "agent", "status", "--json"], {
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1", ...hermetic() },
    });
    expect(r.status).not.toBe(0);
    const err = JSON.parse((r.stderr ?? "").trim()) as { ok: boolean; error: { code: string } };
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe("USAGE");
  });

  it("`agent status <missing> --json` exits non-zero with NOT_FOUND (no ok:true envelope)", () => {
    // Isolate only the sessions dir (no state file for the handle) and keep the
    // real $HOME so tmux can authoritatively confirm the session is dead. The
    // `=`-prefixed exact handle below cannot collide with a live session.
    const sessionsDir = join(mkdtempSync(join(tmpdir(), "yaco-status-")), "sessions");
    const r = spawnSync("bun", ["run", BIN, "agent", "status", "yaco-test-absent-handle-xyz", "--json"], {
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1", YACO_AGENT_SESSIONS_DIR: sessionsDir },
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).toBe("");
    const err = JSON.parse((r.stderr ?? "").trim()) as { ok: boolean; error: { code: string } };
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe("NOT_FOUND");
  });

  it("`agent list --all --path <p> --json` exits non-zero with USAGE (mutually exclusive)", () => {
    const r = spawnSync("bun", ["run", BIN, "agent", "list", "--all", "--path", "/tmp", "--json"], {
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1", ...hermetic() },
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).toBe("");
    const err = JSON.parse((r.stderr ?? "").trim()) as { ok: boolean; error: { code: string } };
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe("USAGE");
  });
});

describe("agent providers catalog", () => {
  it("`agent providers --json` lists registered CLI providers", () => {
    const { status, data } = runJson(["agent", "providers", "--json"]);
    expect(status).toBe(0);
    const envelope = data as { ok: boolean; data: Array<{ id: string; label: string; executable: string }> };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.map((p) => p.id).sort()).toEqual(["claude", "codex"]);
    for (const entry of envelope.data) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.executable.length).toBeGreaterThan(0);
    }
  });
});

describe("agent history/summaries data envelopes", () => {
  // Hermetic: empty $HOME (no ~/.claude / ~/.codex) and empty sessions dir so
  // the result depends only on the surface, not the dev machine's real homes.
  let sandbox: string;
  let hermetic: Record<string, string>;

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), "yaco-surface-"));
    hermetic = { HOME: sandbox, YACO_AGENT_SESSIONS_DIR: join(sandbox, "sessions") };
  });
  afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

  it("`agent history --path <unknown> --json` returns an empty list envelope", () => {
    const { status, data } = runJson(["agent", "history", "--path", "/no/such/project/xyz", "--json"], hermetic);
    expect(status).toBe(0);
    expect(data).toEqual({
      ok: true,
      data: { rows: [], returned: 0, truncated: false, oldestUpdatedAt: null },
    });
  });

  it("`agent history --json` bare call returns the canonical window object", () => {
    const { status, data } = runJson(["agent", "history", "--json"], hermetic);
    expect(status).toBe(0);
    expect(data).toEqual({
      ok: true,
      data: { rows: [], returned: 0, truncated: false, oldestUpdatedAt: null },
    });
  });

  it("`agent summaries --path <unknown> --json` returns an empty list envelope", () => {
    const { status, data } = runJson(["agent", "summaries", "--path", "/no/such/project/xyz", "--json"], hermetic);
    expect(status).toBe(0);
    expect(data).toEqual({ ok: true, data: [] });
  });

  it("`agent history --json` flushes a large envelope completely", () => {
    const projectPath = join(sandbox, "large-project");
    const projectDir = join(sandbox, ".claude", "projects", encodeClaudeCwd(projectPath));
    mkdirSync(projectDir, { recursive: true });

    const largeText = "x".repeat(900);
    for (let i = 0; i < 220; i++) {
      const sessionId = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      writeFileSync(
        join(projectDir, `${sessionId}.jsonl`),
        JSON.stringify({
          type: "user",
          timestamp,
          message: { content: `prompt ${i} ${largeText}` },
        }) + "\n",
      );
    }

    const r = spawnSync("bun", ["run", BIN, "agent", "history", "--path", projectPath, "--json"], {
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1", ...hermetic },
    });

    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout.length).toBeGreaterThan(180_000);
    const envelope = JSON.parse(r.stdout) as {
      ok: boolean;
      data: { rows: unknown[]; returned: number; truncated: boolean; oldestUpdatedAt: string | null };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.rows).toHaveLength(200);
    expect(envelope.data.returned).toBe(200);
    expect(envelope.data.truncated).toBe(true);
    expect(envelope.data.oldestUpdatedAt).toBe(envelope.data.rows.at(-1) && (envelope.data.rows.at(-1) as { updatedAt: string }).updatedAt);
  });

  it("`agent history --limit 300 --json` can return beyond the default window", () => {
    const projectPath = join(sandbox, "limit-project");
    const projectDir = join(sandbox, ".claude", "projects", encodeClaudeCwd(projectPath));
    mkdirSync(projectDir, { recursive: true });

    for (let i = 0; i < 220; i++) {
      const sessionId = `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`;
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      writeFileSync(
        join(projectDir, `${sessionId}.jsonl`),
        JSON.stringify({ type: "user", timestamp, message: { content: `prompt ${i}` } }) + "\n",
      );
    }

    const { status, data } = runJson(["agent", "history", "--path", projectPath, "--limit", "300", "--json"], hermetic);
    expect(status).toBe(0);
    const envelope = data as { ok: boolean; data: { rows: unknown[]; returned: number; truncated: boolean } };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.rows).toHaveLength(220);
    expect(envelope.data.returned).toBe(220);
    expect(envelope.data.truncated).toBe(false);
  });

  it("`agent history --since` filters before the default limit", () => {
    const projectPath = join(sandbox, "since-project");
    const projectDir = join(sandbox, ".claude", "projects", encodeClaudeCwd(projectPath));
    mkdirSync(projectDir, { recursive: true });

    for (let i = 0; i < 250; i++) {
      const sessionId = `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`;
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
      writeFileSync(
        join(projectDir, `${sessionId}.jsonl`),
        JSON.stringify({ type: "user", timestamp, message: { content: `prompt ${i}` } }) + "\n",
      );
    }

    const cutoff = new Date(Date.UTC(2026, 0, 1, 0, 30)).toISOString();
    const { status, data } = runJson(["agent", "history", "--path", projectPath, "--since", cutoff, "--json"], hermetic);
    expect(status).toBe(0);
    const envelope = data as { ok: boolean; data: { rows: Array<{ sessionId: string }>; returned: number; truncated: boolean } };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.rows).toHaveLength(200);
    expect(envelope.data.returned).toBe(200);
    expect(envelope.data.truncated).toBe(true);
    expect(envelope.data.rows.at(-1)!.sessionId.endsWith("000000000050")).toBe(true);
  });

  it.each([
    [["agent", "history", "--bogus", "--json"], "unknown flag"],
    [["agent", "history", "extra", "--json"], "unexpected argument"],
    [["agent", "history", "--since", "30d", "--json"], "--since requires"],
    [["agent", "history", "--limit", "--json"], "--limit requires"],
    [["agent", "history", "--limit", "abc", "--json"], "--limit requires"],
    [["agent", "history", "--limit", "-1", "--json"], "--limit requires"],
    [["agent", "history", "--limit", "0", "--json"], "--limit requires"],
  ])("`%s` exits with USAGE", (args, snippet) => {
    const r = spawnSync("bun", ["run", BIN, ...args], {
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1", ...hermetic },
    });
    expect(r.status).toBe(2);
    expect(r.stdout.trim()).toBe("");
    const err = JSON.parse((r.stderr ?? "").trim()) as { ok: boolean; error: { code: string; message: string } };
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe("USAGE");
    expect(err.error.message).toContain(snippet);
  });
});
