import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CodexTranscribeError,
  inspectCodexTranscribe,
  transcribeCodex,
} from '../src/index.js'

const ACCESS_TOKEN = 'header.payload.signature'
const ACCOUNT_ID = 'account-from-auth'
const CLAIM = 'https://api.openai.com/auth.chatgpt_account_id'
const ENDPOINT = 'https://chatgpt.com/backend-api/transcribe'
const REFRESH_TOKEN = 'must-never-be-read-or-sent'

function jwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `header.${encoded}.signature`
}

function futureToken(extra: Record<string, unknown> = {}): string {
  return jwt({ exp: Math.floor(Date.now() / 1000) + 3_600, ...extra })
}

function auth(
  accessToken: unknown = futureToken({ [CLAIM]: 'account-from-jwt' }),
  accountId: unknown = ACCOUNT_ID,
): Record<string, unknown> {
  return {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: accessToken,
      account_id: accountId,
      refresh_token: REFRESH_TOKEN,
    },
  }
}

async function writeAuth(
  home: string,
  value: unknown,
  raw = false,
): Promise<void> {
  await mkdir(home, { recursive: true })
  await writeFile(
    join(home, 'auth.json'),
    raw ? String(value) : JSON.stringify(value),
    'utf8',
  )
}

function response(body: string, status = 200, headers?: HeadersInit): Response {
  return new Response(body, { status, headers })
}

async function expectError(
  promise: Promise<unknown>,
  code: CodexTranscribeError['code'],
): Promise<CodexTranscribeError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(CodexTranscribeError)
    expect(error).toMatchObject({ code })
    return error as CodexTranscribeError
  }
  throw new Error(`Expected CodexTranscribeError with code ${code}`)
}

