import { describe, expect, it, vi } from 'vitest'
import { CodexTranscribeError } from '../src/index.ts'
import {
  formatLiveEvent,
  mimeTypeForPath,
  parseAttemptCount,
  parseFixturePaths,
  runLive,
  statusForError,
  type LiveDependencies,
  type LiveEnvironment,
} from '../scripts/live-contract.ts'

function dependencies(overrides: Partial<LiveDependencies> = {}): LiveDependencies {
  let now = 100
  return {
    inspect: vi.fn(async () => ({ available: true as const })),
    readAudio: vi.fn(async () => Uint8Array.from([1, 2, 3])),
    transcribe: vi.fn(async () => 'private transcript'),
    now: vi.fn(() => { now += 25; return now }),
    timeout: vi.fn(() => AbortSignal.abort()),
    emit: vi.fn(),
    ...overrides,
  }
}

function environment(overrides: LiveEnvironment = {}): LiveEnvironment {
  return {
    CODEX_TRANSCRIBE_LIVE: '1',
    CODEX_TRANSCRIBE_FIXTURES: JSON.stringify(['/tmp/private.webm']),
    ...overrides,
  }
}

describe('Codex live runner contract', () => {
  it.each([
    ['/tmp/take.webm', 'audio/webm'],
    ['/tmp/take.WEBM', 'audio/webm'],
    ['/tmp/take.mp4', 'audio/mp4'],
    ['/tmp/take.m4a', 'audio/mp4'],
  ])('maps %s to %s', (path, expected) => {
    expect(mimeTypeForPath(path)).toBe(expected)
  })

  it('rejects unsupported input without echoing its path', () => {
    const privatePath = '/tmp/private-user-recording.flac'
    expect(() => mimeTypeForPath(privatePath)).toThrow('unsupported audio type')
    try {
      mimeTypeForPath(privatePath)
    } catch (error) {
      expect(String(error)).not.toContain(privatePath)
    }
  })

  it.each([
    [undefined, 5],
    ['', 5],
    ['1', 1],
    ['20', 20],
  ])('parses attempt count %s', (raw, expected) => {
    expect(parseAttemptCount(raw)).toBe(expected)
  })

  it.each(['0', '21', '1.5', '1e1', '0x10', ' 5 ', 'abc'])(
    'rejects invalid attempt count %s',
    (raw) => expect(() => parseAttemptCount(raw)).toThrow('invalid attempt count'),
  )

  it('parses a bounded JSON fixture list', () => {
    expect(parseFixturePaths('["/tmp/a.webm","/tmp/b.mp4"]')).toEqual([
      '/tmp/a.webm',
      '/tmp/b.mp4',
    ])
  })

  it.each([undefined, '', 'null', '[]', '[""]', '{}', JSON.stringify(Array(3).fill('/tmp/a.webm'))])(
    'rejects invalid fixture list %s',
    (raw) => expect(() => parseFixturePaths(raw)).toThrow('invalid fixture list'),
  )

  it('whitelists event fields even when runtime input has sensitive extras', () => {
    const output = formatLiveEvent({
      status: 'ok',
      mimeType: 'audio/webm',
      attempt: 2,
      latencyMs: 321,
      transcript: 'must disappear',
      token: 'must disappear',
      filename: '/tmp/private.webm',
      cause: new Error('must disappear'),
    })
    expect(JSON.parse(output)).toEqual({
      status: 'ok',
      mimeType: 'audio/webm',
      attempt: 2,
      latencyMs: 321,
    })
  })

  it.each([
    ['expired_auth', 'error:expired_auth'],
    ['forbidden', 'error:forbidden'],
    ['rate_limited', 'error:rate_limited'],
  ] as const)('maps typed %s without its message or cause', (code, expected) => {
    const error = new CodexTranscribeError(code, { cause: new Error('private cause') })
    expect(statusForError(error)).toBe(expected)
    expect(statusForError(error)).not.toContain(error.message)
    expect(statusForError(error)).not.toContain('private cause')
  })

  it('maps unexpected errors without their details', () => {
    expect(statusForError(new Error('private unexpected detail'))).toBe('error:unexpected')
  })

  it('requires explicit opt-in without reading fixtures', async () => {
    const deps = dependencies()
    expect(await runLive(environment({ CODEX_TRANSCRIBE_LIVE: undefined }), deps)).toBe(2)
    expect(deps.readAudio).not.toHaveBeenCalled()
    expect(deps.emit).toHaveBeenCalledWith(formatLiveEvent({
      status: 'disabled', mimeType: 'none', attempt: 0, latencyMs: 0,
    }))
  })

  it.each([
    {
      CODEX_TRANSCRIBE_FIXTURES: '["/tmp/private.webm",7]',
      CODEX_TRANSCRIBE_ATTEMPTS: '5',
    },
    {
      CODEX_TRANSCRIBE_FIXTURES: '["/tmp/private.webm"]',
      CODEX_TRANSCRIBE_ATTEMPTS: '99',
    },
  ])('fails closed on invalid runner environment without echoing it', async (invalid) => {
    const emitted: string[] = []
    const deps = dependencies({ emit: line => emitted.push(line) })
    expect(await runLive(environment(invalid), deps)).toBe(2)
    expect(emitted).toEqual([formatLiveEvent({
      status: 'error:input', mimeType: 'none', attempt: 0, latencyMs: 0,
    })])
    expect(emitted.join('\n')).not.toContain('private.webm')
    expect(deps.inspect).not.toHaveBeenCalled()
  })

  it.each(['missing_auth', 'unsupported_auth', 'invalid_auth', 'expired_auth'] as const)(
    'surfaces safe unavailable reason %s',
    async (reason) => {
      const deps = dependencies({ inspect: vi.fn(async () => ({ available: false as const, reason })) })
      expect(await runLive(environment(), deps)).toBe(1)
      expect(deps.emit).toHaveBeenCalledWith(formatLiveEvent({
        status: `unavailable:${reason}`, mimeType: 'none', attempt: 0, latencyMs: 0,
      }))
    },
  )

  it('runs bounded attempts with a 60-second signal and emits no private values', async () => {
    const emitted: string[] = []
    const deps = dependencies({ emit: line => emitted.push(line) })
    const env = environment({
      CODEX_TRANSCRIBE_ATTEMPTS: '2',
      CODEX_TRANSCRIBE_FIXTURES: JSON.stringify([
        '/tmp/private-user.webm',
        '/tmp/private-user.mp4',
      ]),
    })

    expect(await runLive(env, deps)).toBe(0)
    expect(deps.transcribe).toHaveBeenCalledTimes(4)
    expect(deps.timeout).toHaveBeenCalledTimes(4)
    expect(deps.timeout).toHaveBeenCalledWith(60_000)
    const calls = vi.mocked(deps.transcribe).mock.calls.map(([input]) => input)
    expect(calls.map(input => [input.filename, input.mimeType])).toEqual([
      ['fixture.webm', 'audio/webm'],
      ['fixture.webm', 'audio/webm'],
      ['fixture.mp4', 'audio/mp4'],
      ['fixture.mp4', 'audio/mp4'],
    ])
    expect(JSON.stringify(calls)).not.toContain('private-user')
    for (const line of emitted) {
      expect(Object.keys(JSON.parse(line)).sort()).toEqual([
        'attempt', 'latencyMs', 'mimeType', 'status',
      ])
      expect(line).not.toContain('private-user')
      expect(line).not.toContain('private transcript')
    }
  })

  it('fails fast on a typed error without leaking details', async () => {
    const emitted: string[] = []
    const transcribe = vi.fn(async () => {
      throw new CodexTranscribeError('forbidden', { cause: new Error('private body') })
    })
    const deps = dependencies({ transcribe, emit: line => emitted.push(line) })

    expect(await runLive(environment({ CODEX_TRANSCRIBE_ATTEMPTS: '5' }), deps)).toBe(1)
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toContain('error:forbidden')
    expect(emitted[0]).not.toContain('private body')
  })

  it('fails on empty transcript without emitting it', async () => {
    const deps = dependencies({ transcribe: vi.fn(async () => '   ') })
    expect(await runLive(environment(), deps)).toBe(1)
    expect(deps.emit).toHaveBeenCalledWith(formatLiveEvent({
      status: 'error:empty', mimeType: 'audio/webm', attempt: 1, latencyMs: 25,
    }))
  })

  it('fails on private input path without emitting the path', async () => {
    const emitted: string[] = []
    const deps = dependencies({
      readAudio: vi.fn(async () => { throw new Error('read failed') }),
      emit: line => emitted.push(line),
    })
    const privatePath = '/tmp/private-user-recording.webm'
    expect(await runLive(environment({
      CODEX_TRANSCRIBE_FIXTURES: JSON.stringify([privatePath]),
    }), deps)).toBe(2)
    expect(emitted.join('\n')).not.toContain(privatePath)
  })
})
