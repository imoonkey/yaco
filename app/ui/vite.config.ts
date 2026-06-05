import { defineConfig, type Connect, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteStaticCopy, type Target } from 'vite-plugin-static-copy'
import compression from 'compression'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// Self-hosted VAD assets. The voice path (vs-vad-module, src/hooks/voiceVad.ts)
// lazy-`import()`s @ricky0123/vad-web, which at init fetches its worklet + Silero
// model and the onnxruntime-web SIMD runtime from a base path — never from the JS
// bundle. We copy exactly those files to a version-pinned dir, served with an
// immutable cache (see app/server/src/index.ts). The dynamic import() + the
// MicVAD wiring itself live in voiceVad.ts; this file only provides the assets.
//
// Consumer contract for MicVAD.new() in voiceVad.ts:
//   { baseAssetPath: __VAD_ASSET_BASE__, onnxWASMBasePath: __VAD_ASSET_BASE__, model: 'v5' }
// __VAD_ASSET_BASE__ (a build-time constant injected below) is the single source
// of truth for the served URL, so the runtime fetch path cannot drift from where
// these files land.
//
// Bump VAD_ASSET_VERSION on any @ricky0123/vad-web or onnxruntime-web upgrade —
// the segment is the immutable-cache key and must move with the copied files.
// The value tracks the pinned onnxruntime-web version (the dominant asset).
const VAD_ASSET_VERSION = '1.20.1'
const VAD_ASSET_DEST = `assets/vad/${VAD_ASSET_VERSION}`
const VAD_ASSET_BASE = `/${VAD_ASSET_DEST}/`

const require = createRequire(import.meta.url)
const vadDist = dirname(require.resolve('@ricky0123/vad-web'))
const ortDist = dirname(require.resolve('onnxruntime-web'))

// The exact files MicVAD.new({ model: 'v5' }) requests at runtime. vad-web imports
// `onnxruntime-web/wasm` (single-threaded SIMD, non-jsep), so ORT only fetches
// ort-wasm-simd-threaded.{mjs,wasm} — the WebGPU/jsep build is never touched
// (no SharedArrayBuffer/COOP+COEP needed). Only the v5 Silero model is copied;
// MicVAD defaults to 'legacy' (silero_vad_legacy.onnx), so the wrapper MUST pass
// model: 'v5' or model load 404s.
// stripBase flattens each absolute src to <dest>/<filename>; without it the copy
// preserves the full node_modules/.../dist tree under dest.
const vadAssetTargets: Target[] = [
  join(vadDist, 'vad.worklet.bundle.min.js'),
  join(vadDist, 'silero_vad_v5.onnx'),
  join(ortDist, 'ort-wasm-simd-threaded.mjs'),
  join(ortDist, 'ort-wasm-simd-threaded.wasm'),
].map((src) => ({ src, dest: VAD_ASSET_DEST, rename: { stripBase: true } }))

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
  plugins: [
    react(),
    tailwindcss(),
    viteStaticCopy({ targets: vadAssetTargets }),
    devGzip(),
  ],
  define: {
    __VAD_ASSET_BASE__: JSON.stringify(VAD_ASSET_BASE),
  },
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
