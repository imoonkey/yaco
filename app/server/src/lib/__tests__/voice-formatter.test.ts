import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock response factory
function chatResponse(content: string) {
  return { choices: [{ message: { content } }] }
}

// Track calls to the mocked create method
let mockCreate: ReturnType<typeof vi.fn>

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      constructor() {
        // Ignore constructor args (apiKey, baseURL)
      }
      chat = {
        completions: {
          get create() { return mockCreate },
        },
      }
    },
  }
})

import { resolveFormatterModels, resolveSpeakModels, formatWithFallback, rewriteForSpeech } from '../voice-formatter'

describe('resolveFormatterModels', () => {
  beforeEach(() => {
    delete process.env.VOICE_FORMATTER_MODELS
    delete process.env.GROQ_FORMATTER_MODEL
  })

  afterEach(() => {
    delete process.env.VOICE_FORMATTER_MODELS
    delete process.env.GROQ_FORMATTER_MODEL
  })

  it('returns default model chain when no env vars set', () => {
    const models = resolveFormatterModels()
    expect(models).toEqual([
      'openai/gpt-oss-120b',
      'qwen/qwen3.6-27b',
      'openai/gpt-oss-20b',
    ])
  })

  it('parses VOICE_FORMATTER_MODELS comma-separated list', () => {
    process.env.VOICE_FORMATTER_MODELS = 'model-a, model-b'
    expect(resolveFormatterModels()).toEqual(['model-a', 'model-b'])
  })

  it('falls back to GROQ_FORMATTER_MODEL single model', () => {
    process.env.GROQ_FORMATTER_MODEL = 'openai/gpt-oss-20b'
    expect(resolveFormatterModels()).toEqual(['openai/gpt-oss-20b'])
  })

  it('prefers VOICE_FORMATTER_MODELS over GROQ_FORMATTER_MODEL', () => {
    process.env.VOICE_FORMATTER_MODELS = 'model-a'
    process.env.GROQ_FORMATTER_MODEL = 'model-b'
    expect(resolveFormatterModels()).toEqual(['model-a'])
  })

  it('ignores empty VOICE_FORMATTER_MODELS and falls to defaults', () => {
    process.env.VOICE_FORMATTER_MODELS = '  ,  '
    expect(resolveFormatterModels()).toEqual([
      'openai/gpt-oss-120b',
      'qwen/qwen3.6-27b',
      'openai/gpt-oss-20b',
    ])
  })
})

describe('resolveSpeakModels', () => {
  beforeEach(() => {
    delete process.env.VOICE_SPEAK_MODELS
  })
  afterEach(() => {
    delete process.env.VOICE_SPEAK_MODELS
  })

  it('returns a quality-first default chain when no env var set', () => {
    const models = resolveSpeakModels()
    // Quality-first: a capable instruction-follower leads (preserves language /
    // faithful paraphrase); the fast model is only a fallback.
    expect(models[0]).toBe('openai/gpt-oss-120b')
    expect(models).toContain('openai/gpt-oss-20b')
    expect(models.length).toBeGreaterThan(1)
  })

  it('parses VOICE_SPEAK_MODELS comma-separated list', () => {
    process.env.VOICE_SPEAK_MODELS = 'speak-a, speak-b'
    expect(resolveSpeakModels()).toEqual(['speak-a', 'speak-b'])
  })

  it('ignores empty VOICE_SPEAK_MODELS and falls to defaults', () => {
    process.env.VOICE_SPEAK_MODELS = '  ,  '
    expect(resolveSpeakModels()[0]).toBe('openai/gpt-oss-120b')
  })
})

describe('rewriteForSpeech', () => {
  beforeEach(() => {
    mockCreate = vi.fn()
    process.env.GROQ_API_KEY = 'test-key'
  })
  afterEach(() => {
    delete process.env.GROQ_API_KEY
    delete process.env.VOICE_SPEAK_MODELS
  })

  it('returns the cleaned spoken rewrite on success', async () => {
    mockCreate.mockResolvedValueOnce(chatResponse('Done — I refactored the parser.'))
    const out = await rewriteForSpeech('Done. Refactored the parser into 3 modules.\n| a | b |')
    expect(out).toBe('Done — I refactored the parser.')
  })

  it('drives the model with the speakify system prompt and notification envelope', async () => {
    mockCreate.mockResolvedValueOnce(chatResponse('ok'))
    await rewriteForSpeech('Your turn. Finished the parser refactor.')
    const callArgs = mockCreate.mock.calls[0][0]
    expect(callArgs.messages[0].content).toContain('text-to-speech')
    expect(callArgs.messages[1].content).toContain('<notification>')
    expect(callArgs.messages[1].content).toContain('Your turn. Finished the parser refactor.')
    // Paraphrase needs room (not a 1-2 sentence cap) but stays token-bounded (pin the contract).
    expect(callArgs.max_tokens).toBe(2048)
    expect(mockCreate.mock.calls[0][1].timeout).toBe(5000)
  })

  it('honors the speak model order (independent of the formatter chain)', async () => {
    process.env.VOICE_SPEAK_MODELS = 'speak-x,speak-y'
    mockCreate.mockResolvedValueOnce(chatResponse('spoken'))
    await rewriteForSpeech('some notice')
    expect(mockCreate.mock.calls[0][0].model).toBe('speak-x')
  })

  it('falls back to the raw text when every model fails', async () => {
    mockCreate.mockRejectedValue(new Error('all down'))
    const raw = 'Crashed (exit 1). See the log.'
    expect(await rewriteForSpeech(raw)).toBe(raw)
  })

  it('falls back to the raw text when the model returns empty', async () => {
    mockCreate.mockResolvedValue(chatResponse(''))
    const raw = 'Needs approval to run the migration.'
    expect(await rewriteForSpeech(raw)).toBe(raw)
  })
})

