import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the shared read: session-summary owns the cache and the refresh edge,
// not the provider I/O, so the test drives `readSessionSummaries`.
const { readSessionSummaries } = vi.hoisted(() => ({ readSessionSummaries: vi.fn() }))
vi.mock('yaco-cli/core/agent/summaries', () => ({ readSessionSummaries }))

import { resolveSessionSummaries, invalidateSummaryCache } from '../session-summary'
import type { AgentSession } from '../agent'

interface SessionSummary {
  handle: string
  sessionId: string
  provider: string
  label: string
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    name: 'test-session',
    provider: 'claude',
    status: 'idle',
    project: 'test-project',
    sessionPath: '/tmp/test-project',
    sessionId: 'valid-session-id',
    pid: 12345,
    ...overrides,
  }
}

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    handle: 'test-session',
    sessionId: 'valid-session-id',
    provider: 'claude',
    label: 'Design the auth API',
    ...overrides,
  }
}

/** The read's `Result` envelope. */
const rows = (value: SessionSummary[]) => ({ ok: true as const, value })

describe('resolveSessionSummaries', () => {
  beforeEach(() => {
    readSessionSummaries.mockReset()
    invalidateSummaryCache()
  })

  it('returns empty map for empty sessions without reading anything', async () => {
    const result = await resolveSessionSummaries([])
    expect(result.size).toBe(0)
    expect(readSessionSummaries).not.toHaveBeenCalled()
  })

  it('skips sentinel sessionId (pending:awaiting-first-prompt)', async () => {
    const session = makeSession({ sessionId: 'pending:awaiting-first-prompt' })
    const result = await resolveSessionSummaries([session])
    expect(result.get('test-session')).toBeUndefined()
    expect(readSessionSummaries).not.toHaveBeenCalled()
  })

  it('skips empty sessionId without reading anything', async () => {
    const session = makeSession({ sessionId: '' })
    const result = await resolveSessionSummaries([session])
    expect(result.get('test-session')).toBeUndefined()
    expect(readSessionSummaries).not.toHaveBeenCalled()
  })

  it('resolves a summary keyed by handle', async () => {
    readSessionSummaries.mockResolvedValue(rows([summary({ handle: 'test-session', label: 'Build the API' })]))
    const result = await resolveSessionSummaries([makeSession()])
    expect(result.get('test-session')).toBe('Build the API')
    expect(readSessionSummaries).toHaveBeenCalledWith([{
      handle: 'test-session',
      provider: 'claude',
      sessionId: 'valid-session-id',
      sessionPath: '/tmp/test-project',
    }])
  })

  it('caches per (provider, sessionId, sessionPath): a second resolve does not re-read', async () => {
    readSessionSummaries.mockResolvedValue(rows([summary({ label: 'cached label' })]))
    const session = makeSession()

    const first = await resolveSessionSummaries([session])
    expect(first.get('test-session')).toBe('cached label')

    const second = await resolveSessionSummaries([session])
    expect(second.get('test-session')).toBe('cached label')
    expect(readSessionSummaries).toHaveBeenCalledTimes(1)
  })

  it('reads once for all misses, across any number of project paths', async () => {
    // The per-path grouping this replaced existed to coalesce spawns; with the
    // sessions passed explicitly there is no spawn left to coalesce, so every
    // miss — from however many projects — is one call carrying exactly them.
    readSessionSummaries.mockResolvedValue(rows([
      summary({ handle: 's1', sessionId: 'id1', label: 'one' }),
      summary({ handle: 's2', sessionId: 'id2', label: 'two' }),
      summary({ handle: 's3', sessionId: 'id3', label: 'three' }),
    ]))

    const result = await resolveSessionSummaries([
      makeSession({ name: 's1', sessionId: 'id1', sessionPath: '/tmp/p1' }),
      makeSession({ name: 's2', sessionId: 'id2', sessionPath: '/tmp/p1' }),
      makeSession({ name: 's3', sessionId: 'id3', sessionPath: '/tmp/p2' }),
    ])

    expect(result.get('s1')).toBe('one')
    expect(result.get('s2')).toBe('two')
    expect(result.get('s3')).toBe('three')
    expect(readSessionSummaries).toHaveBeenCalledTimes(1)
    expect(readSessionSummaries.mock.calls[0][0].map((t: { sessionPath: string }) => t.sessionPath))
      .toEqual(['/tmp/p1', '/tmp/p1', '/tmp/p2'])
  })

  it('passes only the misses, never a session already cached', async () => {
    readSessionSummaries.mockResolvedValue(rows([summary({ handle: 's1', sessionId: 'id1', label: 'one' })]))
    const cached = makeSession({ name: 's1', sessionId: 'id1' })
    await resolveSessionSummaries([cached])

    readSessionSummaries.mockResolvedValue(rows([summary({ handle: 's2', sessionId: 'id2', label: 'two' })]))
    const result = await resolveSessionSummaries([cached, makeSession({ name: 's2', sessionId: 'id2' })])

    expect(result.get('s1')).toBe('one')
    expect(result.get('s2')).toBe('two')
    expect(readSessionSummaries.mock.calls[1][0].map((t: { handle: string }) => t.handle)).toEqual(['s2'])
  })

  it('does not cache sessions with no label (still a miss next time)', async () => {
    readSessionSummaries.mockResolvedValue(rows([]))
    const session = makeSession({ provider: 'gemini' })

    const first = await resolveSessionSummaries([session])
    expect(first.get('test-session')).toBeUndefined()

    const second = await resolveSessionSummaries([session])
    expect(second.get('test-session')).toBeUndefined()
    // No label cached → both resolves re-read.
    expect(readSessionSummaries).toHaveBeenCalledTimes(2)
  })

  it('re-resolves a label when a session settles from processing to idle', async () => {
    readSessionSummaries
      .mockResolvedValueOnce(rows([summary({ label: 'first title' })]))
      .mockResolvedValueOnce(rows([summary({ label: 'updated title' })]))

    const processing = makeSession({ status: 'processing' })
    const firstRun = await resolveSessionSummaries([processing])
    expect(firstRun.get('test-session')).toBe('first title')

    // Same session now idle — the cached label is dropped and re-read.
    const idle = makeSession({ status: 'idle' })
    const secondRun = await resolveSessionSummaries([idle])
    expect(secondRun.get('test-session')).toBe('updated title')
    expect(readSessionSummaries).toHaveBeenCalledTimes(2)
  })

  it('re-resolves a label across processing→blocked→idle (blocked counts as active)', async () => {
    readSessionSummaries
      .mockResolvedValueOnce(rows([summary({ label: 'first title' })]))
      .mockResolvedValueOnce(rows([summary({ label: 'updated title' })]))

    const processing = makeSession({ status: 'processing' })
    const first = await resolveSessionSummaries([processing])
    expect(first.get('test-session')).toBe('first title')

    // Pass through blocked: must NOT re-read (still active) but must keep the
    // active marker so the later idle still drops the cached label.
    const blocked = makeSession({ status: 'blocked', blockReason: 'question' })
    const blockedRun = await resolveSessionSummaries([blocked])
    expect(blockedRun.get('test-session')).toBe('first title')
    expect(readSessionSummaries).toHaveBeenCalledTimes(1)

    // Settles to idle — cached label dropped and re-read.
    const idle = makeSession({ status: 'idle' })
    const idleRun = await resolveSessionSummaries([idle])
    expect(idleRun.get('test-session')).toBe('updated title')
    expect(readSessionSummaries).toHaveBeenCalledTimes(2)
  })

  it('invalidateSummaryCache forces a fresh read', async () => {
    readSessionSummaries.mockResolvedValue(rows([summary({ label: 'label' })]))
    const session = makeSession()

    await resolveSessionSummaries([session])
    invalidateSummaryCache()
    await resolveSessionSummaries([session])

    expect(readSessionSummaries).toHaveBeenCalledTimes(2)
  })

  it('survives a failed read without throwing, and caches nothing', async () => {
    readSessionSummaries.mockResolvedValue({ ok: false, code: 'IO', message: 'provider home unreadable' })
    const result = await resolveSessionSummaries([makeSession()])
    expect(result.get('test-session')).toBeUndefined()

    readSessionSummaries.mockResolvedValue(rows([summary({ label: 'later' })]))
    expect((await resolveSessionSummaries([makeSession()])).get('test-session')).toBe('later')
  })
})
