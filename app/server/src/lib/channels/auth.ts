import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { channelScopeDir } from '@yaco/cli/core/paths'

interface AuthFile {
  boundConversationId: string
  boundAt: string
}

/** Per-channel auth store: env whitelist OR TOFU first-contact bind, persisted
 *  to ${YACO_HOME}/channels/<scope>/auth.json. Atomic check-and-bind. */
export function createAuthStore(scope: string, whitelistEnvKey: string) {
  const scopeDir = channelScopeDir(scope)
  const authFile = join(scopeDir, 'auth.json')

  async function ensureDir(): Promise<void> {
    if (!existsSync(scopeDir)) await mkdir(scopeDir, { recursive: true })
  }
  const whitelist = (process.env[whitelistEnvKey] ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  let tofuBound: string | null = null
  let loadedOnce: Promise<void> | null = null
  let writeChain: Promise<void> = Promise.resolve()

  async function loadTofuOnce(): Promise<void> {
    if (loadedOnce) return loadedOnce
    loadedOnce = (async () => {
      if (!existsSync(authFile)) return
      try {
        const raw = await readFile(authFile, 'utf-8')
        const parsed = JSON.parse(raw) as AuthFile
        if (parsed?.boundConversationId) tofuBound = parsed.boundConversationId
      } catch (e) {
        console.warn(`[${scope}-auth] failed to read auth file, will TOFU-bind on next message:`, e)
      }
    })()
    return loadedOnce
  }

  function persistTofu(): Promise<void> {
    writeChain = writeChain.then(async () => {
      if (!tofuBound) return
      await ensureDir()
      const payload: AuthFile = { boundConversationId: tofuBound, boundAt: new Date().toISOString() }
      await writeFile(authFile, JSON.stringify(payload, null, 2), 'utf-8')
    })
    return writeChain
  }

  return {
    /** Eager-load the persisted TOFU binding (for boot-time status display). */
    async ensureLoaded(): Promise<void> {
      await loadTofuOnce()
    },

    /** 'allow' to proceed, 'deny' to silent-drop. In TOFU mode, atomically
     *  binds the first conversationId seen. */
    async authorize(conversationId: string): Promise<'allow' | 'deny'> {
      if (whitelist.length > 0) {
        return whitelist.includes(conversationId) ? 'allow' : 'deny'
      }
      await loadTofuOnce()
      if (!tofuBound) {
        // Synchronous assignment beats the await — concurrent first-message
        // calls can't both pass the check.
        tofuBound = conversationId
        await persistTofu()
        console.log(`[${scope}-auth] TOFU-bound to conversationId ${conversationId}`)
        return 'allow'
      }
      return tofuBound === conversationId ? 'allow' : 'deny'
    },

    getAuthSnapshot(): { mode: 'whitelist' | 'tofu', whitelist: string[], tofuBound: string | null } {
      return {
        mode: whitelist.length > 0 ? 'whitelist' : 'tofu',
        whitelist: [...whitelist],
        tofuBound,
      }
    },
  }
}

export type AuthStore = ReturnType<typeof createAuthStore>
