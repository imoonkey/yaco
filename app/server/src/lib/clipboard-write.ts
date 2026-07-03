import { spawn } from 'child_process'
import { discoverClipboardEnv } from './clipboard-env'

// Only image/png is mirrored. The agent's read path is
// `xclip -t image/png -o || wl-paste ...`, so a non-PNG selection (jpeg, webp,
// gif) fails the xclip read and drops the agent onto the wl-paste fallback that
// hangs on Mutter's X11->Wayland bridge. Restricting to PNG — the format
// browsers put on the clipboard for a pasted image anyway — keeps every write
// on the reliable, agent-readable path; anything else is rejected up front.
const SUPPORTED_IMAGE_MIMES = new Set([
  'image/png',
])

const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024

// After xclip -i takes ownership, the TUI agent reads the image back with its
// own `xclip -selection clipboard -t <mime> -o` and only falls through to a
// `wl-paste` fallback when that X11 read fails. On a GNOME/Wayland session the
// wl-paste fallback hangs forever on Mutter's X11->Wayland image bridge — this
// is the "Pasting..." freeze. So we do not resolve (and the caller does not
// send Ctrl+V) until the very same `xclip -o` read returns the whole image,
// i.e. the selection owner is live and serving. That keeps the agent on the
// reliable X11 path and the hanging wl-paste branch is never reached.
const VERIFY_ATTEMPTS = 12
const VERIFY_INTERVAL_MS = 60
const READ_TIMEOUT_MS = 800

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

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// Read the clipboard image back the exact way the agent does and return its
// byte length (-1 on failure/timeout). Bounded by READ_TIMEOUT_MS so a stalled
// read can never wedge the paste path.
function readClipboardImageLength(mime: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise(resolve => {
    const proc = spawn('xclip', ['-selection', 'clipboard', '-t', mime, '-o'], {
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let length = 0
    let settled = false
    const settle = (n: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(n)
    }
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      settle(-1)
    }, READ_TIMEOUT_MS)
    proc.stdout?.on('data', chunk => { length += chunk.length })
    proc.on('error', () => settle(-1))
    proc.on('exit', code => settle(code === 0 ? length : -1))
  })
}

async function verifyClipboardImage(mime: string, expected: number, env: NodeJS.ProcessEnv): Promise<void> {
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
    if (await readClipboardImageLength(mime, env) === expected) return
    await delay(VERIFY_INTERVAL_MS)
  }
  throw new ClipboardWriteError('tool-failed', `Clipboard image not readable after write (expected ${expected} bytes)`)
}

// Pipe image bytes into the system clipboard via xclip on Linux. xclip reads
// stdin to EOF then forks itself into a daemon that serves the data on
// subsequent paste requests; the parent process exits cleanly. Codex (via the
// arboard Rust crate) and Claude Code (via `xclip -o`) both pull from this
// same X11 CLIPBOARD selection, so a single write satisfies both. We resolve
// only once the write is verified readable (see VERIFY_ATTEMPTS above).
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
      if (code !== 0) {
        reject(new ClipboardWriteError('tool-failed', `xclip exited ${code}: ${stderr.trim() || '(no stderr)'}`))
        return
      }
      verifyClipboardImage(mime, bytes.length, env).then(resolve, reject)
    })
    proc.stdin?.end(bytes)
  })
}
