import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface Binding {
  project: string
  session: string
  boundAt: string
}

export type BindingFile = Record<string, Binding>

/** Per-channel binding store backed by ~/.workflow/channels/<scope>/state.json.
 *  Module-private cache + serialized writes to avoid concurrent fs races. */
export function createBindingStore(scope: string) {
  const scopeDir = join(homedir(), '.workflow', 'channels', scope)
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
    async getBinding(conversationId: string): Promise<Binding | undefined> {
      return (await load())[conversationId]
    },
    async setBinding(conversationId: string, binding: Binding): Promise<void> {
      const state = await load()
      state[conversationId] = binding
      await persist()
    },
    async clearBinding(conversationId: string): Promise<void> {
      const state = await load()
      if (!(conversationId in state)) return
      delete state[conversationId]
      await persist()
    },
    async listBindings(): Promise<BindingFile> {
      return { ...(await load()) }
    },
  }
}

export type BindingStore = ReturnType<typeof createBindingStore>
