import type { Context } from 'hono'

type StatusCode = 400 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503

export function fail(c: Context, status: StatusCode, error: string, extra?: Record<string, unknown>) {
  return c.json({ error, ...extra }, status)
}
