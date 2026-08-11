/** Subprocess tests for `yaco align` — the interface is the test surface.
 *
 *  Drives the real binary through a full canonical alignment (init → wait →
 *  handoff → status, to DONE) plus every rejection path. The test process plays
 *  the agent: it writes final/* and the turn files between CLI calls.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../../helpers/cli-process.ts";
const ROOTS: string[] = [];

function bundle(): string {
  const dir = mkdtempSync(join(tmpdir(), "yaco-align-"));
  ROOTS.push(dir);
  return dir;
}
afterAll(() => ROOTS.forEach((d) => rmSync(d, { recursive: true, force: true })));

function yaco(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = runCli(args, { env: { ...process.env, NO_COLOR: "1" } });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? -1,
  };
}

function data(r: { stdout: string }): any {
  return JSON.parse(r.stdout).data;
}

/** Write a file under the bundle's final/ — the agent's design output. */
function writeFinal(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, "final", name), content, "utf-8");
}

describe("yaco align — canonical run to DONE", () => {
  it("init → wait → handoff (CHANGES/APPROVE inferred) → DONE", () => {
    const dir = bundle();

    const init = yaco(["align", "init", dir, "--first", "CODEX", "--json"]);
    expect(init.status).toBe(0);
    expect(data(init)).toEqual({ seq: 0, next: "CODEX", dir });

    // ── CODEX turn 1: writes the first draft → CHANGES ──
    let w = yaco(["align", "wait", dir, "CODEX", "--json"]);
    expect(data(w).status).toBe("YOUR_TURN");
    expect(data(w).seq).toBe(1);
    expect(data(w).turnFile).toMatch(/discussion\/0001_CODEX\.md$/);
    writeFinal(dir, "design.md", "first draft");
    writeFileSync(data(w).turnFile, "codex first draft\n");
    let h = yaco(["align", "handoff", dir, "CODEX", "--json"]);
    expect(data(h)).toMatchObject({ status: "HANDED_OFF", vote: "CHANGES", changedFinal: true, next: "CLAUDE" });

    // ── CLAUDE turn 2: reviews, no final edit → APPROVE, hands back to CODEX ──
    w = yaco(["align", "wait", dir, "CLAUDE", "--json"]);
    expect(data(w).seq).toBe(2);
    writeFileSync(data(w).turnFile, "claude approves the draft\n");
    h = yaco(["align", "handoff", dir, "CLAUDE", "--json"]);
    expect(data(h)).toMatchObject({ vote: "APPROVE", changedFinal: false, next: "CODEX" });

    // ── status (orchestrator view): not done yet ──
    const s = yaco(["align", "status", dir, "--json"]);
    expect(data(s)).toEqual({ seq: 2, next: "CODEX", codex: "CHANGES", claude: "APPROVE", done: false });

    // ── CODEX turn 3: approves, both APPROVE → DONE ──
    w = yaco(["align", "wait", dir, "CODEX", "--json"]);
    expect(data(w).seq).toBe(3);
    writeFileSync(data(w).turnFile, "codex approves\n");
    h = yaco(["align", "handoff", dir, "CODEX", "--json"]);
    expect(data(h)).toMatchObject({ status: "DONE", vote: "APPROVE", next: "DONE" });

    // ── wait now reports DONE; status.done is true ──
    w = yaco(["align", "wait", dir, "CLAUDE", "--json"]);
    expect(data(w)).toEqual({ status: "DONE", seq: 3 });
    expect(data(yaco(["align", "status", dir, "--json"])).done).toBe(true);
  });
});

describe("yaco align — text mode", () => {
  it("status prints the canonical line", () => {
    const dir = bundle();
    yaco(["align", "init", dir, "--first", "CLAUDE"]);
    const s = yaco(["align", "status", dir]);
    expect(s.status).toBe(0);
    expect(s.stdout).toBe("SEQ=0 NEXT=CLAUDE CODEX=PENDING CLAUDE=PENDING\n");
  });
});

