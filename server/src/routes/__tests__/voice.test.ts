import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Shared mock instance - reset each test
let mockTranscriptionCreate: ReturnType<typeof vi.fn>
let mockChatCreate: ReturnType<typeof vi.fn>

// Mock groq-sdk before importing the route
vi.mock('groq-sdk', () => {
  class APIError extends Error {
    status: number
    constructor(status: number, _body: unknown, message: string) {
      super(message)
      this.status = status
      this.name = 'APIError'
    }
  }
  class APIConnectionError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'APIConnectionError'
    }
  }
  // Use a class so `new Groq()` works
  class MockGroq {
    audio = {
      transcriptions: {
        get create() { return mockTranscriptionCreate },
      },
    }
    chat = {
      completions: {
        get create() { return mockChatCreate },
      },
    }
  }
  Object.assign(MockGroq, { APIError, APIConnectionError })
  return { default: MockGroq }
})

vi.mock('groq-sdk/uploads', () => ({
  toFile: vi.fn().mockResolvedValue({ name: 'audio.webm' }),
}))

// Import after mocks are set up
import Groq from 'groq-sdk'
import { voiceRoutes } from '../voice'

function makeAudioBlob(size = 1000): File {
  const bytes = new Uint8Array(size)
  return new File([bytes], 'audio.webm', { type: 'audio/webm' })
}

function makeFormData(fields: Record<string, string | File>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) {
    fd.append(k, v)
  }
  return fd
}

describe('GET /status', () => {
  afterEach(() => {
    delete process.env.GROQ_API_KEY
    delete process.env.GROQ_TRANSCRIPTION_MODEL
    delete process.env.GROQ_FORMATTER_MODEL
  })

  it('returns enabled:false when GROQ_API_KEY is not set', async () => {
    delete process.env.GROQ_API_KEY
    const res = await voiceRoutes.request('/status')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ enabled: false, reason: 'missing_api_key' })
  })

  it('returns enabled:true with defaults when GROQ_API_KEY is set', async () => {
    process.env.GROQ_API_KEY = 'test-key'
    const res = await voiceRoutes.request('/status')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({
      enabled: true,
      sttModel: 'whisper-large-v3-turbo',
      formatterModel: 'llama-3.1-8b-instant',
      maxUploadBytes: 20_000_000,
    })
  })

  it('uses custom model env vars', async () => {
    process.env.GROQ_API_KEY = 'test-key'
    process.env.GROQ_TRANSCRIPTION_MODEL = 'whisper-large-v3'
    process.env.GROQ_FORMATTER_MODEL = 'llama-3.3-70b-versatile'
    const res = await voiceRoutes.request('/status')
    const json = await res.json()
    expect(json.sttModel).toBe('whisper-large-v3')
    expect(json.formatterModel).toBe('llama-3.3-70b-versatile')
  })
})

