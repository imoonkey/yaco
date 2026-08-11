/** The one message-inventory read, shared by `yaco agent messages` and
 *  `app/server`'s channel commands.
 *
 *  One read of the session's provider log. Every message in it gets a stable
 *  absolute index, and the optional filter narrows which rows come back without
 *  ever renumbering them. Both mechanisms — the CLI command and the in-process
 *  app call — run this function, so the filtering and index semantics cannot
 *  drift apart.
 *
 *  The session is an explicit input. Resolving a handle to a `SessionState` is
 *  the caller's job (the CLI reads its state file; the app reads its own), which
 *  is what keeps this module free of the ambient per-request state and of the
 *  mutation modules an exported closure may not reach. Failures come back as
 *  `Result`, never as a throw: at the moment the subprocess boundary disappears
 *  the app must not silently acquire unhandled exceptions.
 *
 *  -> See: `doc/main/cli/exports.md` (the six eligibility rules this obeys). */

import { readFile } from "node:fs/promises";
import { CliError, ErrCode, toErr } from "../../errors.ts";
import { ok, type Result } from "../../result.ts";
import { claudeMessages, codexMessages } from "./messages.ts";
import { NEWLINE } from "./output.ts";
import type { SessionState } from "../model.ts";
import type { MessageFull, MessageRole, ProviderMessages } from "./types.ts";

export type { MessageFull, MessageRole } from "./types.ts";

/** The handle alphabet `yaco agent messages` enforces, published because an
 *  in-process caller resolves the handle itself and must reject exactly what
 *  the command rejects — down to the USAGE error body. */
export { validateName } from "../model.ts";

/** Inclusive absolute-index window. Null bounds are open; negatives count from
 *  the end. */
export interface MessagesRange {
  from: number | null;
  to: number | null;
}

/** Which rows to return. Absent members do not narrow, and no member changes an
 *  index: `range` addresses absolute indices, and its open and end-relative
 *  bounds count against every message in the log, not against what `role` and
 *  `type` kept. */
export interface MessageFilter {
  role?: MessageRole;
  /** Matches a row whose `types` contains this token exactly or as the head of
   *  a `head:detail` token, so `tool_use` matches `tool_use:Bash`. */
  type?: string;
  range?: MessagesRange;
}

/** Providers that can be read back as a message inventory — the single answer
 *  to "which reader does this provider use", for the CLI and the app alike.
 *
 *  Deliberately not `getProvider(id).messages`: the TUI registry reaches tmux
 *  and the session lifecycle, which no exported closure may. A provider added
 *  to that registry with a `messages` capability and not listed here would read
 *  as unregistered, so `test/agent-messages.test.ts` fails closed on exactly
 *  that divergence.
 *
 *  A Map keeps membership to listed ids only — a plain object would resolve
 *  inherited keys like "toString" or "constructor". */
const MESSAGE_PROVIDERS = new Map<string, () => ProviderMessages>([
  ["claude", claudeMessages],
  ["codex", codexMessages],
]);

export function messagesForProvider(provider: string): ProviderMessages | null {
  return MESSAGE_PROVIDERS.get(provider)?.() ?? null;
}

/** Bytes parsed between event-loop yields.
 *
 *  A provider log is input-sized — the local corpus of 3,449 of them runs from
 *  240 KB at the median to 38 MB at the top — and `parseLine` is a JSON parse
 *  per line. Parsing one in a single pass blocks the thread for as long as it
 *  takes, which inside `app/server` is the whole event loop.
 *
 *  The budget is bytes rather than lines because a JSONL record is not a bounded
 *  unit: that 38 MB log is only 854 physical lines, sixteen of them over a
 *  megabyte, so any line count large enough to be worth batching is also large
 *  enough to swallow the whole file.
 *
 *  What the budget cannot bound: one record's own decode and parse, and the
 *  allocation of the file buffer. On that 38 MB log those leave a 14–23 ms
 *  worst-case gap, against ~6 ms for the `1+n` subprocess route and 1088 ms of
 *  wall time it no longer spends. Revisit if provider records grow materially;
 *  subdividing a single record belongs in the provider parser, not here.
 *  -> See: `test/bench/message-read-bench.mjs`. */
const PARSE_BATCH_BYTES = 256 * 1024;

function matchesType(types: string[], t: string): boolean {
  return types.some((x) => x === t || x.startsWith(`${t}:`));
}

/** An absolute-index window resolved against `n` rows: end-relative negatives
 *  counted from the end, then clamped to [0,n). An empty window keeps nothing. */
function resolveRange(range: MessagesRange, n: number): { from: number; to: number } {
  const from = range.from === null ? 0 : range.from < 0 ? range.from + n : range.from;
  const to = range.to === null ? n - 1 : range.to < 0 ? range.to + n : range.to;
  return { from: Math.max(0, from), to: Math.min(n - 1, to) };
}

/** Read the session's message log once and return the rows that pass `filter`,
 *  each carrying its absolute index in the full kept-row sequence.
 *
 *  Errors: `INVALID` when the provider has no message reader, `NOT_FOUND` when
 *  the session has no log yet or it has since disappeared, `IO` when the log
 *  cannot be read. */
export async function readMessageRows(
  session: SessionState,
  filter: MessageFilter = {},
): Promise<Result<MessageFull[]>> {
  try {
    const messages = messagesForProvider(session.provider);
    if (!messages) {
      throw new CliError(
        ErrCode.INVALID,
        `provider "${session.provider}" has no registered adapter`,
      );
    }

    const path = await messages.resolveLogPath(session);
    if (!path) throw new CliError(ErrCode.NOT_FOUND, `no message log yet for "${session.handle}"`);

    // Read as bytes, not as one decoded string: decoding 38 MB of UTF-8 in one
    // call is a single uninterruptible block on this thread, and it is the
    // largest one this function has. Per-line decoding spreads it across the
    // yielding scan below. A newline byte never occurs inside a UTF-8 multibyte
    // sequence, so framing on bytes and decoding each frame is exact.
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw new CliError(ErrCode.NOT_FOUND, `message log for "${session.handle}" not found`);
      }
      throw new CliError(ErrCode.IO, `failed to read message log for "${session.handle}"`);
    }

    // Scan line by line rather than splitting the whole log at once, and keep
    // only rows that survive `role`/`type` — both are index-independent, so
    // applying them here is the same answer as filtering a materialized list,
    // and a `/last` over a 38 MB log then retains three rows instead of tens of
    // thousands. `total` still counts every parsed row, which is what `range`
    // and every index are measured against.
    let total = 0;
    const kept: MessageFull[] = [];
    let start = 0;
    let sinceYield = 0;
    while (start <= content.length) {
      const nl = content.indexOf(NEWLINE, start);
      const msg = messages.parseLine(content.toString("utf-8", start, nl === -1 ? content.length : nl));
      if (msg) {
        const index = total++;
        if (
          (!filter.role || msg.role === filter.role) &&
          (!filter.type || matchesType(msg.types, filter.type))
        ) {
          kept.push({
            index,
            role: msg.role,
            types: msg.types,
            chars: msg.text.length,
            ts: msg.ts,
            text: msg.text,
          });
        }
      }
      if (nl === -1) break;
      sinceYield += nl + 1 - start;
      start = nl + 1;
      if (sinceYield >= PARSE_BATCH_BYTES) {
        sinceYield = 0;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    if (!filter.range) return ok(kept);
    const window = resolveRange(filter.range, total);
    return ok(kept.filter((r) => r.index >= window.from && r.index <= window.to));
  } catch (e) {
    return toErr(e);
  }
}
