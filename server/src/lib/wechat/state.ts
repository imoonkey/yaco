import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface WeChatBinding {
  project: string
  session: string
  boundAt: string
}

export type WeChatStateFile = Record<string, WeChatBinding>

const WORKFLOW_DIR = join(homedir(), '.workflow')
const STATE_FILE = join(WORKFLOW_DIR, 'wechat-state.json')

let cache: WeChatStateFile | null = null
let writeChain: Promise<void> = Promise.resolve()

async function ensureDir(): Promise<void> {
  if (!existsSync(WORKFLOW_DIR)) await mkdir(WORKFLOW_DIR, { recursive: true })
}

async function load(): Promise<WeChatStateFile> {
  if (cache) return cache
  if (!existsSync(STATE_FILE)) {
    cache = {}
    return cache
  }
  try {
    const raw = await readFile(STATE_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as WeChatStateFile
    cache = parsed && typeof parsed === 'object' ? parsed : {}
  } catch (e) {
    console.warn('[wechat] failed to read state file, starting empty:', e)
    cache = {}
  }
  return cache
}

function persist(): Promise<void> {
  // Serialize writes — multiple binds firing in parallel must not race writeFile.
  writeChain = writeChain.then(async () => {
    if (!cache) return
    await ensureDir()
    await writeFile(STATE_FILE, JSON.stringify(cache, null, 2), 'utf-8')
  })
  return writeChain
}

export async function getBinding(conversationId: string): Promise<WeChatBinding | undefined> {
  return (await load())[conversationId]
}

export async function setBinding(conversationId: string, binding: WeChatBinding): Promise<void> {
  const state = await load()
  state[conversationId] = binding
  await persist()
}

export async function clearBinding(conversationId: string): Promise<void> {
  const state = await load()
  if (!(conversationId in state)) return
  delete state[conversationId]
  await persist()
}

export async function listBindings(): Promise<WeChatStateFile> {
  return { ...(await load()) }
}