describe('POST /compose', () => {
  beforeEach(() => {
    process.env.GROQ_API_KEY = 'test-key'
    mockTranscriptionCreate = vi.fn()
    mockChatCreate = vi.fn()
  })

  afterEach(() => {
    delete process.env.GROQ_API_KEY
  })

  it('returns 503 when GROQ_API_KEY is missing', async () => {
    delete process.env.GROQ_API_KEY
    const body = makeFormData({ audio: makeAudioBlob(), surface: 'terminal' })
    const res = await voiceRoutes.request('/compose', { method: 'POST', body })
    expect(res.status).toBe(503)
    const json = await res.json()
    expect(json.error).toBe('Voice input is unavailable. Set GROQ_API_KEY.')
  })

  it('returns 400 for missing audio', async () => {
    const body = makeFormData({ surface: 'terminal' })
    const res = await voiceRoutes.request('/compose', { method: 'POST', body })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('Invalid voice recording.')
  })

  it('returns 400 for invalid surface', async () => {
    const body = makeFormData({ audio: makeAudioBlob(), surface: 'invalid' })
    const res = await voiceRoutes.request('/compose', { method: 'POST', body })
    expect(res.status).toBe(400)
  })

  it('returns 413 for oversized audio', async () => {
    const body = makeFormData({
      audio: makeAudioBlob(20_000_001),
      surface: 'terminal',
    })
    const res = await voiceRoutes.request('/compose', { method: 'POST', body })
    expect(res.status).toBe(413)
    const json = await res.json()
    expect(json.error).toBe('Recording too large. Keep it short.')
  })

  it('returns formatted text on success', async () => {
    mockTranscriptionCreate.mockResolvedValue({ text: 'git status dash s b' })
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: 'git status -sb' } }],
    })

    const body = makeFormData({ audio: makeAudioBlob(), surface: 'terminal' })
    const res = await voiceRoutes.request('/compose', { method: 'POST', body })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({
      rawText: 'git status dash s b',
      displayText: 'git status -sb',
      formattingStatus: 'formatted',
    })
  })

  it('returns empty status for empty transcript', async () => {
    mockTranscriptionCreate.mockResolvedValue({ text: '' })

    const body = makeFormData({ audio: makeAudioBlob(), surface: 'editor' })
    const res = await voiceRoutes.request('/compose', { method: 'POST', body })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({
      rawText: '',
      displayText: '',
      formattingStatus: 'empty',
    })
  })

  it('falls back to raw text on formatter failure', async () => {
    mockTranscriptionCreate.mockResolvedValue({ text: 'some dictated text' })
    mockChatCreate.mockRejectedValue(new Error('LLM error'))

    const body = makeFormData({ audio: makeAudioBlob(), surface: 'editor' })
    const res = await voiceRoutes.request('/compose', { method: 'POST', body })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({
      rawText: 'some dictated text',
      displayText: 'some dictated text',
      formattingStatus: 'fallback_raw',
      warning: 'Formatting failed; showing raw transcript.',
    })
  })

  it('falls back when formatter returns empty content', async () => {
    mockTranscriptionCreate.mockResolvedValue({ text: 'hello world' })
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: '' } }],
    })

    const body = makeFormData({ audio: makeAudioBlob(), surface: 'editor' })
    const res = await voiceRoutes.request('/compose', { method: 'POST', body })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.formattingStatus).toBe('fallback_raw')
    expect(json.displayText).toBe('hello world')
  })

  it('returns 429 on upstream rate limit', async () => {
    const { APIError } = Groq as unknown as { APIError: new (...args: unknown[]) => Error & { status: number } }
    mockTranscriptionCreate.mockRejectedValue(new APIError(429, null, 'rate limited'))

    const body = makeFormData({ audio: makeAudioBlob(), surface: 'terminal' })
    const res = await voiceRoutes.request('/compose', { method: 'POST', body })
    expect(res.status).toBe(429)
    const json = await res.json()
    expect(json.error).toBe('Rate limit reached. Try again shortly.')
  })

  it('returns 502 on upstream network error', async () => {
    const { APIConnectionError } = Groq as unknown as { APIConnectionError: new (message: string) => Error }
    mockTranscriptionCreate.mockRejectedValue(new APIConnectionError('network fail'))

    const body = makeFormData({ audio: makeAudioBlob(), surface: 'terminal' })
    const res = await voiceRoutes.request('/compose', { method: 'POST', body })
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.error).toBe('Transcription failed. Try again.')
  })

  it('passes language hint to Whisper when provided', async () => {
    mockTranscriptionCreate.mockResolvedValue({ text: 'bonjour' })
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: 'Bonjour.' } }],
    })

    const body = makeFormData({ audio: makeAudioBlob(), surface: 'editor', language: 'fr' })
    const res = await voiceRoutes.request('/compose', { method: 'POST', body })
    expect(res.status).toBe(200)

    const sttCall = mockTranscriptionCreate.mock.calls[0][0]
    expect(sttCall.language).toBe('fr')
  })
})
