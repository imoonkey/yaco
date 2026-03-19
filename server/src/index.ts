import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'http'
import { projectRoutes } from './routes/projects.js'
import { workstreamRoutes } from './routes/workstreams.js'
import { progressRoutes } from './routes/progress.js'
import { sessionRoutes } from './routes/sessions.js'
import { fileRoutes } from './routes/files.js'
import { ensureWorkflowDir, loadProjects } from './lib/projects.js'
import { startWatching } from './lib/watcher.js'
import { attachSession } from './lib/terminal.js'
import type { IPty } from 'node-pty'

const ALLOWED_ORIGINS = (process.env.WORKFLOW_CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:5174')
  .split(',')
  .map(s => s.trim())

const SESSION_NAME_RE = /^[a-zA-Z0-9_.-]+$/

const app = new Hono()

app.use('*', cors({ origin: ALLOWED_ORIGINS }))

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

// Start HTTP server
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`Workflow server running on http://localhost:${port}`)
})

// WebSocket server on the same HTTP server
const wss = new WebSocketServer({ noServer: true })
const ptyMap = new Map<WebSocket, IPty>()

server.on('upgrade', (req: IncomingMessage, socket, head) => {
  const url = new URL(req.url ?? '', `http://localhost:${port}`)

  if (!url.pathname.startsWith('/ws/terminal/')) {
    socket.destroy()
    return
  }

  // Validate origin
  const origin = req.headers.origin
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    socket.destroy()
    return
  }

  const sessionName = decodeURIComponent(url.pathname.slice('/ws/terminal/'.length))
  if (!SESSION_NAME_RE.test(sessionName)) {
    socket.destroy()
    return
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, sessionName)
  })
})

wss.on('connection', (ws: WebSocket, _req: IncomingMessage, sessionName: string) => {
  try {
    const proc = attachSession(sessionName, 80, 24)

    proc.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    })

    proc.onExit(() => {
      ptyMap.delete(ws)
      if (ws.readyState === WebSocket.OPEN) ws.close()
    })

    ptyMap.set(ws, proc)
    console.log(`[ws] terminal attached: ${sessionName} (pid=${proc.pid})`)
  } catch (err) {
    console.error(`[ws] failed to attach: ${sessionName}`, err)
    ws.close()
    return
  }

  ws.on('message', (raw) => {
    const proc = ptyMap.get(ws)
    if (!proc) return

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
    const proc = ptyMap.get(ws)
    if (proc) {
      proc.kill()
      ptyMap.delete(ws)
    }
    console.log(`[ws] terminal detached: ${sessionName}`)
  })
})