describe('formatWithFallback', () => {
  const SYSTEM = 'You are a formatter.'
  const MODELS = ['model-a', 'model-b', 'model-c']

  beforeEach(() => {
    mockCreate = vi.fn()
    process.env.GROQ_API_KEY = 'test-key'
  })

  afterEach(() => {
    delete process.env.GROQ_API_KEY
    delete process.env.VOICE_FORMATTER_BASE_URL
  })

  it('returns formatted result from first model on success', async () => {
    mockCreate.mockResolvedValueOnce(chatResponse('git status -sb'))
    const result = await formatWithFallback(MODELS, SYSTEM, 'git status dash sb')
    expect(result).toEqual({
      text: 'git status -sb',
      model: 'model-a',
      status: 'formatted',
    })
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('falls to second model when first fails', async () => {
    mockCreate
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce(chatResponse('docker run -d nginx'))
    const result = await formatWithFallback(MODELS, SYSTEM, 'docker run dash d nginx')
    expect(result.status).toBe('formatted')
    expect(result.model).toBe('model-b')
    expect(result.text).toBe('docker run -d nginx')
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it('falls to third model when first two fail', async () => {
    mockCreate
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce(chatResponse('ls -la'))
    const result = await formatWithFallback(MODELS, SYSTEM, 'ls dash la')
    expect(result.status).toBe('formatted')
    expect(result.model).toBe('model-c')
    expect(mockCreate).toHaveBeenCalledTimes(3)
  })

  it('returns fallback_raw when all models fail', async () => {
    mockCreate
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
    const result = await formatWithFallback(MODELS, SYSTEM, 'some raw text')
    expect(result).toEqual({
      text: 'some raw text',
      model: '',
      status: 'fallback_raw',
      warning: 'Formatting failed; showing raw transcript.',
    })
  })

  it('skips model returning empty content and tries next', async () => {
    mockCreate
      .mockResolvedValueOnce(chatResponse(''))
      .mockResolvedValueOnce(chatResponse('formatted output'))
    const result = await formatWithFallback(MODELS, SYSTEM, 'input')
    expect(result.status).toBe('formatted')
    expect(result.model).toBe('model-b')
  })

  it('passes system prompt and user text as messages', async () => {
    mockCreate.mockResolvedValueOnce(chatResponse('ok'))
    await formatWithFallback(['test-model'], SYSTEM, 'hello world')
    const callArgs = mockCreate.mock.calls[0][0]
    expect(callArgs.model).toBe('test-model')
    expect(callArgs.messages).toEqual([
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: 'Below is the raw transcript from one voice input. Rewrite it according to the system rules.\n\n<raw_transcript>\nhello world\n</raw_transcript>\n\nReturn only the rewritten text.',
      },
    ])
    expect(callArgs.temperature).toBe(0.1)
    // STT generation budget stays byte-identical after the completeWithFallback extraction.
    expect(callArgs.max_tokens).toBe(2048)
    expect(mockCreate.mock.calls[0][1].timeout).toBe(5000)
  })

  it('uses current Groq reasoning params for Qwen models', async () => {
    mockCreate.mockResolvedValueOnce(chatResponse('ok'))
    await formatWithFallback(['qwen/qwen3.6-27b'], SYSTEM, 'hello')
    const callArgs = mockCreate.mock.calls[0][0]
    expect(callArgs.reasoning_effort).toBe('none')
    expect(callArgs.reasoning_format).toBe('hidden')
  })

  it('uses hidden low-effort reasoning for gpt-oss models', async () => {
    mockCreate.mockResolvedValueOnce(chatResponse('ok'))
    await formatWithFallback(['openai/gpt-oss-120b'], SYSTEM, 'hello')
    const callArgs = mockCreate.mock.calls[0][0]
    expect(callArgs.reasoning_effort).toBe('low')
    expect(callArgs.reasoning_format).toBe('hidden')
  })

  it('cleans common formatter boilerplate wrappers', async () => {
    mockCreate.mockResolvedValueOnce(chatResponse('Here is the cleaned text: "Hello world."'))
    const result = await formatWithFallback(['test-model'], SYSTEM, 'hello world')
    expect(result.text).toBe('Hello world.')
  })

  it('cleans Chinese formatter boilerplate wrappers', async () => {
    mockCreate.mockResolvedValueOnce(chatResponse('整理如下：\n你好。'))
    const result = await formatWithFallback(['test-model'], SYSTEM, '你好')
    expect(result.text).toBe('你好。')
  })

  it('strips an outer markdown fence from model output', async () => {
    mockCreate.mockResolvedValueOnce(chatResponse('```text\n1. Fix login.\n2. Add tests.\n```'))
    const result = await formatWithFallback(['test-model'], SYSTEM, 'one fix login two add tests')
    expect(result.text).toBe('1. Fix login.\n2. Add tests.')
  })
})

// ---------------------------------------------------------------------------
// Golden test cases: define input transcript → expected displayText + status
// These verify the pipeline contract from voice-formatter's perspective.
// The LLM output is mocked — each case represents the expected formatting.
// ---------------------------------------------------------------------------
describe('golden test cases', () => {
  beforeEach(() => {
    mockCreate = vi.fn()
    process.env.GROQ_API_KEY = 'test-key'
  })

  afterEach(() => {
    delete process.env.GROQ_API_KEY
  })

  const SYSTEM = 'system prompt'

  const goldenCases: Array<{
    name: string
    input: string
    expectedOutput: string
    expectedStatus: 'formatted' | 'fallback_raw'
  }> = [
    {
      name: '1. Terminal command dictation',
      input: 'um git commit dash m fix the login bug',
      expectedOutput: 'git commit -m "fix the login bug"',
      expectedStatus: 'formatted',
    },
    {
      name: '2. Terminal NL prompt to AI agent',
      input: 'tell Claude to um refactor the authentication module and add unit tests for the login flow',
      expectedOutput: 'Tell Claude to refactor the authentication module and add unit tests for the login flow.',
      expectedStatus: 'formatted',
    },
    {
      name: '3. Editor code dictation',
      input: 'const result equals await fetch open paren URL close paren',
      expectedOutput: 'const result = await fetch(URL)',
      expectedStatus: 'formatted',
    },
    {
      name: '4. Markdown prose',
      input: 'add a heading saying API reference and then a paragraph about authentication',
      expectedOutput: '# API Reference\n\nAuthentication is required for all endpoints.',
      expectedStatus: 'formatted',
    },
    {
      name: '5. Chinese prose (中文)',
      input: '帮我看一下这个 error 是什么原因然后修一下',
      expectedOutput: '帮我看一下这个 error 是什么原因，然后修一下。',
      expectedStatus: 'formatted',
    },
    {
      name: '6. Mixed Chinese+English technical (中英混合)',
      input: '这个 function 需要一个 string parameter 然后那个就是返回 boolean',
      expectedOutput: '这个 function 需要一个 string parameter，然后返回 boolean。',
      expectedStatus: 'formatted',
    },
    {
      name: '7. Filler/self-correction cleanup',
      input: 'we need to um add validation to the form like uh the email field should be required and also no wait not just required but also um at least three characters',
      expectedOutput: 'We need to add validation to the form. The email field should be required and at least 3 characters.',
      expectedStatus: 'formatted',
    },
    {
      name: '8. Fallback on formatter failure',
      input: 'some dictated text that could not be formatted',
      expectedOutput: 'some dictated text that could not be formatted',
      expectedStatus: 'fallback_raw',
    },
    {
      name: '9. Mixed Chinese+English CLI with self-correction (中英混合命令)',
      input: '把文件 copy 到那个 tilde slash backup 不对 tilde slash archive 然后 ls dash la',
      expectedOutput: '把文件 copy 到 ~/archive && ls -la',
      expectedStatus: 'formatted',
    },
    {
      name: '10. Docker command with spoken numbers',
      input: 'docker run uh dash d dash p eight thousand colon eighty nginx latest',
      expectedOutput: 'docker run -d -p 8000:80 nginx:latest',
      expectedStatus: 'formatted',
    },
  ]

  for (const tc of goldenCases) {
    it(tc.name, async () => {
      if (tc.expectedStatus === 'fallback_raw') {
        // All models fail → raw fallback
        mockCreate.mockRejectedValue(new Error('all models down'))
      } else {
        mockCreate.mockResolvedValueOnce(chatResponse(tc.expectedOutput))
      }

      const result = await formatWithFallback(['model-a'], SYSTEM, tc.input)
      expect(result.text).toBe(tc.expectedOutput)
      expect(result.status).toBe(tc.expectedStatus)
    })
  }
})
