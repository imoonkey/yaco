import { isIP } from 'node:net'

// Hostnames trusted with no configuration. A leading dot means "this domain and
// everything under it", so `.local` covers every mDNS name.
const DEFAULT_ALLOWED_HOSTNAMES = ['localhost', '::1', '.local']

const parseList = (value: string | undefined): string[] =>
  (value ?? '').split(',').map(s => s.trim()).filter(Boolean)

// A leading-dot entry needs a real domain after the dot. A bare `.` would
// otherwise match every hostname a browser writes with the DNS root dot
// (`evil.example.`), turning one stray character into an open allowlist.
const isUsableEntry = (entry: string): boolean =>
  !entry.startsWith('.') || (entry.length > 1 && !entry.includes('..'))

// `new URL('http://[::1]:3001').hostname` is `'[::1]'`; compare on the bare address.
const normalizeHostname = (hostname: string): string =>
  hostname.replace(/^\[|\]$/g, '').toLowerCase()

function isPrivateIpv4(hostname: string): boolean {
  if (isIP(hostname) !== 4) return false
  if (hostname.startsWith('127.')) return true

  const [a, b] = hostname.split('.').map(Number)
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
}

/**
 * Builds the `Origin` check used by both the HTTP CORS middleware and the
 * WebSocket upgrade handler.
 *
 * - `WORKFLOW_CORS_ORIGINS` — comma-separated exact origins. When set it is the
 *   entire allowlist; nothing else is trusted.
 * - `YACO_ALLOWED_HOSTNAMES` — comma-separated hostnames trusted in addition to
 *   loopback and private-LAN addresses, for reaching the app over a LAN or
 *   tailnet name. A leading dot allows the subdomains of a domain
 *   (`.example.ts.net`), the same syntax Vite's `server.allowedHosts` takes, so
 *   one value configures both processes. Vite additionally admits the bare
 *   domain; this guard does not, because the shipped `.local` default would
 *   then trust a single-label `local` origin that nobody configured.
 */
export function createOriginGuard(env: NodeJS.ProcessEnv): (origin?: string | null) => boolean {
  const explicitOrigins = parseList(env.WORKFLOW_CORS_ORIGINS)

  const configured = parseList(env.YACO_ALLOWED_HOSTNAMES).map(h => h.toLowerCase())
  const rejected = configured.filter(entry => !isUsableEntry(entry))
  if (rejected.length > 0) {
    console.warn(`YACO_ALLOWED_HOSTNAMES: ignoring unusable ${rejected.join(', ')}`)
  }

  const allowedHostnames = [
    ...DEFAULT_ALLOWED_HOSTNAMES,
    ...configured.filter(isUsableEntry),
  ]

  const isAllowedHostname = (hostname: string): boolean =>
    allowedHostnames.some(allowed =>
      allowed.startsWith('.') ? hostname.endsWith(allowed) : hostname === allowed)

  return (origin?: string | null): boolean => {
    if (!origin) return true

    try {
      const url = new URL(origin)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false

      if (explicitOrigins.length > 0) return explicitOrigins.includes(origin)

      const hostname = normalizeHostname(url.hostname)
      return isAllowedHostname(hostname) || isPrivateIpv4(hostname)
    } catch {
      return false
    }
  }
}
