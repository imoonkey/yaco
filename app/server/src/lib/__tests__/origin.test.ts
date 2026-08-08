import { describe, it, expect } from 'vitest'
import { createOriginGuard } from '../origin'

const guard = (env: NodeJS.ProcessEnv = {}) => createOriginGuard(env)

describe('createOriginGuard — shipped defaults', () => {
  const isAllowed = guard()

  it('allows a missing Origin header (same-origin / non-browser client)', () => {
    expect(isAllowed(undefined)).toBe(true)
    expect(isAllowed(null)).toBe(true)
    expect(isAllowed('')).toBe(true)
  })

  it('allows loopback', () => {
    expect(isAllowed('http://localhost:5173')).toBe(true)
    expect(isAllowed('http://127.0.0.1:3001')).toBe(true)
    expect(isAllowed('http://[::1]:3001')).toBe(true)
  })

  it('allows mDNS and private-LAN addresses', () => {
    expect(isAllowed('http://desktop.local:5173')).toBe(true)
    expect(isAllowed('http://192.168.1.5:3001')).toBe(true)
    expect(isAllowed('http://10.0.0.9:3001')).toBe(true)
    expect(isAllowed('http://172.20.0.1:3001')).toBe(true)
    expect(isAllowed('http://169.254.1.1:3001')).toBe(true)
  })

  it('rejects public addresses and unconfigured hostnames', () => {
    expect(isAllowed('https://evil.example.com')).toBe(false)
    expect(isAllowed('http://8.8.8.8')).toBe(false)
    expect(isAllowed('http://172.32.0.1:3001')).toBe(false)
    expect(isAllowed('http://desktop.example.ts.net')).toBe(false)
    expect(isAllowed('http://desktop')).toBe(false)
  })

  it('rejects non-http schemes and unparseable origins', () => {
    expect(isAllowed('file:///etc/passwd')).toBe(false)
    expect(isAllowed('ftp://localhost')).toBe(false)
    expect(isAllowed('not a url')).toBe(false)
  })

  it('carries no hostname beyond localhost, ::1 and .local', () => {
    const shipped = ['http://localhost', 'http://[::1]', 'http://anything.local']
    for (const origin of shipped) expect(isAllowed(origin)).toBe(true)
    expect(isAllowed('http://laptop')).toBe(false)
  })
})

describe('createOriginGuard — YACO_ALLOWED_HOSTNAMES', () => {
  it('adds exact hostnames', () => {
    const isAllowed = guard({ YACO_ALLOWED_HOSTNAMES: 'desktop, laptop' })
    expect(isAllowed('http://desktop:5173')).toBe(true)
    expect(isAllowed('https://laptop')).toBe(true)
    expect(isAllowed('http://phone')).toBe(false)
  })

  it('treats a leading dot as the domain and its subdomains, as Vite does', () => {
    const isAllowed = guard({ YACO_ALLOWED_HOSTNAMES: '.example.ts.net' })
    expect(isAllowed('https://desktop.example.ts.net')).toBe(true)
    expect(isAllowed('https://laptop.example.ts.net:3001')).toBe(true)
    expect(isAllowed('https://example.ts.net')).toBe(true)
    expect(isAllowed('https://notexample.ts.net')).toBe(false)
  })

  it('matches case-insensitively', () => {
    const isAllowed = guard({ YACO_ALLOWED_HOSTNAMES: 'Desktop,.Example.TS.net' })
    expect(isAllowed('http://DESKTOP')).toBe(true)
    expect(isAllowed('https://Laptop.Example.TS.net')).toBe(true)
  })

  it('ignores blank entries and keeps the defaults', () => {
    const isAllowed = guard({ YACO_ALLOWED_HOSTNAMES: ' , desktop , ' })
    expect(isAllowed('http://desktop')).toBe(true)
    expect(isAllowed('http://localhost:5173')).toBe(true)
  })
})

describe('createOriginGuard — adversarial origins', () => {
  // A leading-dot entry with no domain after it would match every hostname a
  // browser writes with the DNS root dot, so it must be dropped, not honored.
  it.each(['.', '..', '..example.ts.net'])('ignores the unusable entry %j', entry => {
    const isAllowed = guard({ YACO_ALLOWED_HOSTNAMES: entry })
    expect(isAllowed('http://evil.example.')).toBe(false)
    expect(isAllowed('http://evil.example')).toBe(false)
    expect(isAllowed('http://localhost:5173')).toBe(true)
  })

  it('does not let a root-dot hostname pass as an allowed name', () => {
    const isAllowed = guard({ YACO_ALLOWED_HOSTNAMES: 'desktop,.example.ts.net' })
    expect(isAllowed('http://desktop.')).toBe(false)
    expect(isAllowed('http://desktop.example.ts.net.')).toBe(false)
    expect(isAllowed('http://localhost.')).toBe(false)
  })

  it('judges the host, not userinfo dressed up to look like one', () => {
    const isAllowed = guard({ YACO_ALLOWED_HOSTNAMES: 'desktop' })
    expect(isAllowed('http://localhost@evil.example.com')).toBe(false)
    expect(isAllowed('http://desktop:pw@evil.example.com')).toBe(false)
    expect(isAllowed('http://evil.example.com#desktop')).toBe(false)
  })

  it('compares punycode against punycode', () => {
    const isAllowed = guard({ YACO_ALLOWED_HOSTNAMES: 'xn--bcher-kva.example' })
    expect(isAllowed('http://bücher.example')).toBe(true)
    expect(isAllowed('http://bucher.example')).toBe(false)
  })

  it('rejects non-loopback IPv6, including IPv4-mapped loopback', () => {
    const isAllowed = guard()
    expect(isAllowed('http://[::ffff:127.0.0.1]')).toBe(false)
    expect(isAllowed('http://[2001:db8::1]')).toBe(false)
    expect(isAllowed('http://[fe80::1]')).toBe(false)
  })
})

describe('createOriginGuard — WORKFLOW_CORS_ORIGINS', () => {
  it('replaces the whole allowlist when set', () => {
    const isAllowed = guard({ WORKFLOW_CORS_ORIGINS: 'https://desktop.example.ts.net' })
    expect(isAllowed('https://desktop.example.ts.net')).toBe(true)
    expect(isAllowed('http://localhost:5173')).toBe(false)
    expect(isAllowed('http://192.168.1.5')).toBe(false)
  })

  it('matches the origin exactly, port included', () => {
    const isAllowed = guard({ WORKFLOW_CORS_ORIGINS: 'http://localhost:5173' })
    expect(isAllowed('http://localhost:5173')).toBe(true)
    expect(isAllowed('http://localhost:3001')).toBe(false)
  })

  it('wins over YACO_ALLOWED_HOSTNAMES', () => {
    const isAllowed = guard({
      WORKFLOW_CORS_ORIGINS: 'http://localhost:5173',
      YACO_ALLOWED_HOSTNAMES: 'desktop',
    })
    expect(isAllowed('http://desktop')).toBe(false)
  })
})
