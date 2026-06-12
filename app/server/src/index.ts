import 'dotenv/config'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'http'
import { isIP } from 'node:net'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, stat } from 'node:fs/promises'
import { projectRoutes } from './routes/projects.js'
import { progressRoutes } from './routes/progress.js'
import { sessionRoutes } from './routes/sessions.js'
import { fileRoutes } from './routes/files.js'
import { gitRoutes } from './routes/git.js'
import { notificationRoutes } from './routes/notifications.js'
import { uiStateRoutes } from './routes/ui-state.js'
import { attentionRoutes } from './routes/attention.js'
import { browseRoutes } from './routes/browse.js'
import { voiceRoutes } from './routes/voice.js'
import { searchRoutes } from './routes/search.js'
import { autocompleteRoutes } from './routes/autocomplete.js'
import { taskRoutes } from './routes/tasks.js'
import { wechatRoutes } from './routes/wechat.js'
import { whatsappRoutes } from './routes/whatsapp.js'
import { ensureYacoHome, loadProjects } from './lib/projects.js'
import { pickEncoding, appendVary } from './lib/static-encoding.js'
import { startSessionReconciler, stopSessionReconciler } from './lib/session-reconciler.js'
import { startProjectWatchers, stopProjectWatchers } from './lib/project-watcher.js'
import { startAttentionEngine, stopAttentionEngine } from './lib/attention-runtime.js'
import { emitRefresh } from './lib/notify.js'
import { initWeChat, shutdownWeChat } from './lib/wechat/index.js'
import { initWhatsApp, shutdownWhatsApp } from './lib/whatsapp/index.js'
import {
  attachSession,
  pasteTextToSession,
  reconcileShellSessionExit,
  releaseSession,
  setShellSessionChangeCallback,
  TerminalTextPasteError,
} from './lib/terminal.js'
import { writeImageToClipboard, ClipboardWriteError } from './lib/clipboard-write.js'
import { PtyCapacityError, sweep, PTY_SWEEP_INTERVAL_MS } from './lib/pty-capacity.js'
import { SESSION_NAME_RE } from './lib/session-names.js'
import { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS, MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS, WS_PING_INTERVAL_MS } from './lib/constants.js'
import {
  TerminalOscColorResponder,
  parseTerminalPalette,
  shouldAnswerTerminalOscColor,
  terminalPaletteFromSearchParams,
  type TerminalPalette,
} from './lib/terminal-osc.js'
import type { IPty } from 'node-pty'

const EXPLICIT_ALLOWED_ORIGINS = (process.env.WORKFLOW_CORS_ORIGINS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const DEFAULT_ALLOWED_HOSTNAMES = new Set([
  'localhost',
  '::1',
  'laptop',
  'laptop.tailnet-example.ts.net',
  'desktop',
  'desktop.tailnet-example.ts.net',
])
const SERVER_SRC_DIR = dirname(fileURLToPath(import.meta.url))
// Built UI to serve. Defaults to the canonical app/ui/dist; e2e overrides it via
// YACO_UI_DIST so an isolated run serves its own build without clobbering dist.
const UI_DIST_DIR = process.env.YACO_UI_DIST
  ? resolve(process.env.YACO_UI_DIST)
  : resolve(SERVER_SRC_DIR, '../../ui/dist')
const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
])

function isPrivateHostname(hostname: string): boolean {
  if (DEFAULT_ALLOWED_HOSTNAMES.has(hostname) || hostname.endsWith('.local')) {
    return true
  }

  const ipVersion = isIP(hostname)
  if (ipVersion === 0) return false
  if (ipVersion === 6) return hostname === '::1'

  if (hostname.startsWith('127.')) return true

  const [a, b] = hostname.split('.').map(Number)
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
}

function isAllowedOrigin(origin?: string | null): boolean {
  if (!origin) return true

  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false

    if (EXPLICIT_ALLOWED_ORIGINS.length > 0) {
      return EXPLICIT_ALLOWED_ORIGINS.includes(origin)
    }

    return isPrivateHostname(url.hostname)
  } catch {
    return false
  }
}

function resolveUiPath(pathname: string): string | null {
  try {
    const decoded = decodeURIComponent(pathname)
    const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
    const resolved = resolve(UI_DIST_DIR, relativePath)
    const rootPrefix = `${UI_DIST_DIR}${sep}`
    if (resolved !== UI_DIST_DIR && !resolved.startsWith(rootPrefix)) return null
    return resolved
  } catch {
    return null
  }
}

function getContentType(filePath: string): string {
  return MIME_TYPES.get(extname(filePath)) ?? 'application/octet-stream'
}

