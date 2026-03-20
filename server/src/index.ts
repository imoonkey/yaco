import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'http'
import { isIP } from 'node:net'
import { projectRoutes } from './routes/projects.js'
import { workstreamRoutes } from './routes/workstreams.js'
import { progressRoutes } from './routes/progress.js'
import { sessionRoutes } from './routes/sessions.js'
import { fileRoutes } from './routes/files.js'
import { gitRoutes } from './routes/git.js'
import { notificationRoutes } from './routes/notifications.js'
import { ensureWorkflowDir, loadProjects } from './lib/projects.js'
import { startWatching } from './lib/watcher.js'
import { startSessionPoller } from './lib/session-poller.js'
import { attachSession } from './lib/terminal.js'
import type { IPty } from 'node-pty'

const EXPLICIT_ALLOWED_ORIGINS = (process.env.WORKFLOW_CORS_ORIGINS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const SESSION_NAME_RE = /^[a-zA-Z0-9_.-]+$/
const DEFAULT_ALLOWED_HOSTNAMES = new Set(['localhost', '::1', 'moonkeys-mbp'])

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

app.get('/api/health', (c) => c.json({ ok: true }))

// Init
await ensureWorkflowDir()
const projects = await loadProjects()
await startWatching(projects, (project, workstream) => {
  console.log(`[watch] progress.json changed: ${project}/${workstream}`)
})
startSessionPoller()

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

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, sessionName, cols, rows)
  })
})

wss.on('connection', (ws: WebSocket, _req: IncomingMessage, sessionName: string, cols: number, rows: number) => {
  try {
    const attached = attachSession(sessionName, cols, rows)
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
})
