import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

interface AuthFile {
  boundConversationId: string
  boundAt: string
}

const WORKFLOW_DIR = join(homedir(), '.workflow')
const AUTH_FILE = join(WORKFLOW_DIR, 'wechat-auth.json')

const WHITELIST = (process.env.WECHAT_CONVERSATION_WHITELIST ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

let tofuBound: string | null = null
let loadedOnce: Promise<void> | null = null
let writeChain: Promise<void> = Promise.resolve()

async function ensureDir(): Promise<void> {
  if (!existsSync(WORKFLOW_DIR)) await mkdir(WORKFLOW_DIR, { recursive: true })
}

async function loadTofuOnce(): Promise<void> {
  if (loadedOnce) return loadedOnce
  loadedOnce = (async () => {
    if (!existsSync(AUTH_FILE)) return
    try {
      const raw = await readFile(AUTH_FILE, 'utf-8')
      const parsed = JSON.parse(raw) as AuthFile
      if (parsed?.boundConversationId) tofuBound = parsed.boundConversationId
    } catch (e) {
      console.warn('[wechat-auth] failed to read auth file, will TOFU-bind on next message:', e)
    }
  })()
  return loadedOnce
}

function persistTofu(): Promise<void> {
  // Serialize all writes through a chain to avoid concurrent fs.writeFile races.
  writeChain = writeChain.then(async () => {
    if (!tofuBound) return
    await ensureDir()
    const payload: AuthFile = { boundConversationId: tofuBound, boundAt: new Date().toISOString() }
    await writeFile(AUTH_FILE, JSON.stringify(payload, null, 2), 'utf-8')
  })
  return writeChain
}

/** Resolve whether a conversationId may interact with the bot.
 *  In TOFU mode, atomically binds the first conversationId seen.
 *  Returns 'allow' (may proceed) or 'deny' (silent drop). */
export async function authorize(conversationId: string): Promise<'allow' | 'deny'> {
  if (WHITELIST.length > 0) {
    return WHITELIST.includes(conversationId) ? 'allow' : 'deny'
  }
  await loadTofuOnce()
  if (!tofuBound) {
    // First-contact bind. Synchronous assignment beats the await,
    // so concurrent first-message calls can't both pass the check.
    tofuBound = conversationId
    await persistTofu()
    console.log(`[wechat-auth] TOFU-bound to conversationId ${conversationId}`)
    return 'allow'
  }
  return tofuBound === conversationId ? 'allow' : 'deny'
}

/** For diagnostics / status route */
export function getAuthSnapshot(): { mode: 'whitelist' | 'tofu', whitelist: string[], tofuBound: string | null } {
  return {
    mode: WHITELIST.length > 0 ? 'whitelist' : 'tofu',
    whitelist: [...WHITELIST],
    tofuBound,
  }
}
