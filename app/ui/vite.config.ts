import { defineConfig, type Connect, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import compression from 'compression'
import { resolveDevPorts } from './e2ePorts'
import { compressDist } from './scripts/compress-dist'

// Worktree-isolated dev ports (main checkout → 5173 / 3001 unchanged).
const { ui: UI_PORT, api: API_PORT } = resolveDevPorts()

// The /api + /ws proxy target. e2e runs an isolated API server on a different
// port and injects VITE_PROXY_API_PORT so this dev server proxies to THAT server
// (the isolated YACO_HOME) instead of the real dev server on 3001.
const PROXY_API_PORT = process.env.VITE_PROXY_API_PORT
  ? Number(process.env.VITE_PROXY_API_PORT)
  : API_PORT

// Self-hosted VAD assets removed: the voice path now records with the native
// MediaRecorder (src/hooks/voiceCapture.ts) and no longer ships a neural VAD.

const devGzip = (): PluginOption => ({
  name: 'dev-gzip',
  apply: 'serve',
  configureServer(server) {
    const mw = compression({
      threshold: 512,
      filter: (req, res) => {
        const ct = res.getHeader('content-type')
        if (typeof ct === 'string' && ct.includes('text/event-stream')) return false
        return compression.filter(req, res)
      },
    })
    server.middlewares.use(mw as Connect.NextHandleFunction)
  },
})

// Precompressed .br/.gz siblings for the server's `pickEncoding` negotiation.
// A plugin, not a post-build npm step, so `vite build --watch` compresses too.
const buildCompress = (): PluginOption => ({
  name: 'compress-dist',
  apply: 'build',
  closeBundle: compressDist,
})

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    devGzip(),
    buildCompress(),
  ],
  server: {
    host: '0.0.0.0',
    port: UI_PORT,
    allowedHosts: ['laptop', 'desktop', '.tailnet-example.ts.net'],
    warmup: {
      clientFiles: [
        './src/main.tsx',
        './src/App.tsx',
        './src/workspace/WorkspaceScreen.tsx',
      ],
    },
    proxy: {
      '/api': `http://localhost:${PROXY_API_PORT}`,
      '/ws': {
        target: `ws://localhost:${PROXY_API_PORT}`,
        ws: true,
      },
    },
  },
})
