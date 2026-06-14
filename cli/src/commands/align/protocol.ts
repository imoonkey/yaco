/** Alignment coordination — grammar + state machine (pure, no I/O).
 *
 *  `status.txt` is a single line of space-separated key=value pairs:
 *
 *      SEQ=<n> NEXT=<CODEX|CLAUDE|DONE> CODEX=<vote> CLAUDE=<vote>
 *
 *  The CLI is the sole writer of that line, so the parser is strict: any
 *  deviation is `malformed`, never a torn write to tolerate. The transition
 *  function is total given a valid turn — the caller (handoff) guarantees
 *  `role === status.next` and `status.next !== "DONE"` before calling, so an
 *  illegal transition is unrepresentable through the CLI.
 */

export type Role = "CODEX" | "CLAUDE";
export type Vote = "PENDING" | "APPROVE" | "CHANGES";
export type Next = Role | "DONE";

/** The inferred outcome of a turn — APPROVE (final/ unchanged) or CHANGES. */
export type VoteEvent = "APPROVE" | "CHANGES";

export interface Status {
  seq: number;
  next: Next;
  codex: Vote;
  claude: Vote;
}

export const ROLES: readonly Role[] = ["CODEX", "CLAUDE"];
export const OTHER: Record<Role, Role> = { CODEX: "CLAUDE", CLAUDE: "CODEX" };

const VOTES: readonly Vote[] = ["PENDING", "APPROVE", "CHANGES"];

export function isRole(value: string): value is Role {
  return value === "CODEX" || value === "CLAUDE";
}

/** Strict parse of the first status line into a typed Status, or null when it
 *  does not match the canonical grammar exactly. */
export function parseStatus(line: string): Status | null {
  const seq = matchInt(line, "SEQ");
  const next = matchToken(line, "NEXT");
  const codex = matchToken(line, "CODEX");
  const claude = matchToken(line, "CLAUDE");
  if (seq === null) return null;
  if (next !== "DONE" && !isRole(next ?? "")) return null;
  if (!isVote(codex) || !isVote(claude)) return null;
  return { seq, next: next as Next, codex, claude };
}

export function formatStatus(s: Status): string {
  return `SEQ=${s.seq} NEXT=${s.next} CODEX=${s.codex} CLAUDE=${s.claude}`;
}

/** The whole state machine. Records `role`'s inferred `vote` and advances:
 *  - CHANGES resets the other role to PENDING (forces a re-review);
 *  - both APPROVE ends the alignment (`next = DONE`);
 *  - otherwise the turn passes to the other role.
 *  `seq` advances to the opened turn number (`status.seq + 1`).
 *
 *  Precondition (enforced by the caller): `role === status.next` and
 *  `status.next !== "DONE"`. */
export function transition(status: Status, role: Role, vote: VoteEvent): Status {
  const votes: Record<Role, Vote> = { CODEX: status.codex, CLAUDE: status.claude };
  votes[role] = vote;
  if (vote === "CHANGES") votes[OTHER[role]] = "PENDING";

  const bothApprove = votes.CODEX === "APPROVE" && votes.CLAUDE === "APPROVE";
  return {
    seq: status.seq + 1,
    next: bothApprove ? "DONE" : OTHER[role],
    codex: votes.CODEX,
    claude: votes.CLAUDE,
  };
}

function isVote(value: string | null): value is Vote {
  return value !== null && (VOTES as readonly string[]).includes(value);
}

/** Match `KEY=<UPPER>` (uppercase token). Anchored on word boundary so a
 *  trailing `XNEXT=` cannot shadow `NEXT=`. */
function matchToken(line: string, key: string): string | null {
  const m = line.match(new RegExp(`(?:^|\\s)${key}=([A-Z]+)(?:\\s|$)`));
  return m ? m[1]! : null;
}

function matchInt(line: string, key: string): number | null {
  const m = line.match(new RegExp(`(?:^|\\s)${key}=([0-9]+)(?:\\s|$)`));
  return m ? Number(m[1]) : null;
}
