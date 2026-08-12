/** Channel message reads, in process.
 *
 *  `/last n` used to cost `1 + n` CLI subprocesses — one `yaco agent messages
 *  <h> --role assistant --type text --json` sweep for the indices, then one
 *  `--index <i>` per kept row, each child re-reading and re-parsing the same
 *  provider log. It is now one read through `yaco-cli/core/agent/messages`,
 *  which is the implementation `yaco agent messages` itself runs, so the
 *  filtering and index semantics are not a second copy.
 *
 *  The session is passed explicitly: the CLI never resolves a handle for us
 *  here, so this module reads the one state file the handle names. Everything
 *  else about the session — where the provider writes its log, how a line
 *  becomes a message — stays behind the CLI boundary.
 *
 *  Reverting the cutover is a one-import change: `yaco agent messages` is
 *  unchanged and still the supported surface. */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readMessageRows, validateName } from 'yaco-cli/core/agent/messages'
import { isErr } from 'yaco-cli/core/result'
import { CliError } from 'yaco-cli/core/errors'
import { AGENT_SESSIONS_DIR } from '../constants'
import { validateSessionName } from '../session-names'
import type { AgentSessionState } from '../agent'

/** The message the channel renders as `messages failed: <message>`.
 *
 *  It still names the command, because that string is the shipped reply body
 *  for every one of these failures — `runYacoAgentJson` built it from the CLI's
 *  `--json` error envelope, and the code and message it carried are exactly
 *  what the shared read now returns. Parity here is user-visible text, not an
 *  implementation detail. */
function messagesFailure(code: string, message: string): Error {
  return new Error(`yaco agent messages failed [${code}]: ${message}`)
}

/** One session's state file. Mirrors the CLI's own `readState`: a missing or
 *  unparseable file is "no such session", never a thrown error. */
async function readSessionState(handle: string): Promise<AgentSessionState | null> {
  try {
    const raw = await readFile(join(AGENT_SESSIONS_DIR, `${handle}.json`), 'utf-8')
    return JSON.parse(raw) as AgentSessionState
  } catch {
    return null
  }
}

/** Last `n` assistant **prose** messages (full text), oldest-first, read from
 *  the provider JSONL — never PTY capture. Filters to assistant `text` rows so
 *  they are what the agent actually said, not thinking or tool-call entries.
 *  Empty when there is no assistant prose yet. */
export async function lastAssistantMessages(
  handle: string,
  n: number,
): Promise<{ index: number; text: string }[]> {
  // Two guards, because the route this replaces had two and each one owns a
  // different reply body. `validateSessionName` is the app's own guard on the
  // path it is about to build; `validateName` is the stricter alphabet the CLI
  // applied next — it rejects a dot, which the app's does not.
  validateSessionName(handle)
  try {
    validateName(handle)
  } catch (e) {
    throw messagesFailure(e instanceof CliError ? e.code : 'INTERNAL', (e as Error).message)
  }

  const state = await readSessionState(handle)
  if (!state) throw messagesFailure('NOT_FOUND', `no live session named "${handle}"`)

  const rows = await readMessageRows(state, { role: 'assistant', type: 'text' })
  if (isErr(rows)) throw messagesFailure(rows.code, rows.message)

  return rows.value.slice(-Math.max(1, n)).map(r => ({ index: r.index, text: r.text }))
}
