/** CLI contract tests for the agent JSON surfaces added in this slice:
 *  `history`, `summaries`, and the `providers` catalog. These spawn the real
 *  source entry (`src/main.ts`) and assert the dispatcher's success-envelope
 *  shape — `{ ok: true, data }` on stdout, exit 0 — without needing tmux,
 *  provider homes, or live sessions (help + catalog touch no provider files). */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve, join } from "path";

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
    expect(data).toEqual({ ok: true, data: [] });
  });

  it("`agent summaries --path <unknown> --json` returns an empty list envelope", () => {
    const { status, data } = runJson(["agent", "summaries", "--path", "/no/such/project/xyz", "--json"], hermetic);
    expect(status).toBe(0);
    expect(data).toEqual({ ok: true, data: [] });
  });
});
