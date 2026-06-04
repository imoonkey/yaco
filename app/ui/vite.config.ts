import { defineConfig, type Connect, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import compression from 'compression'

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

export default defineConfig({
  plugins: [react(), tailwindcss(), devGzip()],
  server: {
    host: '0.0.0.0',
    allowedHosts: ['laptop', 'desktop', '.tailnet-example.ts.net'],
    warmup: {
      clientFiles: [
        './src/main.tsx',
        './src/App.tsx',
        './src/workspace/WorkspaceScreen.tsx',
      ],
    },
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
})