describe("yaco align — rejections", () => {
  it("init twice → CONFLICT (exit 1)", () => {
    const dir = bundle();
    yaco(["align", "init", dir, "--first", "CODEX", "--json"]);
    const again = yaco(["align", "init", dir, "--first", "CODEX", "--json"]);
    expect(again.status).toBe(1);
    expect(JSON.parse(again.stderr).error.message).toMatch(/already initialized/);
  });

  it("status on an uninitialized dir → NOT_FOUND (exit 1)", () => {
    const r = yaco(["align", "status", bundle(), "--json"]);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stderr).error.code).toBe("NOT_FOUND");
  });

  it("handoff without a prior wait → CONFLICT (active turn required)", () => {
    const dir = bundle();
    yaco(["align", "init", dir, "--first", "CODEX", "--json"]);
    const h = yaco(["align", "handoff", dir, "CODEX", "--json"]);
    expect(h.status).toBe(1);
    expect(JSON.parse(h.stderr).error.message).toMatch(/no active turn/);
  });

  it("handoff out of turn → CONFLICT (not your turn)", () => {
    const dir = bundle();
    yaco(["align", "init", dir, "--first", "CODEX", "--json"]);
    const h = yaco(["align", "handoff", dir, "CLAUDE", "--json"]);
    expect(h.status).toBe(1);
    expect(JSON.parse(h.stderr).error.message).toMatch(/not your turn/);
  });

  it("handoff with an empty turn file → INVALID (exit 1)", () => {
    const dir = bundle();
    yaco(["align", "init", dir, "--first", "CODEX", "--json"]);
    const w = yaco(["align", "wait", dir, "CODEX", "--json"]);
    writeFinal(dir, "design.md", "draft");
    // leave the turn file unwritten (empty)
    writeFileSync(data(w).turnFile, "   \n");
    const h = yaco(["align", "handoff", dir, "CODEX", "--json"]);
    expect(h.status).toBe(1);
    expect(JSON.parse(h.stderr).error.message).toMatch(/missing or empty/);
  });

  it("handoff after DONE → CONFLICT (absorbing)", () => {
    const dir = bundle();
    // The CLI is the sole writer, so reach DONE by driving a minimal mutual-approve
    // run rather than seeding a DONE line.
    yaco(["align", "init", dir, "--first", "CODEX", "--json"]);
    let w = yaco(["align", "wait", dir, "CODEX", "--json"]);
    writeFileSync(data(w).turnFile, "x\n"); // no final edit → APPROVE
    yaco(["align", "handoff", dir, "CODEX", "--json"]); // CODEX APPROVE, next CLAUDE
    w = yaco(["align", "wait", dir, "CLAUDE", "--json"]);
    writeFileSync(data(w).turnFile, "y\n");
    yaco(["align", "handoff", dir, "CLAUDE", "--json"]); // both APPROVE → DONE
    const after = yaco(["align", "handoff", dir, "CODEX", "--json"]);
    expect(after.status).toBe(1);
    expect(JSON.parse(after.stderr).error.message).toMatch(/already DONE/);
  });

  it("raw status.txt path → USAGE (exit 2)", () => {
    const dir = bundle();
    yaco(["align", "init", dir, "--first", "CODEX", "--json"]);
    const r = yaco(["align", "status", join(dir, "discussion", "status.txt"), "--json"]);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stderr).error.code).toBe("USAGE");
  });

  it("init without --first → USAGE (exit 2)", () => {
    const r = yaco(["align", "init", bundle(), "--json"]);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stderr).error.code).toBe("USAGE");
  });
});

describe("yaco align wait — timeout / error exit codes (poll-era contract)", () => {
  it("TIMEOUT → exit 1, align.timeout on stderr", () => {
    const dir = bundle();
    yaco(["align", "init", dir, "--first", "CODEX", "--json"]); // NEXT=CODEX, wait as CLAUDE
    const r = yaco(["align", "wait", dir, "CLAUDE", "--timeout", "2", "--json"]);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stderr).error.code).toBe("align.timeout");
  });

  it("ERROR → exit 2 on an uninitialized bundle (text mode word on stdout)", () => {
    const r = yaco(["align", "wait", bundle(), "CODEX", "--timeout", "5"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("ERROR\n");
  });
});

describe("yaco align — usage", () => {
  it("--help lists the four verbs", () => {
    const r = yaco(["align", "--help"]);
    expect(r.status).toBe(0);
    for (const v of ["init", "wait", "handoff", "status"]) expect(r.stdout).toContain(v);
  });

  it("unknown subcommand → USAGE (exit 2)", () => {
    const r = yaco(["align", "nope"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown subcommand");
  });
});
