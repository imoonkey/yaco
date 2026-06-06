import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the CLI transport: session-summary resolves labels via the CLI surface,
// not by reading provider homes, so the test drives fetchSessionSummaries.
const { fetchSessionSummaries } = vi.hoisted(() => ({ fetchSessionSummaries: vi.fn() }))
vi.mock('../agent', () => ({ fetchSessionSummaries }))

import { resolveSessionSummaries, invalidateSummaryCache } from '../session-summary'
import type { AgentSession } from '../agent'
import type { CliSessionSummary } from '../agent'

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

function summary(overrides: Partial<CliSessionSummary> = {}): CliSessionSummary {
  return {
    handle: 'test-session',
    sessionId: 'valid-session-id',
    provider: 'claude',
    label: 'Design the auth API',
    ...overrides,
  }
}

describe('resolveSessionSummaries', () => {
  beforeEach(() => {
    fetchSessionSummaries.mockReset()
    invalidateSummaryCache()
  })

  it('returns empty map for empty sessions without calling the CLI', async () => {
    const result = await resolveSessionSummaries([])
    expect(result.size).toBe(0)
    expect(fetchSessionSummaries).not.toHaveBeenCalled()
  })

  it('skips sentinel sessionId (pending:awaiting-first-prompt)', async () => {
    const session = makeSession({ sessionId: 'pending:awaiting-first-prompt' })
    const result = await resolveSessionSummaries([session])
    expect(result.get('test-session')).toBeUndefined()
    expect(fetchSessionSummaries).not.toHaveBeenCalled()
  })

  it('skips empty sessionId without calling the CLI', async () => {
    const session = makeSession({ sessionId: '' })
    const result = await resolveSessionSummaries([session])
    expect(result.get('test-session')).toBeUndefined()
    expect(fetchSessionSummaries).not.toHaveBeenCalled()
  })

  it('resolves a summary from the CLI keyed by handle', async () => {
    fetchSessionSummaries.mockResolvedValue([summary({ handle: 'test-session', label: 'Build the API' })])
    const result = await resolveSessionSummaries([makeSession()])
    expect(result.get('test-session')).toBe('Build the API')
    expect(fetchSessionSummaries).toHaveBeenCalledWith('/tmp/test-project')
  })

  it('caches per (provider, sessionId, sessionPath): a second resolve does not re-call the CLI', async () => {
    fetchSessionSummaries.mockResolvedValue([summary({ label: 'cached label' })])
    const session = makeSession()

    const first = await resolveSessionSummaries([session])
    expect(first.get('test-session')).toBe('cached label')

    const second = await resolveSessionSummaries([session])
    expect(second.get('test-session')).toBe('cached label')
    expect(fetchSessionSummaries).toHaveBeenCalledTimes(1)
  })

  it('calls the CLI once per distinct project path with a miss', async () => {
    fetchSessionSummaries.mockImplementation(async (path: string) => {
      if (path === '/tmp/p1') {
        return [
          summary({ handle: 's1', sessionId: 'id1', label: 'one' }),
          summary({ handle: 's2', sessionId: 'id2', label: 'two' }),
        ]
      }
      return [summary({ handle: 's3', sessionId: 'id3', label: 'three' })]
    })

    const result = await resolveSessionSummaries([
      makeSession({ name: 's1', sessionId: 'id1', sessionPath: '/tmp/p1' }),
      makeSession({ name: 's2', sessionId: 'id2', sessionPath: '/tmp/p1' }),
      makeSession({ name: 's3', sessionId: 'id3', sessionPath: '/tmp/p2' }),
    ])

    expect(result.get('s1')).toBe('one')
    expect(result.get('s2')).toBe('two')
    expect(result.get('s3')).toBe('three')
    // Two distinct paths → exactly two CLI calls (not one per session).
    expect(fetchSessionSummaries).toHaveBeenCalledTimes(2)
  })

  it('does not cache sessions the CLI has no label for (still a miss next time)', async () => {
    fetchSessionSummaries.mockResolvedValue([])
    const session = makeSession({ provider: 'gemini' })

    const first = await resolveSessionSummaries([session])
    expect(first.get('test-session')).toBeUndefined()

    const second = await resolveSessionSummaries([session])
    expect(second.get('test-session')).toBeUndefined()
    // No label cached → both resolves re-query the CLI.
    expect(fetchSessionSummaries).toHaveBeenCalledTimes(2)
  })

  it('re-resolves a label when a session settles from processing to idle', async () => {
    fetchSessionSummaries
      .mockResolvedValueOnce([summary({ label: 'first title' })])
      .mockResolvedValueOnce([summary({ label: 'updated title' })])

    const processing = makeSession({ status: 'processing' })
    const firstRun = await resolveSessionSummaries([processing])
    expect(firstRun.get('test-session')).toBe('first title')

    // Same session now idle — the cached label is dropped and re-fetched.
    const idle = makeSession({ status: 'idle' })
    const secondRun = await resolveSessionSummaries([idle])
    expect(secondRun.get('test-session')).toBe('updated title')
    expect(fetchSessionSummaries).toHaveBeenCalledTimes(2)
  })

  it('invalidateSummaryCache forces a fresh CLI call', async () => {
    fetchSessionSummaries.mockResolvedValue([summary({ label: 'label' })])
    const session = makeSession()

    await resolveSessionSummaries([session])
    invalidateSummaryCache()
    await resolveSessionSummaries([session])

    expect(fetchSessionSummaries).toHaveBeenCalledTimes(2)
  })

  it('survives a CLI error without throwing', async () => {
    fetchSessionSummaries.mockRejectedValue(new Error('cli exploded'))
    const result = await resolveSessionSummaries([makeSession()])
    expect(result.get('test-session')).toBeUndefined()
  })
})
