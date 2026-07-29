import { readFile } from 'node:fs/promises'
import { inspectCodexTranscribe, transcribeCodex } from '../src/index.ts'
import { runLive } from './live-contract.ts'

process.exitCode = await runLive(process.env, {
  inspect: inspectCodexTranscribe,
  readAudio: async path => Uint8Array.from(await readFile(path)),
  transcribe: transcribeCodex,
  now: performance.now.bind(performance),
  timeout: AbortSignal.timeout.bind(AbortSignal),
  emit: line => process.stdout.write(`${line}\n`),
})
