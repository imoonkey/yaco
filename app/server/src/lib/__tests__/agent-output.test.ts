import { describe, it, expect, vi } from 'vitest'
import {
  startTurn,
  streamAgentReply,
  cancelAgentOutput,
  queueHandleStream,
  spawnFollow,
  type AgentEvent,
  type FollowFrame,
  type FollowStream,
  type FollowDeps,
  type PendingTurn,
} from '../channels/agent-output'
import type { AgentSession } from '../agent'

/** These tests exercise the app-side consumption of the CLI output-follow
 *  surface, NOT provider log parsing — that lives in the CLI now (see
 *  cli/test/unit/agent-output.test.ts). A FollowStream is injected so we drive
 *  NDJSON frames directly and assert the app-owned concerns: event mapping,
 *  the AskUserQuestion escape side effect, app timeout, the pre-send turn
 *  boundary (no fast-reply skip), and follow-child termination on every exit
 *  path including session close. */

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await sleep(5)
  }
}

const TURN: PendingTurn = { handle: 'h1', cursor: 'oc1_old', offset: 100 }

const evFrame = (
  kind: 'interim' | 'question' | 'final',
  text: string,
  nextOffset = 0,
): FollowFrame => ({ type: 'event', event: { kind, text }, nextOffset })

const endFrame = (reason = 'final', nextOffset = 0): FollowFrame => ({ type: 'end', reason, nextOffset })

/** A controllable in-memory FollowStream. `hang: true` blocks after the scripted
 *  frames (no terminal frame) until close() — used to exercise the app timeout
 *  and session-close cancellation. */
function fakeFollow(frames: FollowFrame[], opts: { delayMs?: number; hang?: boolean } = {}) {
  let isClosed = false
  let releaseHang: () => void = () => {}
  const hung = new Promise<void>(r => { releaseHang = r })

  async function* gen(): AsyncGenerator<FollowFrame> {
    for (const f of frames) {
      if (isClosed) return
      if (opts.delayMs) await sleep(opts.delayMs)
      if (isClosed) return
      yield f
    }
    if (opts.hang) await hung
  }

  const stream: FollowStream = {
    frames: gen(),
    close: () => { isClosed = true; releaseHang() },
  }
  return { stream, closed: () => isClosed }
}

/** Deps whose openFollow returns `stream` (the only capability streamAgentReply
 *  needs — it never samples the cursor after send). */
function depsFor(stream: FollowStream): Pick<FollowDeps, 'openFollow'> {
  return { openFollow: () => stream }
}

async function collect(gen: AsyncGenerator<AgentEvent>, max = 20): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of gen) {
    out.push(ev)
    if (out.length >= max) break
  }
  return out
}

describe('streamAgentReply (frame mapping)', () => {
  it('maps interim/final event frames to AgentEvents and ends on final', async () => {
    const { stream, closed } = fakeFollow([
      evFrame('interim', 'Looking into this'),
      evFrame('interim', 'Almost done'),
      evFrame('final', 'Here is the answer.'),
      endFrame(),
    ])
    const events = await collect(streamAgentReply(TURN, {}, depsFor(stream)))
    expect(events).toEqual([
      { kind: 'interim', text: 'Looking into this' },
      { kind: 'interim', text: 'Almost done' },
      { kind: 'final', text: 'Here is the answer.' },
    ])
    expect(closed()).toBe(true)
  })

  it('stops after final without yielding later frames', async () => {
    const { stream, closed } = fakeFollow([
      evFrame('interim', 'a'),
      evFrame('final', 'done'),
      evFrame('interim', 'should-not-appear'),
      endFrame(),
    ])
    const events = await collect(streamAgentReply(TURN, {}, depsFor(stream)))
    expect(events).toEqual([
      { kind: 'interim', text: 'a' },
      { kind: 'final', text: 'done' },
    ])
    expect(closed()).toBe(true)
  })

  it('ends when the follow stream emits an end frame (no final)', async () => {
    const { stream, closed } = fakeFollow([evFrame('interim', 'a'), endFrame('error')])
    const events = await collect(streamAgentReply(TURN, {}, depsFor(stream)))
    expect(events).toEqual([{ kind: 'interim', text: 'a' }])
    expect(closed()).toBe(true)
  })
})