async function serveUiFile(
  pathname: string,
  acceptEncoding?: string | null,
): Promise<Response | null> {
  const filePath = resolveUiPath(pathname)
  if (!filePath) return new Response('Not found', { status: 404 })

  // Reject direct requests for precompressed siblings. Check the RESOLVED
  // path (post-decode), not the raw URL — `/assets/foo.js%2ebr` would
  // otherwise decode to `foo.js.br` and bypass this guard.
  if (filePath.endsWith('.br') || filePath.endsWith('.gz')) {
    return new Response('Not found', { status: 404 })
  }

  const [brExists, gzExists] = await Promise.all([
    stat(`${filePath}.br`).then(() => true, () => false),
    stat(`${filePath}.gz`).then(() => true, () => false),
  ])

  let picked = pickEncoding(acceptEncoding, { br: brExists, gz: gzExists })
  const sourcePath =
    picked === 'br' ? `${filePath}.br` : picked === 'gzip' ? `${filePath}.gz` : filePath

  let body: Buffer
  try {
    body = await readFile(sourcePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // If a compressed sibling vanished between stat and read (e.g. a live
    // `npm run build` rebuilt dist mid-request), fall back to the canonical
    // file. ENOENT on the canonical file is a genuine miss.
    if (sourcePath === filePath) return null
    try {
      body = await readFile(filePath)
      picked = 'identity'
    } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw fallbackError
    }
  }

  // Content-Type ALWAYS from the BASE filename — `.br`/`.gz` are
  // content-encoding markers, not media types.
  const headers = new Headers({
    'Content-Type': getContentType(filePath),
    'Cache-Control': pathname.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  })
  if (picked !== 'identity') {
    headers.set('Content-Encoding', picked === 'br' ? 'br' : 'gzip')
  }
  appendVary(headers, 'Accept-Encoding')
  // Content-Length is derived by @hono/node-server from the Uint8Array
  // body — do not set it manually.
  return new Response(body, { headers })
}

async function serveUiApp(
  pathname: string,
  acceptEncoding?: string | null,
): Promise<Response> {
  const direct = await serveUiFile(pathname, acceptEncoding)
  if (direct) return direct

  if (pathname !== '/' && extname(pathname)) {
    return new Response('Not found', { status: 404 })
  }

  const indexFile = await serveUiFile('/', acceptEncoding)
  if (indexFile) return indexFile

  return new Response(
    'YACO UI build not found. Run `npm run build` from the repo root before using the backend as the app entrypoint.',
    {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    },
  )
}

const app = new Hono()

app.use('*', cors({
  origin: (origin) => isAllowedOrigin(origin) ? origin : undefined,
}))

app.route('/api/projects', projectRoutes)
app.route('/api/progress', progressRoutes)
app.route('/api/sessions', sessionRoutes)
app.route('/api/files', fileRoutes)
app.route('/api/git', gitRoutes)
app.route('/api/notifications', notificationRoutes)
app.route('/api/ui-state', uiStateRoutes)
app.route('/api/attention', attentionRoutes)
app.route('/api/browse', browseRoutes)
app.route('/api/voice', voiceRoutes)
app.route('/api/search', searchRoutes)
app.route('/api/autocomplete', autocompleteRoutes)
app.route('/api/tasks', taskRoutes)
app.route('/api/wechat', wechatRoutes)
app.route('/api/whatsapp', whatsappRoutes)

app.get('/api/health', (c) => c.json({ ok: true }))
app.get('*', async (c) => serveUiApp(c.req.path, c.req.header('accept-encoding')))

const port = Number(process.env.WORKFLOW_PORT ?? 3001)
let runtimeStarted = false

async function startRuntime(): Promise<void> {
  if (runtimeStarted) return
  runtimeStarted = true

  const projects = await loadProjects()
  startSessionReconciler()
  await startProjectWatchers(projects)
  // Attention engine (Facet B): boot reconciliation + change-driven edges.
  // Started after the watchers so their notify hooks reach a live engine.
  await startAttentionEngine()
  setShellSessionChangeCallback(() => emitRefresh('sessions'))

  if (process.env.WECHAT_ENABLED === '1') {
    await initWeChat()
  }

  if (process.env.WHATSAPP_ENABLED === '1') {
    // Don't await — WhatsApp init can take 10-30s while puppeteer launches Chrome
    // and the LocalAuth session reconnects. Fire-and-forget so the HTTP server
    // becomes available immediately; status route reports progress.
    void initWhatsApp()
  }
}

// Bootstrap the YACO runtime dir before binding the HTTP port.
// Top-level await is supported (ES2022 + ESNext modules).
try {
  await ensureYacoHome()
} catch (err) {
  console.error('[startup] bootstrap failed:', err)
  process.exit(1)
}

