import { describe, expect, it, vi } from 'vitest'
import { CodexTranscribeError } from '../src/index.ts'
import {
  LIVE_MAX_PCM_BYTES,
  LIVE_SAMPLE_RATE_HZ,
  formatLiveEvent,
  mimeTypeForPath,
  parseAttemptCount,
  parseFixturePath,
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
    decodePcm16: vi.fn(async () => Uint8Array.from([1, 0, 2, 0, 3, 0])),
    openStream: vi.fn(async () => ({
      appendPcm16: vi.fn(),
      finish: vi.fn(async () => 'private transcript'),
      close: vi.fn(),
    })),
    transcribe: vi.fn(async () => 'private transcript'),
    now: vi.fn(() => { now += 25; return now }),
    wait: vi.fn(async () => {}),
    timeout: vi.fn(() => new AbortController().signal),
    emit: vi.fn(),
    ...overrides,
  }
}

function environment(overrides: LiveEnvironment = {}): LiveEnvironment {
  return {
    CODEX_TRANSCRIBE_LIVE: '1',
    CODEX_TRANSCRIBE_FIXTURE: '/tmp/private.webm',
    ...overrides,
  }
}

describe('Codex live runner contract', () => {
  it('caps decoded PCM at 30 seconds', () => {
    expect(LIVE_MAX_PCM_BYTES).toBe(LIVE_SAMPLE_RATE_HZ * 2 * 30)
  })

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
    ['5', 5],
    ['20', 20],
  ])('parses attempt count %s', (raw, expected) => {
    expect(parseAttemptCount(raw)).toBe(expected)
  })

  it.each(['0', '4', '21', '5.5', '1e1', '0x10', ' 5 ', 'abc'])(
    'rejects invalid attempt count %s',
    (raw) => expect(() => parseAttemptCount(raw)).toThrow('invalid attempt count'),
  )

  it('requires one fixture path', () => {
    expect(parseFixturePath('/tmp/private.webm')).toBe('/tmp/private.webm')
    expect(parseFixturePath(' /tmp/private.webm ')).toBe('/tmp/private.webm')
    for (const raw of [undefined, '', ' ', '\0']) {
      expect(() => parseFixturePath(raw)).toThrow('invalid fixture')
    }
  })

  it('whitelists event fields even when runtime input has sensitive extras', () => {
    const output = formatLiveEvent({
      mode: 'stream',
      status: 'ok',
      attempt: 2,
      stopToRawMs: 321,
      transcriptComparison: 'match',
      transcript: 'must disappear',
      token: 'must disappear',
      filename: '/tmp/private.webm',
      audio: Uint8Array.from([1, 2, 3]),
      cause: new Error('must disappear'),
    })
    expect(JSON.parse(output)).toEqual({
      mode: 'stream',
      status: 'ok',
      attempt: 2,
      stopToRawMs: 321,
      transcriptComparison: 'match',
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

  it('maps unexpected errors without their message', () => {
    const error = new Error('private fixture path and upstream body')
    expect(statusForError(error)).toBe('error:unexpected')
    expect(statusForError(error)).not.toContain(error.message)
  })

  it('requires explicit opt-in without reading fixtures', async () => {
    const deps = dependencies()
    expect(await runLive(environment({ CODEX_TRANSCRIBE_LIVE: undefined }), deps)).toBe(2)
    expect(deps.readAudio).not.toHaveBeenCalled()
    expect(deps.emit).toHaveBeenCalledWith(formatLiveEvent({
      mode: 'none', status: 'disabled', attempt: 0, stopToRawMs: 0,
      transcriptComparison: 'not_applicable',
    }))
  })

  it.each([
    { CODEX_TRANSCRIBE_FIXTURE: '', CODEX_TRANSCRIBE_ATTEMPTS: '5' },
    { CODEX_TRANSCRIBE_FIXTURE: '/tmp/private.webm', CODEX_TRANSCRIBE_ATTEMPTS: '99' },
  ])('fails closed on invalid runner environment without echoing it', async (invalid) => {
    const emitted: string[] = []
    const deps = dependencies({ emit: line => emitted.push(line) })
    expect(await runLive(environment(invalid), deps)).toBe(2)
    expect(emitted).toEqual([formatLiveEvent({
      mode: 'none', status: 'error:input', attempt: 0, stopToRawMs: 0,
      transcriptComparison: 'not_applicable',
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
        mode: 'none', status: `unavailable:${reason}`, attempt: 0, stopToRawMs: 0,
        transcriptComparison: 'not_applicable',
      }))
    },
  )

  it('runs paired batch and real-time PCM attempts with Stop-only timing', async () => {
    const emitted: string[] = []
    let nowMs = 100
    const appendPcm16 = vi.fn((_chunk: Uint8Array) => { nowMs += 1_000 })
    const close = vi.fn()
    const deps = dependencies({
      emit: line => emitted.push(line),
      decodePcm16: vi.fn(async (_path, sampleRateHz) => {
        expect(sampleRateHz).toBe(LIVE_SAMPLE_RATE_HZ)
        return new Uint8Array(2_052)
      }),
      openStream: vi.fn(async () => ({
        appendPcm16,
        finish: vi.fn(async () => {
          nowMs += 25
          return ' private   transcript '
        }),
        close,
      })),
      transcribe: vi.fn(async () => {
        nowMs += 25
        return 'private transcript'
      }),
      now: vi.fn(() => nowMs),
    })

    expect(await runLive(environment({ CODEX_TRANSCRIBE_ATTEMPTS: '5' }), deps)).toBe(0)
    expect(deps.transcribe).toHaveBeenCalledTimes(5)
    expect(deps.openStream).toHaveBeenCalledTimes(5)
    expect(deps.decodePcm16).toHaveBeenCalledWith(
      '/tmp/private.webm', LIVE_SAMPLE_RATE_HZ, LIVE_MAX_PCM_BYTES,
    )
    expect(deps.openStream).toHaveBeenCalledWith({
      sampleRateHz: LIVE_SAMPLE_RATE_HZ,
      signal: expect.any(AbortSignal),
    })
    expect(appendPcm16).toHaveBeenCalledTimes(10)
    expect(vi.mocked(appendPcm16).mock.calls.map(([chunk]) => chunk.byteLength)).toEqual(
      Array.from({ length: 5 }, () => [2_048, 4]).flat(),
    )
    expect(deps.wait).toHaveBeenCalledTimes(10)
    const fullFrameMs = (1_024 / LIVE_SAMPLE_RATE_HZ) * 1_000
    const tailFrameMs = (2 / LIVE_SAMPLE_RATE_HZ) * 1_000
    expect(vi.mocked(deps.wait).mock.calls.map(([milliseconds]) => milliseconds)).toEqual(
      Array.from({ length: 5 }, () => [fullFrameMs, tailFrameMs]).flat(),
    )
    expect(close).toHaveBeenCalledTimes(5)
    expect(deps.timeout).toHaveBeenCalledTimes(10)
    expect(deps.timeout).toHaveBeenCalledWith(60_000)

    const events = emitted.map(line => JSON.parse(line) as Record<string, unknown>)
    expect(events).toHaveLength(10)
    expect(events.map(event => event.mode)).toEqual(
      Array.from({ length: 5 }, () => ['batch', 'stream']).flat(),
    )
    expect(events.filter(event => event.mode === 'stream').map(event => event.transcriptComparison))
      .toEqual(Array(5).fill('match'))
    expect(events.every(event => event.stopToRawMs === 25)).toBe(true)
    for (const line of emitted) {
      expect(Object.keys(JSON.parse(line)).sort()).toEqual([
        'attempt', 'mode', 'status', 'stopToRawMs', 'transcriptComparison',
      ])
      expect(line).not.toContain('private.webm')
      expect(line).not.toContain('private transcript')
    }
  })

  it('rejects a fixture above the 30-second PCM bound before any endpoint call', async () => {
    const deps = dependencies({
      decodePcm16: vi.fn(async () => new Uint8Array(LIVE_MAX_PCM_BYTES + 2)),
    })
    expect(await runLive(environment(), deps)).toBe(2)
    expect(deps.transcribe).not.toHaveBeenCalled()
    expect(deps.openStream).not.toHaveBeenCalled()
    expect(deps.emit).toHaveBeenCalledWith(expect.stringContaining('error:input'))
  })

  it('records transcript disagreement without emitting either transcript', async () => {
    const emitted: string[] = []
    const deps = dependencies({
      emit: line => emitted.push(line),
      openStream: vi.fn(async () => ({
        appendPcm16: vi.fn(),
        finish: vi.fn(async () => 'private stream value'),
        close: vi.fn(),
      })),
      transcribe: vi.fn(async () => 'private batch value'),
    })
    expect(await runLive(environment(), deps)).toBe(0)
    expect(emitted.at(-1)).toContain('"transcriptComparison":"different"')
    expect(emitted.join('\n')).not.toContain('private stream value')
    expect(emitted.join('\n')).not.toContain('private batch value')
  })

  it('fails fast on a typed batch error without leaking details', async () => {
    const emitted: string[] = []
    const transcribe = vi.fn(async () => {
      throw new CodexTranscribeError('forbidden', { cause: new Error('private body') })
    })
    const deps = dependencies({ transcribe, emit: line => emitted.push(line) })

    expect(await runLive(environment(), deps)).toBe(1)
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(deps.openStream).not.toHaveBeenCalled()
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toContain('error:forbidden')
    expect(emitted[0]).not.toContain('private body')
  })

  it('fails fast on a non-transient stream failure without emitting private details', async () => {
    const emitted: string[] = []
    const close = vi.fn()
    const deps = dependencies({
      emit: line => emitted.push(line),
      openStream: vi.fn(async () => ({
        appendPcm16: vi.fn(),
        finish: vi.fn(async () => {
          throw new CodexTranscribeError('upstream', { cause: new Error('private upstream body') })
        }),
        close,
      })),
    })
    expect(await runLive(environment(), deps)).toBe(1)
    expect(deps.openStream).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(emitted).toHaveLength(2)
    expect(emitted.at(-1)).toContain('error:upstream')
    expect(emitted.join('\n')).not.toContain('private upstream body')
  })

  it.each([
    ['batch', { transcribe: vi.fn(async () => '   ') }],
    ['stream', {
      openStream: vi.fn(async () => ({
        appendPcm16: vi.fn(), finish: vi.fn(async () => '   '), close: vi.fn(),
      })),
    }],
  ] as const)('fails on empty %s transcript without emitting it', async (mode, override) => {
    const deps = dependencies(override)
    expect(await runLive(environment(), deps)).toBe(1)
    expect(deps.emit).toHaveBeenCalledWith(expect.stringContaining('error:empty'))
    expect(deps.emit).toHaveBeenCalledTimes(mode === 'batch' ? 1 : 2)
  })

  it('fails on private fixture input without emitting the path', async () => {
    const emitted: string[] = []
    const deps = dependencies({
      readAudio: vi.fn(async () => { throw new Error('read failed') }),
      emit: line => emitted.push(line),
    })
    const privatePath = '/tmp/private-user-recording.webm'
    expect(await runLive(environment({ CODEX_TRANSCRIBE_FIXTURE: privatePath }), deps)).toBe(2)
    expect(emitted.join('\n')).not.toContain(privatePath)
  })
})
