import 'dotenv/config'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'http'
import { isIP } from 'node:net'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { projectRoutes } from './routes/projects.js'
import { workstreamRoutes } from './routes/workstreams.js'
import { progressRoutes } from './routes/progress.js'
import { sessionRoutes } from './routes/sessions.js'
import { fileRoutes } from './routes/files.js'
import { gitRoutes } from './routes/git.js'
import { notificationRoutes } from './routes/notifications.js'
import { browseRoutes } from './routes/browse.js'
import { voiceRoutes } from './routes/voice.js'
import { ensureWorkflowDir, loadProjects } from './lib/projects.js'
import { startWatching } from './lib/watcher.js'
import { startSessionReconciler } from './lib/session-reconciler.js'
import { startProjectWatchers } from './lib/project-watcher.js'
import { emitRefresh } from './lib/notify.js'
import { attachSession, setShellSessionChangeCallback } from './lib/terminal.js'
import type { IPty } from 'node-pty'

const EXPLICIT_ALLOWED_ORIGINS = (process.env.WORKFLOW_CORS_ORIGINS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const SESSION_NAME_RE = /^[a-zA-Z0-9_.-]+$/
const DEFAULT_ALLOWED_HOSTNAMES = new Set([
  'localhost',
  '::1',
  'laptop',
  'laptop.tailnet-example.ts.net',
])
const SERVER_SRC_DIR = dirname(fileURLToPath(import.meta.url))
const UI_DIST_DIR = resolve(SERVER_SRC_DIR, '../../ui/dist')
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

async function serveUiFile(pathname: string): Promise<Response | null> {
  const filePath = resolveUiPath(pathname)
  if (!filePath) return new Response('Not found', { status: 404 })

  try {
    const body = await readFile(filePath)
    const headers = new Headers({
      'Content-Type': getContentType(filePath),
      'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    return new Response(body, { headers })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function serveUiApp(pathname: string): Promise<Response> {
  const direct = await serveUiFile(pathname)
  if (direct) return direct

  if (pathname !== '/' && extname(pathname)) {
    return new Response('Not found', { status: 404 })
  }

  const indexFile = await serveUiFile('/')
  if (indexFile) return indexFile

  return new Response(
    'Workflow UI build not found. Run `npm run build` from the repo root before using the backend as the app entrypoint.',
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
app.route('/api/workstreams', workstreamRoutes)
app.route('/api/progress', progressRoutes)
app.route('/api/sessions', sessionRoutes)
app.route('/api/files', fileRoutes)
app.route('/api/git', gitRoutes)
app.route('/api/notifications', notificationRoutes)
app.route('/api/browse', browseRoutes)
app.route('/api/voice', voiceRoutes)

app.get('/api/health', (c) => c.json({ ok: true }))
app.get('*', async (c) => serveUiApp(c.req.path))

// Init
await ensureWorkflowDir()
const projects = await loadProjects()
await startWatching(projects, (project, workstream) => {
  console.log(`[watch] progress.json changed: ${project}/${workstream}`)
})
startSessionReconciler()
await startProjectWatchers(projects)
setShellSessionChangeCallback(() => emitRefresh('sessions'))

const port = Number(process.env.WORKFLOW_PORT ?? 3001)

// Start HTTP server
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`Workflow server running on http://localhost:${port}`)
})

// WebSocket server on the same HTTP server
const wss = new WebSocketServer({ noServer: true })
type PtySubscription = ReturnType<IPty['onData']>

const ptyMap = new Map<WebSocket, ReturnType<typeof attachSession>>()
const subscriptionMap = new Map<WebSocket, { data: PtySubscription; exit: PtySubscription }>()

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

  const cols = Math.max(1, Math.min(500, Number(url.searchParams.get('cols')) || 80))
  const rows = Math.max(1, Math.min(200, Number(url.searchParams.get('rows')) || 24))
  const projectParam = url.searchParams.get('project') || ''

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, sessionName, cols, rows, projectParam)
  })
})

wss.on('connection', async (ws: WebSocket, _req: IncomingMessage, sessionName: string, cols: number, rows: number, projectParam: string) => {
  try {
    let projectPath: string | undefined
    if (projectParam) {
      const projects = await loadProjects()
      projectPath = projects.find(p => p.name === projectParam)?.path
    }
    const attached = attachSession(sessionName, cols, rows, projectPath)
    const { proc } = attached

    const dataSubscription = proc.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    })

    const exitSubscription = proc.onExit(() => {
      if (ws.readyState === WebSocket.OPEN) ws.close()
    })

    ptyMap.set(ws, attached)
    subscriptionMap.set(ws, { data: dataSubscription, exit: exitSubscription })
    console.log(`[ws] terminal attached: ${sessionName} (pid=${proc.pid})`)

    if (attached.initialData && ws.readyState === WebSocket.OPEN) {
      ws.send(attached.initialData)
    }
  } catch (err) {
    console.error(`[ws] failed to attach: ${sessionName}`, err)
    ws.close()
    return
  }

  ws.on('message', (raw) => {
    const attached = ptyMap.get(ws)
    if (!attached) return
    const { proc } = attached

    const str = raw.toString()
    if (str[0] === '{') {
      try {
        const msg = JSON.parse(str)
        if (msg.type === 'resize') {
          proc.resize(msg.cols, msg.rows)
          return
        }
        if (msg.type === 'input') {
          proc.write(msg.data)
          return
        }
      } catch { /* not JSON */ }
    }
    proc.write(str)
  })

  ws.on('close', () => {
    const attached = ptyMap.get(ws)
    const subscription = subscriptionMap.get(ws)

    subscription?.data.dispose()
    subscription?.exit.dispose()

    if (attached) {
      if (!attached.persistent) {
        attached.proc.kill()
      }
      ptyMap.delete(ws)
    }
    subscriptionMap.delete(ws)
    console.log(`[ws] terminal detached: ${sessionName}`)
  })

  ws.on('error', (err) => {
    console.error(`[ws] terminal error: ${sessionName}`, err)
    ws.close()
  })
})
