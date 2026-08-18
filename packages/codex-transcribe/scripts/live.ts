import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const MAX_DECODED_BYTES = 4 * 1024 * 1024
const execFileAsync = promisify(execFile)

async function decodePcm16(
  path: string,
  sampleRateHz: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const { stdout } = await execFileAsync('ffmpeg', [
    '-nostdin',
    '-v', 'error',
    '-i', path,
    '-map', '0:a:0',
    '-ac', '1',
    '-ar', String(sampleRateHz),
    '-f', 's16le',
    'pipe:1',
  ], {
    encoding: 'buffer',
    maxBuffer: MAX_DECODED_BYTES,
  })
  if (!Buffer.isBuffer(stdout)) throw new Error('decode failed')
  return Uint8Array.from(stdout)
}

// The package uses .js specifiers in TypeScript source for its ESM build. The
// live script runs source directly, so register the root workspace's existing
// tsx loader before importing the package graph.
const { register } = await import('tsx/esm/api')
const unregister = register()
try {
  const {
    inspectCodexTranscribe,
    openCodexDictationSession,
    transcribeCodex,
  } = await import('../src/index.ts')
  const { runLive } = await import('./live-contract.ts')

  process.exitCode = await runLive(process.env, {
    inspect: inspectCodexTranscribe,
    readAudio: async path => Uint8Array.from(await readFile(path)),
    decodePcm16,
    openStream: openCodexDictationSession,
    transcribe: transcribeCodex,
    now: performance.now.bind(performance),
    wait: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    timeout: AbortSignal.timeout.bind(AbortSignal),
    emit: line => process.stdout.write(`${line}\n`),
  })
} finally {
  unregister()
}