describe.sequential('yaco-codex-transcribe', () => {
  let root: string
  let codexHome: string
  let defaultHome: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-transcribe-'))
    codexHome = join(root, 'configured-codex-home')
    defaultHome = join(root, 'user-home')
    vi.stubEnv('CODEX_HOME', codexHome)
    vi.stubEnv('HOME', defaultHome)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('inspectCodexTranscribe', () => {
    it('reports missing auth', async () => {
      await expect(inspectCodexTranscribe()).resolves.toEqual({
        available: false,
        reason: 'missing_auth',
      })
    })

    it('uses CODEX_HOME before the default ~/.codex directory', async () => {
      await writeAuth(join(defaultHome, '.codex'), auth())
      await expect(inspectCodexTranscribe()).resolves.toEqual({
        available: false,
        reason: 'missing_auth',
      })

      await writeAuth(codexHome, auth())
      await expect(inspectCodexTranscribe()).resolves.toEqual({ available: true })
    })

    it('uses ~/.codex when CODEX_HOME is unset', async () => {
      vi.stubEnv('CODEX_HOME', '')
      await writeAuth(join(defaultHome, '.codex'), auth())
      await expect(inspectCodexTranscribe()).resolves.toEqual({ available: true })
    })

    it('reports unsupported auth modes', async () => {
      await writeAuth(codexHome, { ...auth(), auth_mode: 'apikey' })
      await expect(inspectCodexTranscribe()).resolves.toEqual({
        available: false,
        reason: 'unsupported_auth',
      })
    })

    it.each([
      ['malformed JSON', '{', true],
      ['non-object JSON', null, false],
      ['missing tokens', { auth_mode: 'chatgpt' }, false],
      ['empty access token', auth(''), false],
      ['non-string access token', auth(42), false],
      ['malformed JWT', auth(ACCESS_TOKEN), false],
      ['missing expiry', auth(jwt({ [CLAIM]: ACCOUNT_ID })), false],
      ['non-numeric expiry', auth(jwt({ exp: 'later', [CLAIM]: ACCOUNT_ID })), false],
      ['missing account id', auth(futureToken(), ''), false],
    ])('reports invalid auth for %s', async (_name, value, raw) => {
      await writeAuth(codexHome, value, raw)
      await expect(inspectCodexTranscribe()).resolves.toEqual({
        available: false,
        reason: 'invalid_auth',
      })
    })

    it('reports an expired JWT', async () => {
      await writeAuth(
        codexHome,
        auth(jwt({ exp: Math.floor(Date.now() / 1000) - 1, [CLAIM]: ACCOUNT_ID })),
      )
      await expect(inspectCodexTranscribe()).resolves.toEqual({
        available: false,
        reason: 'expired_auth',
      })
    })

    it('reports non-missing auth read failures as invalid auth', async () => {
      await mkdir(join(codexHome, 'auth.json'), { recursive: true })
      await expect(inspectCodexTranscribe()).resolves.toEqual({
        available: false,
        reason: 'invalid_auth',
      })
    })

    it('re-reads auth on every inspection', async () => {
      await expect(inspectCodexTranscribe()).resolves.toMatchObject({
        available: false,
      })
      await writeAuth(codexHome, auth())
      await expect(inspectCodexTranscribe()).resolves.toEqual({ available: true })
    })
  })

  describe('transcribeCodex', () => {
    beforeEach(async () => {
      await writeAuth(codexHome, auth())
    })

    it('posts the audio using the fixed Codex Desktop contract', async () => {
      const token = futureToken({ [CLAIM]: 'account-from-jwt' })
      await writeAuth(codexHome, auth(token))
      const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({ text: 'hello world' }),
      )
      vi.stubGlobal('fetch', fetchStub)
      const signal = new AbortController().signal
      const audio = Uint8Array.from([0, 1, 2, 255])

      await expect(
        transcribeCodex({
          audio,
          filename: 'take.webm',
          mimeType: 'audio/webm;codecs=opus',
          language: 'zh',
          signal,
        }),
      ).resolves.toBe('hello world')

      expect(fetchStub).toHaveBeenCalledOnce()
      const [url, init] = fetchStub.mock.calls[0]!
      expect(url).toBe(ENDPOINT)
      expect(init).toMatchObject({ method: 'POST', signal })
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe(`Bearer ${token}`)
      expect(headers.get('chatgpt-account-id')).toBe(ACCOUNT_ID)
      expect(headers.get('originator')).toBe('Codex Desktop')
      expect(headers.get('user-agent')).toMatch(
        /^Codex Desktop\/0\.0\.0 \([a-z0-9_-]+; [a-z0-9_-]+\)$/,
      )
      expect(headers.get('accept')).toBe('application/json')
      expect(headers.has('content-type')).toBe(false)
      expect([...headers.keys()].sort()).toEqual([
        'accept',
        'authorization',
        'chatgpt-account-id',
        'originator',
        'user-agent',
      ])
      expect(JSON.stringify([...headers.entries()])).not.toContain(REFRESH_TOKEN)

      expect(init?.body).toBeInstanceOf(FormData)
      const form = init?.body as FormData
      const file = form.get('file')
      expect(file).toBeInstanceOf(File)
      expect(file).toMatchObject({
        name: 'take.webm',
        type: 'audio/webm;codecs=opus',
      })
      expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(audio)
      expect(form.get('language')).toBe('zh')
      expect([...form.keys()]).toEqual(['file', 'language'])
      expect(
        JSON.stringify(
          [...form.values()].map((value) =>
            typeof value === 'string'
              ? value
              : { name: value.name, size: value.size, type: value.type },
          ),
        ),
      ).not.toContain(REFRESH_TOKEN)
    })

    it('uses the JWT account claim and omits an absent language', async () => {
      const token = futureToken({ [CLAIM]: 'account-from-jwt' })
      await writeAuth(codexHome, auth(token, ''))
      const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({ text: '' }),
      )
      vi.stubGlobal('fetch', fetchStub)

      await expect(
        transcribeCodex({
          audio: new Uint8Array(),
          filename: 'take.m4a',
          mimeType: 'audio/mp4',
        }),
      ).resolves.toBe('')

      const init = fetchStub.mock.calls[0]![1]
      expect(new Headers(init?.headers).get('chatgpt-account-id')).toBe(
        'account-from-jwt',
      )
      expect((init?.body as FormData).has('language')).toBe(false)
    })

    it('re-reads auth before every transcription', async () => {
      const firstToken = futureToken({ [CLAIM]: ACCOUNT_ID })
      const secondToken = futureToken({ [CLAIM]: ACCOUNT_ID, marker: 'second' })
      await writeAuth(codexHome, auth(firstToken))
      const fetchStub = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => Response.json({ text: 'ok' }))
      vi.stubGlobal('fetch', fetchStub)

      await transcribeCodex({
        audio: new Uint8Array(),
        filename: 'one.webm',
        mimeType: 'audio/webm',
      })
      await writeAuth(codexHome, auth(secondToken))
      await transcribeCodex({
        audio: new Uint8Array(),
        filename: 'two.webm',
        mimeType: 'audio/webm',
      })

      expect(
        new Headers(fetchStub.mock.calls[0]![1]?.headers).get('authorization'),
      ).toBe(`Bearer ${firstToken}`)
      expect(
        new Headers(fetchStub.mock.calls[1]![1]?.headers).get('authorization'),
      ).toBe(`Bearer ${secondToken}`)
    })

    it.each([
      [401, 'expired_auth'],
      [403, 'forbidden'],
      [500, 'upstream'],
      [503, 'upstream'],
    ] as const)('maps HTTP %i to %s', async (status, code) => {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>().mockResolvedValue(
          response('secret upstream body', status),
        ),
      )
      const error = await expectError(
        transcribeCodex({
          audio: new Uint8Array(),
          filename: 'take.webm',
          mimeType: 'audio/webm',
        }),
        code,
      )
      expect(error.message).not.toContain('secret upstream body')
    })

    it('preserves Retry-After on HTTP 429', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>().mockResolvedValue(
          response('limited', 429, { 'retry-after': '17' }),
        ),
      )
      const error = await expectError(
        transcribeCodex({
          audio: new Uint8Array(),
          filename: 'take.webm',
          mimeType: 'audio/webm',
        }),
        'rate_limited',
      )
      expect(error.retryAfter).toBe('17')
    })

    it('allows HTTP 429 without Retry-After', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>().mockResolvedValue(response('limited', 429)),
      )
      const error = await expectError(
        transcribeCodex({
          audio: new Uint8Array(),
          filename: 'take.webm',
          mimeType: 'audio/webm',
        }),
        'rate_limited',
      )
      expect(error.retryAfter).toBeUndefined()
    })

    it.each([
      ['invalid JSON', response('not JSON')],
      ['null', Response.json(null)],
      ['array', Response.json([{ text: 'wrong container' }])],
      ['missing text', Response.json({ transcript: 'wrong field' })],
      ['non-string text', Response.json({ text: 42 })],
    ])('rejects a successful response with %s', async (_name, upstream) => {
      vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(upstream))
      await expectError(
        transcribeCodex({
          audio: new Uint8Array(),
          filename: 'take.webm',
          mimeType: 'audio/webm',
        }),
        'upstream',
      )
    })

    it.each([
      ['missing auth', undefined, 'not_configured'],
      [
        'expired auth',
        auth(jwt({ exp: 0, [CLAIM]: ACCOUNT_ID })),
        'expired_auth',
      ],
    ] as const)('maps %s before calling fetch', async (_name, value, code) => {
      if (value === undefined) {
        vi.stubEnv('CODEX_HOME', join(root, 'empty-codex-home'))
      } else {
        await writeAuth(codexHome, value)
      }
      const fetchStub = vi.fn<typeof fetch>()
      vi.stubGlobal('fetch', fetchStub)
      await expectError(
        transcribeCodex({
          audio: new Uint8Array(),
          filename: 'take.webm',
          mimeType: 'audio/webm',
        }),
        code,
      )
      expect(fetchStub).not.toHaveBeenCalled()
    })

    it('wraps network failures and preserves their cause', async () => {
      const cause = new Error('socket failed')
      vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(cause))
      const error = await expectError(
        transcribeCodex({
          audio: new Uint8Array(),
          filename: 'take.webm',
          mimeType: 'audio/webm',
        }),
        'network',
      )
      expect(error.cause).toBe(cause)
    })

    it('wraps AbortError as network and preserves its cause', async () => {
      const cause = new DOMException('This operation was aborted', 'AbortError')
      vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(cause))
      const error = await expectError(
        transcribeCodex({
          audio: new Uint8Array(),
          filename: 'take.webm',
          mimeType: 'audio/webm',
        }),
        'network',
      )
      expect(error.cause).toBe(cause)
    })

    it('does not log credentials, audio, transcripts, or upstream bodies', async () => {
      const logSpies = ['debug', 'error', 'info', 'log', 'warn'].map((method) =>
        vi.spyOn(console, method as 'log').mockImplementation(() => undefined),
      )
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>()
          .mockResolvedValueOnce(Response.json({ text: 'private transcript' }))
          .mockResolvedValueOnce(response('private upstream body', 403)),
      )

      await transcribeCodex({
        audio: Uint8Array.from([19, 87, 42]),
        filename: 'private.webm',
        mimeType: 'audio/webm',
      })
      const error = await expectError(
        transcribeCodex({
          audio: Uint8Array.from([19, 87, 42]),
          filename: 'private.webm',
          mimeType: 'audio/webm',
        }),
        'forbidden',
      )

      expect(logSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true)
      expect(error.message).not.toContain('private upstream body')
      expect(error.message).not.toContain('private transcript')
      expect(String(error.cause)).not.toContain('private upstream body')
      expect(String(error.cause)).not.toContain('private transcript')
      expect(error.message).not.toContain(REFRESH_TOKEN)
      expect(String(error.cause)).not.toContain(REFRESH_TOKEN)
    })
  })
})
