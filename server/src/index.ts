import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { projectRoutes } from './routes/projects'
import { workstreamRoutes } from './routes/workstreams'
import { progressRoutes } from './routes/progress'
import { sessionRoutes } from './routes/sessions'
import { fileRoutes } from './routes/files'
import { ensureWorkflowDir, loadProjects } from './lib/projects'
import { startWatching } from './lib/watcher'
import { sendKeys, capturePane } from './lib/terminal'
import type { ServerWebSocket } from 'bun'

const ALLOWED_ORIGINS = (process.env.WORKFLOW_CORS_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map(s => s.trim())

const SESSION_NAME_RE = /^[a-zA-Z0-9_-]+$/

const app = new Hono()

app.use('*', cors({ origin: ALLOWED_ORIGINS }))

// API routes
app.route('/api/projects', projectRoutes)
app.route('/api/workstreams', workstreamRoutes)
app.route('/api/progress', progressRoutes)
app.route('/api/sessions', sessionRoutes)
app.route('/api/files', fileRoutes)

app.get('/api/health', (c) => c.json({ ok: true }))

// Init
await ensureWorkflowDir()
const projects = await loadProjects()
await startWatching(projects, (project, workstream) => {
  console.log(`[watch] progress.json changed: ${project}/${workstream}`)
})

const port = Number(process.env.WORKFLOW_PORT ?? 3001)

interface WsData {
  sessionName: string
}

const terminalClients = new Map<string, Set<ServerWebSocket<WsData>>>()
const pollIntervals = new Map<string, ReturnType<typeof setInterval>>()

function startPolling(sessionName: string) {
  if (pollIntervals.has(sessionName)) return
  let lastOutput = ''
  const interval = setInterval(async () => {
    const clients = terminalClients.get(sessionName)
    if (!clients || clients.size === 0) {
      clearInterval(interval)
      pollIntervals.delete(sessionName)
      return
    }
    const output = await capturePane(sessionName)
    if (output !== lastOutput) {
      lastOutput = output
      const msg = JSON.stringify({ type: 'output', data: output })
      for (const ws of clients) {
        ws.send(msg)
      }
    }
  }, 300)
  pollIntervals.set(sessionName, interval)
}

const server = Bun.serve<WsData>({
  port,
  fetch(req, server) {
    const url = new URL(req.url)

    // WebSocket upgrade for terminal
    if (url.pathname.startsWith('/ws/terminal/')) {
      // Validate origin
      const origin = req.headers.get('origin')
      if (origin && !ALLOWED_ORIGINS.includes(origin)) {
        return new Response('Origin not allowed', { status: 403 })
      }

      const sessionName = decodeURIComponent(url.pathname.slice('/ws/terminal/'.length))
      if (!SESSION_NAME_RE.test(sessionName)) {
        return new Response('Invalid session name', { status: 400 })
      }

      const success = server.upgrade(req, { data: { sessionName } })
      if (success) return undefined
      return new Response('WebSocket upgrade failed', { status: 400 })
    }

    return app.fetch(req)
  },
  websocket: {
    open(ws: ServerWebSocket<WsData>) {
      const { sessionName } = ws.data
      if (!terminalClients.has(sessionName)) {
        terminalClients.set(sessionName, new Set())
      }
      terminalClients.get(sessionName)!.add(ws)
      startPolling(sessionName)
      console.log(`[ws] terminal attached: ${sessionName}`)
    },
    message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
      const { sessionName } = ws.data
      try {
        const msg = JSON.parse(typeof message === 'string' ? message : message.toString())
        if (msg.type === 'input') {
          sendKeys(sessionName, msg.data)
        }
      } catch {
        // ignore malformed messages
      }
    },
    close(ws: ServerWebSocket<WsData>) {
      const { sessionName } = ws.data
      const clients = terminalClients.get(sessionName)
      if (clients) {
        clients.delete(ws)
        if (clients.size === 0) terminalClients.delete(sessionName)
      }
      console.log(`[ws] terminal detached: ${sessionName}`)
    },
  },
})

console.log(`Workflow server running on http://localhost:${server.port}`)
