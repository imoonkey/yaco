/** The one session-summary read, shared by `yaco agent summaries` and
 *  `app/server`'s session list.
 *
 *  A summary is the first meaningful thing a session was asked to do. Both
 *  providers answer it from the *head* of a log that can be tens of megabytes,
 *  so this reader scans in bounded chunks and stops at the first line that
 *  qualifies. That is not an approximation of the whole-file scan it replaces:
 *  `firstMeaningfulMessage` judges each text independently of the ones around
 *  it, so reading in order and stopping early returns the same label the whole
 *  file would — it just stops paying for the rest of it.
 *
 *  The sessions are explicit inputs. Resolving which sessions live under a
 *  project is the caller's job (the CLI enumerates its state files; the app
 *  already holds its own list and passes exactly the ones it is missing), which
 *  is what keeps this module free of ambient per-request state and of the
 *  mutation modules an exported closure may not reach. Failures come back as
 *  `Result`, never as a throw.
 *
 *  -> See: `doc/main/cli/exports.md` (the six eligibility rules this obeys). */

import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { toErr } from "../../errors.ts";
import { ok, type Result } from "../../result.ts";
import { PENDING_SESSION_ID } from "../model.ts";
import { NEWLINE, resolveClaudeLogPath, resolveCodexLogPath } from "./output.ts";
import { extractUserText, firstMeaningfulMessage } from "./prompt-label.ts";
import { codexDbPath } from "./provider-home.ts";

/** Everything a summary is derived from, and nothing else. A `SessionState`
 *  satisfies it, so the CLI passes its state files through unchanged; the app
 *  maps its own session row. Spelling the input this narrowly is what makes two
 *  concurrent calls on different projects structurally unable to cross. */
export interface SummaryTarget {
  handle: string;
  provider: string;
  sessionId: string;
  sessionPath: string;
}

/** A per-live-session display label, keyed back to the session by `handle`. */
export interface SessionSummary {
  handle: string;
  sessionId: string;
  provider: string;
  label: string;
}

/** Bytes read per scan step.
 *
 *  A provider log is input-sized — 38 MB at the top of the local Claude corpus,
 *  35 MB for Codex rollouts — and the previous reader decoded and parsed all of
 *  it to find a label that is almost always in the first record: 241 ms of
 *  uninterrupted work on that 38 MB log, against 0.58 ms for its first chunk.
 *  Between chunks the loop yields, so even a label buried deep in a log is paid
 *  for in bounded instalments. -> See: `test/bench/summary-stall.ts`. */
const SCAN_CHUNK_BYTES = 256 * 1024;

/** How many sessions are summarized at once. Same width as the task store's
 *  chunked reader, and for the same reason: wide enough that the reads overlap,
 *  narrow enough that one chunk's synchronous tail stays short. */
const READ_CONCURRENCY = 8;

/** The texts one log line contributes, in the order they were written. */
type TextsOfLine = (line: string) => string[];

/** Resolve one session's label, or null when the provider has nothing to say
 *  yet. Provider readers own their own I/O failures: a missing or unreadable
 *  log is "no label", never an error — the session simply has none. */
type ProviderSummary = (target: SummaryTarget) => Promise<string | null>;

// -- Claude --

function claudeTexts(line: string): string[] {
  try {
    const entry = JSON.parse(line);
    if (entry.type !== "user" || !entry.message?.content) return [];
    return [extractUserText(entry.message.content)];
  } catch {
    return [];
  }
}

async function claudeLabel(target: SummaryTarget): Promise<string | null> {
  if (!target.sessionPath) return null;
  const path = resolveClaudeLogPath(target);
  return path ? firstLabelInLog(path, claudeTexts, target.handle) : null;
}

// -- Codex --

function codexTexts(line: string): string[] {
  try {
    const entry = JSON.parse(line);
    if (entry.type !== "response_item" || entry.payload?.role !== "user") return [];
    const texts: string[] = [];
    for (const block of entry.payload.content ?? []) {
      if (
        block.type === "input_text" && block.text &&
        !block.text.startsWith("#") && !block.text.startsWith("<")
      ) {
        texts.push(block.text);
      }
    }
    return texts;
  } catch {
    return [];
  }
}

/** `title`/`first_user_message` for one thread.
 *
 *  This is rule 5's one judged synchronous admission: `node:sqlite` has no
 *  asynchronous interface, and this query is admitted because it is a point
 *  lookup on the `threads` primary key — `SEARCH threads USING INDEX
 *  sqlite_autoindex_threads_1 (id=?)` — which measures 1.45 ms at the p50 and
 *  1.83 ms at the maximum on an 11.6 MB, 2 296-thread database, open and close
 *  included. It is not droppable: on that same database `first_user_message` is
 *  empty for most recent threads and `title` is the last-resort label, so a
 *  reader without it answers differently. -> See: `test/bench/summary-stall.ts`. */
