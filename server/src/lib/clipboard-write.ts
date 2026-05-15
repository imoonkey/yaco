import { spawn } from 'child_process'
import { discoverClipboardEnv } from './clipboard-env'

const SUPPORTED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
])

const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024

export type ClipboardWriteErrorCode =
  | 'unsupported-mime'
  | 'too-large'
  | 'no-display'
  | 'tool-failed'

export class ClipboardWriteError extends Error {
  code: ClipboardWriteErrorCode
  constructor(code: ClipboardWriteErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

// Pipe image bytes into the system clipboard via xclip on Linux. xclip reads
// stdin to EOF then forks itself into a daemon that serves the data on
// subsequent paste requests; the parent process exits cleanly. Codex (via the
// arboard Rust crate) and Claude Code (via `xclip -o`) both pull from this
// same X11 CLIPBOARD selection, so a single write satisfies both.
export function writeImageToClipboard(mime: string, bytes: Buffer): Promise<void> {
  if (!SUPPORTED_IMAGE_MIMES.has(mime)) {
    return Promise.reject(new ClipboardWriteError('unsupported-mime', `Unsupported clipboard image MIME: ${mime}`))
  }
  if (bytes.length > MAX_CLIPBOARD_IMAGE_BYTES) {
    return Promise.reject(new ClipboardWriteError('too-large', `Clipboard image exceeds ${MAX_CLIPBOARD_IMAGE_BYTES} bytes (got ${bytes.length})`))
  }

  const clipboardEnv = discoverClipboardEnv()
  const env = { ...process.env, ...clipboardEnv }
  if (!env.DISPLAY || !env.XAUTHORITY) {
    return Promise.reject(new ClipboardWriteError('no-display', 'No graphical session detected for clipboard write'))
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('xclip', ['-selection', 'clipboard', '-t', mime, '-i'], {
      env,
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let stderr = ''
    proc.stderr?.on('data', chunk => { stderr += chunk.toString() })
    proc.on('error', err => {
      reject(new ClipboardWriteError('tool-failed', `xclip spawn failed: ${err.message}`))
    })
    proc.on('exit', code => {
      if (code === 0) resolve()
      else reject(new ClipboardWriteError('tool-failed', `xclip exited ${code}: ${stderr.trim() || '(no stderr)'}`))
    })
    proc.stdin?.end(bytes)
  })
}
