import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { channelScopeDir } from 'yaco-cli/core/paths'

export interface Binding {
  project: string
  session: string
  boundAt: string
}

/** Per-conversation subscription set plus the one active send target. Plain
 *  text goes to `active`; replies stream from every subscribed session, each
 *  labeled by name so concurrent turns stay unambiguous. */
export interface ConversationBindings {
  sessions: Binding[]
  active: string | null
}

export type BindingFile = Record<string, ConversationBindings>

/** Per-channel binding store backed by ${YACO_HOME}/channels/<scope>/state.json.
 *  Module-private cache + serialized writes to avoid concurrent fs races. */
export function createBindingStore(scope: string) {
  const scopeDir = channelScopeDir(scope)
  const stateFile = join(scopeDir, 'state.json')
  let cache: BindingFile | null = null
  let writeChain: Promise<void> = Promise.resolve()

  async function ensureDir(): Promise<void> {
    if (!existsSync(scopeDir)) await mkdir(scopeDir, { recursive: true })
  }

  async function load(): Promise<BindingFile> {
    if (cache) return cache
    if (!existsSync(stateFile)) {
      cache = {}
      return cache
    }
    try {
      const raw = await readFile(stateFile, 'utf-8')
      const parsed = JSON.parse(raw) as BindingFile
      cache = parsed && typeof parsed === 'object' ? parsed : {}
    } catch (e) {
      console.warn(`[${scope}-state] failed to read state file, starting empty:`, e)
      cache = {}
    }
    return cache
  }

  function persist(): Promise<void> {
    writeChain = writeChain.then(async () => {
      if (!cache) return
      await ensureDir()
      await writeFile(stateFile, JSON.stringify(cache, null, 2), 'utf-8')
    })
    return writeChain
  }

  return {
    /** The active send target, or undefined when nothing is subscribed. */
    async getActive(conversationId: string): Promise<Binding | undefined> {
      const conv = (await load())[conversationId]
      if (!conv || !conv.active) return undefined
      return conv.sessions.find(s => s.session === conv.active)
    },

    /** Every subscribed session for the conversation (active or not). */
    async listSessions(conversationId: string): Promise<Binding[]> {
      return (await load())[conversationId]?.sessions ?? []
    },

    /** Subscribe (dedupe by session name, refreshing project/boundAt) and make
     *  it the active target. */
    async addSession(conversationId: string, binding: Binding): Promise<void> {
      const state = await load()
      const conv = state[conversationId] ?? { sessions: [], active: null }
      conv.sessions = conv.sessions.filter(s => s.session !== binding.session)
      conv.sessions.push(binding)
      conv.active = binding.session
      state[conversationId] = conv
      await persist()
    },

    /** Promote an already-subscribed session to active. Returns false if it
     *  isn't subscribed. */
    async setActive(conversationId: string, session: string): Promise<boolean> {
      const state = await load()
      const conv = state[conversationId]
      if (!conv || !conv.sessions.some(s => s.session === session)) return false
      conv.active = session
      await persist()
      return true
    },

    /** Unsubscribe one session. If it was active, promote the most-recently
     *  added remaining session (or null). Returns the removed binding, or
     *  undefined when it wasn't subscribed. */
    async removeSession(conversationId: string, session: string): Promise<Binding | undefined> {
      const state = await load()
      const conv = state[conversationId]
      if (!conv) return undefined
      const idx = conv.sessions.findIndex(s => s.session === session)
      if (idx < 0) return undefined
      const [removed] = conv.sessions.splice(idx, 1)
      if (conv.active === session) {
        conv.active = conv.sessions.at(-1)?.session ?? null
      }
      if (conv.sessions.length === 0) delete state[conversationId]
      await persist()
      return removed
    },

    /** Drop the whole conversation (all subscriptions). */
    async clearAll(conversationId: string): Promise<void> {
      const state = await load()
      if (!(conversationId in state)) return
      delete state[conversationId]
      await persist()
    },

    async listConversations(): Promise<BindingFile> {
      return { ...(await load()) }
    },
  }
}

export type BindingStore = ReturnType<typeof createBindingStore>