function codexThreadRow(sessionId: string): { title: string | null; first: string | null } | null {
  if (!existsSync(codexDbPath())) return null;
  try {
    const db = new DatabaseSync(codexDbPath(), { readOnly: true });
    try {
      const row = db
        .prepare("SELECT title, first_user_message FROM threads WHERE id = ?")
        .get(sessionId) as { title: string | null; first_user_message: string | null } | undefined;
      return row ? { title: row.title ?? null, first: row.first_user_message ?? null } : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Codex auto-renames the thread `title` to the YACO handle on start, so the
 *  real signal is `first_user_message`; the rollout log is the fallback, and
 *  `title` only when it is not a handle echo. */
async function codexLabel(target: SummaryTarget): Promise<string | null> {
  const row = codexThreadRow(target.sessionId);
  const first = firstMeaningfulMessage([row?.first ?? ""], target.handle);
  if (first) return first;

  const path = await resolveCodexLogPath(target);
  const rollout = path ? await firstLabelInLog(path, codexTexts, target.handle) : null;
  if (rollout) return rollout;

  return firstMeaningfulMessage([row?.title ?? ""], target.handle);
}

// -- The bounded scan --

/** Scan a JSONL log from the head and return the first meaningful label in it.
 *
 *  Framing is on newline bytes and only complete lines are decoded: a newline
 *  byte never occurs inside a UTF-8 multibyte sequence, so this reads exactly
 *  the strings a whole-file decode would produce. A line spanning chunks is
 *  accumulated rather than re-concatenated on every step, so a pathologically
 *  long record costs its own length, not its length squared. */
async function firstLabelInLog(
  path: string,
  textsOf: TextsOfLine,
  handle: string,
): Promise<string | null> {
  let file;
  try {
    file = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await file.stat();
    const buffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
    const partial: Buffer[] = [];
    let offset = 0;

    while (offset < size) {
      const { bytesRead } = await file.read(
        buffer, 0, Math.min(SCAN_CHUNK_BYTES, size - offset), offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;

      const chunk = buffer.subarray(0, bytesRead);
      let start = 0;
      for (let nl = chunk.indexOf(NEWLINE); nl !== -1; nl = chunk.indexOf(NEWLINE, start)) {
        const line = partial.length === 0
          ? chunk.toString("utf-8", start, nl)
          : joinPartial(partial, chunk.subarray(start, nl));
        start = nl + 1;
        const label = firstMeaningfulMessage(textsOf(line), handle);
        if (label) return label;
      }
      if (start < bytesRead) partial.push(Buffer.from(chunk.subarray(start)));
      if (offset < size) await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // A trailing line with no newline after it still counts, exactly as
    // splitting the whole file on "\n" would have counted it.
    if (partial.length === 0) return null;
    return firstMeaningfulMessage(textsOf(joinPartial(partial, EMPTY)), handle);
  } catch {
    return null;
  } finally {
    await file.close();
  }
}

const EMPTY = Buffer.alloc(0);

/** Concatenate the buffered head of a line with its tail, and empty the buffer. */
function joinPartial(partial: Buffer[], tail: Buffer): string {
  const line = Buffer.concat([...partial, tail]).toString("utf-8");
  partial.length = 0;
  return line;
}

// -- The composed read --

/** Providers whose sessions can be summarized — the single answer to "which
 *  summarizer does this provider use", for the CLI and the app alike.
 *
 *  Deliberately not `getProvider(id).history`: the TUI registry reaches tmux and
 *  the session lifecycle, which no exported closure may. `test/summary.test.ts`
 *  fails closed if a registered provider has no entry here.
 *
 *  A Map keeps membership to listed ids only — a plain object would resolve
 *  inherited keys like "toString" or "constructor". */
const SUMMARY_PROVIDERS = new Map<string, ProviderSummary>([
  ["claude", claudeLabel],
  ["codex", codexLabel],
]);

export function summarizerForProvider(provider: string): ProviderSummary | null {
  return SUMMARY_PROVIDERS.get(provider) ?? null;
}

/** Resolve a display label for each of `targets`, in the order given.
 *
 *  A target is dropped rather than reported when it cannot have a label yet:
 *  its session id is still pending, its provider has no summarizer, or the
 *  provider found nothing to say. That is the list contract this read has
 *  always had — one record per session that *has* a label — and it is why an
 *  unregistered provider is a dropped row here where `readMessageRows`, which
 *  answers about one named session, returns `INVALID`. */
export async function readSessionSummaries(
  targets: readonly SummaryTarget[],
): Promise<Result<SessionSummary[]>> {
  try {
    const summaries: SessionSummary[] = [];
    const readable = targets.filter(
      (t) => t.sessionId && t.sessionId !== PENDING_SESSION_ID && summarizerForProvider(t.provider),
    );

    for (let i = 0; i < readable.length; i += READ_CONCURRENCY) {
      const chunk = readable.slice(i, i + READ_CONCURRENCY);
      const labels = await Promise.all(
        chunk.map((target) => summarizerForProvider(target.provider)!(target)),
      );
      for (const [n, label] of labels.entries()) {
        if (label === null) continue;
        const target = chunk[n]!;
        summaries.push({
          handle: target.handle,
          sessionId: target.sessionId,
          provider: target.provider,
          label,
        });
      }
    }

    return ok(summaries);
  } catch (e) {
    return toErr(e);
  }
}