// Start HTTP server
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`YACO server running on http://localhost:${port}`)
  void startRuntime().catch((err) => {
    console.error('[startup] runtime init failed:', err)
    cleanupTerminalResources()
    server.close(() => process.exit(1))
    setTimeout(() => process.exit(1), 1000).unref()
  })
})

server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(`[startup] failed to listen on port ${port}:`, err)
  process.exit(1)
})

// WebSocket server on the same HTTP server
const wss = new WebSocketServer({ noServer: true })
type PtySubscription = ReturnType<IPty['onData']>

type TerminalConnection = {
  sessionName: string
  attached: ReturnType<typeof attachSession>
  dataSub: PtySubscription
  exitSub: PtySubscription
  alive: boolean
  cleaned: boolean
}

const connections = new Map<WebSocket, TerminalConnection>()
let pingInterval: ReturnType<typeof setInterval> | null = null
let sweepInterval: ReturnType<typeof setInterval> | null = null

function cleanupConnection(ws: WebSocket): void {
  const conn = connections.get(ws)
  if (!conn || conn.cleaned) return
  conn.cleaned = true
  conn.dataSub.dispose()
  conn.exitSub.dispose()
  releaseSession(conn.sessionName, conn.attached)
  connections.delete(ws)
  console.log(`[ws] terminal detached: ${conn.sessionName}`)
}

// Ping all connected WebSocket clients periodically to detect dead connections.
// Without this, dead connections linger for ~2h (TCP keepalive) leaking PTY FDs.
pingInterval = setInterval(() => {
  for (const [ws, conn] of connections) {
    if (!conn.alive) {
      ws.terminate()
      continue
    }
    conn.alive = false
    ws.ping()
  }
}, WS_PING_INTERVAL_MS)
pingInterval.unref()

/** Close + clean up every non-persistent tmux attach. Never touches shell sessions. */
function drainNonPersistentAttaches(): void {
  let drained = 0
  for (const [ws, conn] of connections) {
    if (conn.attached.persistent) continue
    try { ws.close(4002, 'pty_capacity') } catch { /* noop */ }
    cleanupConnection(ws)
    drained += 1
  }
  if (drained > 0) console.warn(`[pty] drained ${drained} non-persistent attach(es)`)
}

sweepInterval = setInterval(() => {
  void sweep({ onDrain: drainNonPersistentAttaches })
}, PTY_SWEEP_INTERVAL_MS)
sweepInterval.unref()

server.on('upgrade', (req: IncomingMessage, socket, head) => {
  const url = new URL(req.url ?? '', `http://localhost:${port}`)

  if (!url.pathname.startsWith('/ws/terminal/')) {
    socket.destroy()
    return
  }

  // Validate origin
  const origin = req.headers.origin
  if (!isAllowedOrigin(origin)) {
    socket.destroy()
    return
  }

  const sessionName = decodeURIComponent(url.pathname.slice('/ws/terminal/'.length))
  if (!SESSION_NAME_RE.test(sessionName)) {
    socket.destroy()
    return
  }

  const cols = Math.max(1, Math.min(MAX_TERMINAL_COLS, Number(url.searchParams.get('cols')) || DEFAULT_TERMINAL_COLS))
  const rows = Math.max(1, Math.min(MAX_TERMINAL_ROWS, Number(url.searchParams.get('rows')) || DEFAULT_TERMINAL_ROWS))

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, sessionName, cols, rows, terminalPaletteFromSearchParams(url.searchParams))
  })
})