describe('streamAgentReply (AskUserQuestion)', () => {
  it('invokes onAskUserQuestion BEFORE yielding the question and appends the cancel note', async () => {
    const { stream } = fakeFollow([
      evFrame('question', '🤔 Agent asks: Continue?\n\n1) yes — keep going\n2) no — stop'),
      evFrame('final', 'cancelled'),
      endFrame(),
    ])
    const order: string[] = []
    const onAsk = vi.fn(async () => { order.push('escape') })

    const events: AgentEvent[] = []
    for await (const ev of streamAgentReply(TURN, { onAskUserQuestion: onAsk }, depsFor(stream))) {
      if (ev.kind === 'question') order.push('question')
      events.push(ev)
    }

    expect(onAsk).toHaveBeenCalledOnce()
    // Escape fires before the question reaches the consumer.
    expect(order).toEqual(['escape', 'question'])
    expect(events.map(e => e.kind)).toEqual(['question', 'final'])
    const q = events[0] as { text: string }
    expect(q.text).toContain('🤔 Agent asks: Continue?')
    expect(q.text).toContain('1) yes — keep going')
    expect(q.text).toContain('Dialog auto-cancelled — just reply with your answer.')
  })

  it('keeps streaming after a question (a failing escape callback is swallowed)', async () => {
    const { stream } = fakeFollow([
      evFrame('question', '🤔 Agent asks: pick one'),
      evFrame('final', 'after escape'),
      endFrame(),
    ])
    const onAsk = vi.fn(async () => { throw new Error('tmux gone') })
    const events = await collect(streamAgentReply(TURN, { onAskUserQuestion: onAsk }, depsFor(stream)))
    expect(onAsk).toHaveBeenCalledOnce()
    expect(events.map(e => e.kind)).toEqual(['question', 'final'])
  })
})

describe('streamAgentReply (turn boundary — no fast-reply skip)', () => {
  it('opens the follower at the pre-send offset, never the current EOF', async () => {
    // The agent may write its first reply line between send and follow startup;
    // a final at nextOffset 250 means the log already grew past offset 100. The
    // follower must still start from the pre-send offset (100) so that reply is
    // read, not skipped by sampling EOF.
    const { stream } = fakeFollow([evFrame('final', 'fast reply', 250), endFrame('final', 250)])
    let opened: { handle: string; cursor: string; offset: number } | undefined
    const events = await collect(streamAgentReply(
      { handle: 'fresh-h', cursor: 'oc1', offset: 100 },
      {},
      { openFollow: (handle, cursor, offset) => { opened = { handle, cursor, offset }; return stream } },
    ))
    expect(opened).toEqual({ handle: 'fresh-h', cursor: 'oc1', offset: 100 })
    expect(events).toEqual([{ kind: 'final', text: 'fast reply' }])
  })

  it('resumes a queued same-session turn past the prior turn’s consumed bytes', async () => {
    const handle = 'queued-h'

    // Turn A consumes up to nextOffset 400.
    const a = fakeFollow([evFrame('final', 'A-final', 400), endFrame('final', 400)])
    let openedA: number | undefined
    await collect(streamAgentReply(
      { handle, cursor: 'oc1', offset: 100 },
      {},
      { openFollow: (_h, _c, offset) => { openedA = offset; return a.stream } },
    ))
    expect(openedA).toBe(100) // A starts at its own pre-send boundary

    // Turn B was sent right after A, so its pre-send offset (150) still predates
    // A's reply. B must resume from A's consumed boundary (400), not replay from
    // 150, and not sample EOF.
    const b = fakeFollow([evFrame('final', 'B-final', 600), endFrame('final', 600)])
    let openedB: number | undefined
    await collect(streamAgentReply(
      { handle, cursor: 'oc1', offset: 150 },
      {},
      { openFollow: (_h, _c, offset) => { openedB = offset; return b.stream } },
    ))
    expect(openedB).toBe(400) // max(pre-send 150, lastConsumed 400)

    cancelAgentOutput(handle) // clear lastConsumed so the handle is isolated
  })
})

