/** What a failing `yaco … --json` spawn surfaces to a route.
 *
 *  Every remaining subprocess call goes through `runYacoAgentJson`, which is
 *  written to translate the CLI's `{ok:false,error:{code,message}}` stderr line
 *  into `yaco <what> failed [CODE]: message`. That translation had never run:
 *  the structured `throw` sat inside the same `try` whose `catch` exists to
 *  absorb a stderr tail that is not JSON, so it caught the throw as well and
 *  every caller received the opaque `exit <code>: <stderr>` instead.
 *
 *  Nothing covered it, which is how it survived. These tests are the cover:
 *  one for the envelope, one for the tail that genuinely is not one. */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

const child = vi.hoisted(() => ({ stderr: '', code: 1 }))

vi.mock('node:child_process', () => ({ spawn: makeSpawn() }))
vi.mock('child_process', () => ({ spawn: makeSpawn() }))

function makeSpawn() {
  return () => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      kill: () => void
    }
    proc.stdout = Readable.from([])
    proc.stderr = Readable.from([child.stderr])
    proc.kill = () => {}
    // After the streams have drained, so the handler sees the whole tail.
    setImmediate(() => setImmediate(() => proc.emit('close', child.code)))
    return proc
  }
}

vi.mock('../session-names', () => ({ validateSessionName: () => {} }))
vi.mock('../ssh-auth', () => ({ buildChildProcessEnv: () => ({}) }))
vi.mock('../constants', () => ({
  YACO_AGENT_COMMAND_TIMEOUT_MS: 5_000,
  YACO_AGENT_START_TIMEOUT_MS: 15_000,
  YACO_AGENT_STATUS_TIMEOUT_MS: 10_000,
  AGENT_SESSIONS_DIR: '/tmp/yaco-failure-envelope-sessions',
  YACO_PATH: 'yaco',
}))

import { sendToSession } from '../agent'

describe('a failing `yaco … --json` spawn', () => {
  beforeEach(() => {
    child.code = 1
  })

  it('surfaces the CLI error code and message, not the opaque exit line', async () => {
    child.stderr = JSON.stringify({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'no live session named "ghost"' },
    })
    await expect(sendToSession('ghost', 'hi')).rejects.toThrow(
      'yaco agent send failed [NOT_FOUND]: no live session named "ghost"',
    )
  })

  it('defaults a code-less envelope to INTERNAL', async () => {
    child.stderr = JSON.stringify({ ok: false, error: { message: 'boom' } })
    await expect(sendToSession('h', 'hi')).rejects.toThrow('yaco agent send failed [INTERNAL]: boom')
  })

  it('keeps the raw rejection when the tail is not a failure envelope', async () => {
    child.stderr = 'Segmentation fault'
    await expect(sendToSession('h', 'hi')).rejects.toThrow(/exit 1: Segmentation fault/)
  })
})