wss.on('connection', (ws: WebSocket, _req: IncomingMessage, sessionName: string, cols: number, rows: number, initialPalette: TerminalPalette) => {
  let attached: ReturnType<typeof attachSession>
  try {
    attached = attachSession(sessionName, cols, rows)
  } catch (err) {
    if (err instanceof PtyCapacityError) {
      console.warn(`[ws] pty capacity reject: ${sessionName}`)
      try { ws.close(4002, 'pty_capacity') } catch { /* noop */ }
      return
    }
    console.error(`[ws] failed to attach: ${sessionName}`, err)
    try { ws.close(4003, 'attach_failed') } catch { /* noop */ }
    return
  }

  const { proc } = attached
  const oscResponder = new TerminalOscColorResponder(
    shouldAnswerTerminalOscColor(sessionName),
    initialPalette,
  )

  const dataSub = proc.onData((data: string) => {
    const result = oscResponder.handle(data)
    for (const response of result.responses) proc.write(response)
    if (result.output && ws.readyState === WebSocket.OPEN) ws.send(result.output)
  })

  const exitSub = proc.onExit(() => {
    reconcileShellSessionExit(sessionName)
    if (ws.readyState === WebSocket.OPEN) ws.close(4001, 'session_ended')
    cleanupConnection(ws)
  })

  const conn: TerminalConnection = {
    sessionName,
    attached,
    dataSub,
    exitSub,
    alive: true,
    cleaned: false,
  }
  connections.set(ws, conn)
  ws.on('pong', () => { conn.alive = true })
  console.log(`[ws] terminal attached: ${sessionName} (pid=${proc.pid})`)

  if (attached.initialData && ws.readyState === WebSocket.OPEN) {
    ws.send(attached.initialData)
  }
  // Reset terminal modes that buffer replay may have restored from a prior
  // TUI session (e.g. mouse tracking, hidden cursor from Claude Code).
  // Sent unconditionally — even empty buffers may follow a session where
  // the PTY state still has cursor hidden.
  if (attached.persistent && ws.readyState === WebSocket.OPEN) {
    ws.send('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?25h')
  }

  ws.on('message', (raw) => {
    const entry = connections.get(ws)
    if (!entry) return
    const { proc } = entry.attached

    const str = raw.toString()
    if (str[0] === '{') {
      try {
        const msg = JSON.parse(str)
        if (msg.type === 'resize') {
          proc.resize(msg.cols, msg.rows)
          return
        }
        if (msg.type === 'terminal-theme') {
          const palette = parseTerminalPalette(msg)
          if (palette) oscResponder.updatePalette(palette)
          return
        }
        if (msg.type === 'input') {
          proc.write(msg.data)
          return
        }
        if (msg.type === 'text-paste' && typeof msg.data === 'string') {
          try {
            pasteTextToSession(sessionName, msg.data)
          } catch (err: unknown) {
            const message = err instanceof TerminalTextPasteError ? `${err.code}: ${err.message}` : String(err)
            console.warn(`[ws] text-paste failed for ${sessionName}: ${message}`)
            if (!(err instanceof TerminalTextPasteError && err.code === 'too-large')) {
              proc.write(msg.data)
            }
          }
          return
        }
        if (msg.type === 'image-paste' && typeof msg.mime === 'string' && typeof msg.base64 === 'string') {
          // Mirror the laptop's clipboard image into the desktop's X11 CLIPBOARD,
          // then send Ctrl+V so the focused TUI agent (Claude Code, Codex)
          // triggers its own paste path and reads the bytes back via xclip /
          // arboard. Fire-and-forget — we don't block PTY input on it.
          const bytes = Buffer.from(msg.base64, 'base64')
          writeImageToClipboard(msg.mime, bytes).then(() => {
            proc.write('\x16')
          }).catch((err: unknown) => {
            const message = err instanceof ClipboardWriteError ? `${err.code}: ${err.message}` : String(err)
            console.warn(`[ws] image-paste failed for ${sessionName}: ${message}`)
          })
          return
        }
      } catch { /* not JSON */ }
    }
    proc.write(str)
  })

  ws.on('close', () => cleanupConnection(ws))

  ws.on('error', (err) => {
    console.error(`[ws] terminal error: ${sessionName}`, err)
    cleanupConnection(ws)
    try { ws.close() } catch { /* noop */ }
  })
})

// On server shutdown, destroy all PTY attach processes to avoid orphaned
// tmux-client PTYs that leak /dev/ttys devices over repeated dev restarts.
// This only kills attach clients — tmux sessions themselves keep running.
let cleanedUp = false
function cleanupTerminalResources(): void {
  if (cleanedUp) return
  cleanedUp = true
  if (pingInterval) clearInterval(pingInterval)
  if (sweepInterval) clearInterval(sweepInterval)
  stopSessionReconciler()
  stopAttentionEngine()
  stopProjectWatchers()
  shutdownWeChat()
  for (const ws of [...connections.keys()]) {
    cleanupConnection(ws)
    ws.terminate()
  }
}

// Async shutdown sequence: must await Puppeteer's client.destroy() so the
// headless Chrome holding the WhatsApp LocalAuth userDataDir releases its
// SingletonLock before the node process exits. Without this, tsx watch
// reloads leak orphan Chromes that block the next initWhatsApp.
async function shutdownGracefully(): Promise<void> {
  cleanupTerminalResources()
  try { await shutdownWhatsApp() }
  catch (e) { console.error('[shutdown] whatsapp:', e) }
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    void shutdownGracefully().finally(() => process.exit(0))
  })
}

process.on('exit', () => {
  cleanupTerminalResources()
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason, promise)
})

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.stack || err)
})
