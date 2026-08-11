/** The shared output follower: tail a provider log and emit NDJSON frames.
 *
 *  Split from output.ts, which it reads through (`readRange`, the provider
 *  classifiers). The split is not cosmetic: this module polls, and a polling
 *  loop is banned from every closure `package.json#exports` publishes
 *  (`doc/main/cli/exports.md`, rule 3). Keeping the tailer here is what lets
 *  the provider capability in output.ts — log-path resolution and line
 *  classification — be reached from an exported read.
 *
 *  The follower owns `stat`, byte-range reads, partial-line buffering, and
 *  offset advancement; providers only classify complete lines. Its one consumer
 *  is `yaco agent output-follow|wait`, which owns a process of its own. */

import { stat } from "node:fs/promises";
import { NEWLINE, readRange } from "./output.ts";
import type { AgentOutputEvent } from "./types.ts";

/** Why a follow stream stopped. `timeout` is intentionally NOT a value here:
 *  it is never a provider classification event, and the defensive lifetime cap
 *  surfaces as `max-lifetime`, not `timeout`. */
export type FollowEndReason = "final" | "max-lifetime" | "error";

/** One NDJSON frame written by the follower. `nextOffset` is the absolute byte
 *  offset just past the last fully-consumed line, safe to pass back as the next
 *  `--offset` to resume without reprocessing. */
export type FollowFrame =
  | { type: "event"; event: AgentOutputEvent; nextOffset: number }
  | { type: "end"; reason: FollowEndReason; nextOffset: number };

export interface FollowParams {
  /** Resolved provider log path (the opaque cursor token). */
  sourcePath: string;
  /** Byte offset to begin reading from. */
  startOffset: number;
  /** Provider line classifier — at most one event per complete line. */
  classify: (line: string) => AgentOutputEvent | null;
  /** Sink for each NDJSON frame. */
  emit: (frame: FollowFrame) => void;
  /** Poll interval while the log is quiet (default 250ms). */
  pollMs?: number;
  /** Defensive cap to reap orphan tailers (default 30m). */
  maxLifetimeMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Cooperative cancel — caller termination flips `aborted`. */
  signal?: { aborted: boolean };
  /** Flush a complete-but-unterminated trailing record on the terminal `end`.
   *  Off for the streaming `output-follow` surface (a partial line may still be
   *  growing). On for the completion-wait drain, where a session that died after
   *  writing its final record but before the closing newline must still surface
   *  that final rather than read as "ended without a final". */
  flushPendingOnEnd?: boolean;
}

export const DEFAULT_POLL_MS = 250;
export const DEFAULT_MAX_LIFETIME_MS = 30 * 60_000;

/** Tail a provider log from `startOffset`, classifying each complete line into
 *  `event` frames and ending with one `end` frame. Buffers partial lines across
 *  reads in byte space (a UTF-8 multibyte char never contains a newline byte),
 *  so `nextOffset` is always byte-accurate. Terminates on the first `final`
 *  event, on the defensive lifetime cap, on caller abort, or on a read error. */
export async function followOutput(p: FollowParams): Promise<void> {
  const pollMs = p.pollMs ?? DEFAULT_POLL_MS;
  const maxLifetimeMs = p.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
  const now = p.now ?? (() => Date.now());
  const sleep = p.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();

  // Defensive: a non-finite or negative startOffset would corrupt nextOffset
  // accounting. Callers validate `--offset` before this point, but clamp here
  // so the follower can never emit nextOffset:null.
  let readPos =
    Number.isFinite(p.startOffset) && p.startOffset > 0 ? Math.floor(p.startOffset) : 0;
  let lineOffset = readPos; // byte offset just past the last consumed line
  let pending: Buffer = Buffer.alloc(0); // unconsumed bytes of the current partial line

  const end = (reason: FollowEndReason) => {
    // A complete record written without its closing newline (e.g. a final the
    // session flushed just before dying) is still sitting in `pending`, never
    // classified by the newline loop. On an opt-in terminal end, classify it
    // once. An incomplete record parses to null, so this is safe even mid-write.
    if (p.flushPendingOnEnd && pending.length > 0) {
      const line = pending.toString("utf-8").replace(/\r$/, "").trim();
      if (line) {
        const event = p.classify(line);
        if (event) p.emit({ type: "event", event, nextOffset: lineOffset + pending.length });
      }
    }
    p.emit({ type: "end", reason, nextOffset: lineOffset });
  };

  while (true) {
    if (p.signal?.aborted) return end("max-lifetime");
    if (now() - start >= maxLifetimeMs) return end("max-lifetime");

    let size: number;
    try {
      size = (await stat(p.sourcePath)).size;
    } catch {
      return end("error");
    }

    if (size < readPos) {
      // File truncated/rotated under us — restart from the new head.
      readPos = 0;
      lineOffset = 0;
      pending = Buffer.alloc(0);
    }
    if (size <= readPos) {
      await sleep(pollMs);
      continue;
    }

    let chunk: Buffer;
    try {
      chunk = await readRange(p.sourcePath, readPos, size);
    } catch {
      // open/read can fail after a successful stat (rotation, permissions).
      // Surface it as an end frame, never as a bubbled exception that would
      // corrupt the NDJSON stream once frames have started.
      return end("error");
    }
    readPos += chunk.length;
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;

    let nl: number;
    while ((nl = pending.indexOf(NEWLINE)) >= 0) {
      const lineBuf = pending.subarray(0, nl);
      lineOffset += nl + 1; // line bytes + the newline
      pending = pending.subarray(nl + 1);
      const line = lineBuf.toString("utf-8").replace(/\r$/, "").trim();
      if (!line) continue;
      // At most one event per complete line keeps nextOffset unambiguous.
      const event = p.classify(line);
      if (!event) continue;
      p.emit({ type: "event", event, nextOffset: lineOffset });
      if (event.kind === "final") return end("final");
    }
  }
}