describe('streamAgentReply (lifecycle: timeout, disconnect, session close)', () => {
  it('yields a timeout event and closes the stream when nothing finalizes', async () => {
    const { stream, closed } = fakeFollow([evFrame('interim', 'working')], { hang: true })
    const events = await collect(streamAgentReply(TURN, { timeoutMs: 150 }, depsFor(stream)))
    expect(events).toContainEqual({ kind: 'interim', text: 'working' })
    expect(events[events.length - 1]).toEqual({ kind: 'timeout' })
    expect(closed()).toBe(true)
  })

  it('closes the follow stream when the consumer disconnects early', async () => {
    const { stream, closed } = fakeFollow([
      evFrame('interim', 'a'),
      evFrame('interim', 'b'),
      evFrame('final', 'done'),
      endFrame(),
    ])
    const gen = streamAgentReply(TURN, {}, depsFor(stream))
    expect((await gen.next()).value).toEqual({ kind: 'interim', text: 'a' })
    await gen.return(undefined) // consumer breaks out of the for-await
    expect(closed()).toBe(true)
  })

  it('cancelAgentOutput terminates an active follower without waiting for the timeout', async () => {
    const handle = 'close-h'
    const { stream, closed } = fakeFollow([evFrame('interim', 'working')], { hang: true })
    const events: AgentEvent[] = []
    // Long app timeout so a clean finish proves cancel, not timeout, ended it.
    const consume = (async () => {
      for await (const ev of streamAgentReply(
        { handle, cursor: 'oc1', offset: 0 },
        { timeoutMs: 60_000 },
        depsFor(stream),
      )) events.push(ev)
    })()

    // Wait until the follower is registered + actively streaming.
    await waitFor(() => events.length >= 1)
    expect(closed()).toBe(false)

    cancelAgentOutput(handle) // session close

    await consume // ends promptly because the follower was closed
    expect(closed()).toBe(true)
    expect(events).toEqual([{ kind: 'interim', text: 'working' }]) // no timeout event
  })
})

describe('queueHandleStream (shared per-handle serializer)', () => {
  it('serializes work for the same handle and runs different handles in parallel', async () => {
    const events: string[] = []
    const run = (handle: string, label: string, ms: number) =>
      new Promise<void>((resolve) => {
        queueHandleStream(handle, async () => {
          events.push(`${label}:start`)
          await sleep(ms)
          events.push(`${label}:end`)
          resolve()
        })
      })

    // Two on handle X must not overlap; Y runs alongside X.
    const x1 = run('queue-X', 'x1', 60)
    const x2 = run('queue-X', 'x2', 20)
    const y1 = run('queue-Y', 'y1', 30)
    await Promise.all([x1, x2, y1])

    // x1 fully precedes x2 — same-handle work is serialized.
    expect(events.indexOf('x1:end')).toBeLessThan(events.indexOf('x2:start'))
    // y1 started before x1 finished — different handles run in parallel.
    expect(events.indexOf('y1:start')).toBeLessThan(events.indexOf('x1:end'))
  })
})

describe('spawnFollow (spawn error handling)', () => {
  it('routes an OS spawn error through controlled termination, not an unhandled crash', async () => {
    // A path that cannot exist forces the child to emit 'error' (ENOENT). The
    // 'error' listener must consume it and end the stream cleanly — without that
    // listener Node would rethrow it as an uncaughtException and crash the test.
    const stream = spawnFollow('h', 'oc1_x', 0, '/nonexistent/yaco-xyz-please-fail')

    const drained = (async () => {
      const out: FollowFrame[] = []
      for await (const f of stream.frames) out.push(f)
      return out
    })()
    const frames = await Promise.race([
      drained,
      sleep(3000).then<FollowFrame[]>(() => { throw new Error('spawnFollow frames did not terminate') }),
    ])

    expect(frames).toEqual([]) // spawn failed → no frames, stream ended gracefully
    expect(() => stream.close()).not.toThrow() // close stays safe/idempotent
  })
})

describe('startTurn', () => {
  const session = (overrides: Partial<AgentSession> = {}): AgentSession => ({
    name: 'h1', provider: 'claude', status: 'idle', project: 'p',
    sessionPath: '/tmp/p', sessionId: 'sid-1', pid: 1, ...overrides,
  })

  it('returns a PendingTurn from the resolved output cursor', async () => {
    const turn = await startTurn(session(), { resolveCursor: async () => ({ token: 'oc1_t', offset: 42 }) })
    expect(turn).toEqual({ handle: 'h1', cursor: 'oc1_t', offset: 42 })
  })

  it('returns null when the provider exposes no output cursor (tap fallback)', async () => {
    const turn = await startTurn(session({ provider: 'gemini' }), { resolveCursor: async () => null })
    expect(turn).toBeNull()
  })
})
