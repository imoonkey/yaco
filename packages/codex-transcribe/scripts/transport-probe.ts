import { performance } from 'node:perf_hooks'
import { register } from 'tsx/esm/api'
import type {
  CodexDictationSession,
  CodexTranscribeErrorCode,
} from '../src/index.ts'

const unregister = register()
const {
  CodexTranscribeError,
  inspectCodexTranscribe,
  openCodexDictationSession,
} = await import('../src/index.ts')

const SAMPLE_RATE_HZ = 48_000
const FRAME_SAMPLES = 1_024
const AUDIO_DURATION_MS = 250

type ProbePhase =
  | 'disabled'
  | 'auth'
  | 'upgrade'
  | 'session_started'
  | 'session_closed'

type ProbeStatus =
  | 'disabled'
  | 'ok'
  | 'error:input'
  | 'error:unexpected'
  | `error:${CodexTranscribeErrorCode}`
  | `unavailable:${Exclude<
      Awaited<ReturnType<typeof inspectCodexTranscribe>>,
      { available: true }
    >['reason']}`

type ProbeResult = {
  readonly host: string
  readonly endpointHost: 'chatgpt.com'
  readonly endpointPath: '/backend-api/dictation/stream'
  readonly transport: 'wss'
  readonly subprotocols: readonly string[]
  readonly requestShape: 'app-exact'
  readonly syntheticAudio: 'not_sent' | 'pcm16-mono-48khz-tone-250ms'
  readonly phase: ProbePhase
  readonly status: ProbeStatus
  readonly elapsedMs: number
}

function emit(result: ProbeResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

function hostLabel(raw: string | undefined): 'desktop' | 'laptop' | undefined {
  return raw === 'desktop' || raw === 'laptop' ? raw : undefined
}

function syntheticFrames(): readonly Uint8Array[] {
  const sampleCount = SAMPLE_RATE_HZ * AUDIO_DURATION_MS / 1_000
  const pcm = new Int16Array(sampleCount)
  for (let index = 0; index < pcm.length; index += 1) {
    const angle = index * 2 * Math.PI * 440 / SAMPLE_RATE_HZ
    pcm[index] = Math.round(Math.sin(angle) * 3_276)
  }
  const bytes = new Uint8Array(pcm.buffer)
  const frameBytes = FRAME_SAMPLES * 2
  const frames: Uint8Array[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += frameBytes) {
    frames.push(bytes.subarray(offset, Math.min(offset + frameBytes, bytes.byteLength)))
  }
  return frames
}

async function run(): Promise<ProbeResult> {
  const startedAt = performance.now()
  const host = hostLabel(process.env.CODEX_TRANSPORT_PROBE_HOST)
  const base = {
    host: host ?? 'invalid',
    endpointHost: 'chatgpt.com' as const,
    endpointPath: '/backend-api/dictation/stream' as const,
    transport: 'wss' as const,
    subprotocols: [
      'chatgpt-dictation',
      'openai-bearer.<redacted>',
      'codex-desktop',
    ],
    requestShape: 'app-exact' as const,
  }
  const result = (
    phase: ProbePhase,
    status: ProbeStatus,
    syntheticAudio: ProbeResult['syntheticAudio'] = 'not_sent',
  ): ProbeResult => ({
    ...base,
    syntheticAudio,
    phase,
    status,
    elapsedMs: Math.round(performance.now() - startedAt),
  })

  if (process.env.CODEX_TRANSCRIBE_TRANSPORT_PROBE !== '1') {
    return result('disabled', 'disabled')
  }
  if (host === undefined) return result('auth', 'error:input')

  let availability: Awaited<ReturnType<typeof inspectCodexTranscribe>>
  try {
    availability = await inspectCodexTranscribe()
  } catch {
    return result('auth', 'error:unexpected')
  }
  if (!availability.available) {
    return result('auth', `unavailable:${availability.reason}`)
  }

  let phase: ProbePhase = 'upgrade'
  let session: CodexDictationSession | undefined
  try {
    session = await openCodexDictationSession({ sampleRateHz: SAMPLE_RATE_HZ })
    phase = 'session_started'
    for (const frame of syntheticFrames()) session.appendPcm16(frame)
    await session.finish()
    phase = 'session_closed'
    return result(phase, 'ok', 'pcm16-mono-48khz-tone-250ms')
  } catch (error) {
    const status: ProbeStatus = error instanceof CodexTranscribeError
      ? `error:${error.code}`
      : 'error:unexpected'
    return result(
      phase,
      status,
      phase === 'session_started'
        ? 'pcm16-mono-48khz-tone-250ms'
        : 'not_sent',
    )
  } finally {
    session?.close()
  }
}

try {
  emit(await run())
} finally {
  unregister()
}
