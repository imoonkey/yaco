import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { channelsDir } from 'yaco-cli/core/paths'

export const CHANNEL_IDS = ['wechat', 'whatsapp'] as const
export type ChannelId = typeof CHANNEL_IDS[number]

export type ChannelEnabledMap = Record<ChannelId, boolean>

function enabledFile(): string {
  return join(channelsDir(), 'enabled.json')
}

function allDisabled(): ChannelEnabledMap {
  return { wechat: false, whatsapp: false }
}

export function isChannelId(value: string): value is ChannelId {
  return (CHANNEL_IDS as readonly string[]).includes(value)
}

/** Which channels the user has switched on, from
 *  `${YACO_HOME}/channels/enabled.json`. A channel boots a browser or an SDK
 *  connection and holds it for the process lifetime, so an absent, unreadable,
 *  or malformed file means OFF — never a surprise connection on a fresh
 *  machine or in a test's throwaway YACO_HOME. */
export function readChannelEnabled(): ChannelEnabledMap {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(enabledFile(), 'utf-8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('[channels] failed to read enabled.json, treating all channels as off:', e)
    }
    return allDisabled()
  }

  const map = allDisabled()
  if (parsed && typeof parsed === 'object') {
    for (const id of CHANNEL_IDS) {
      map[id] = (parsed as Record<string, unknown>)[id] === true
    }
  }
  return map
}

export function isChannelEnabled(id: ChannelId): boolean {
  return readChannelEnabled()[id]
}

/** Persist one channel's switch. Read-modify-write so toggling one channel
 *  never clears the other; temp + rename so a crash mid-write cannot leave a
 *  truncated file that would read back as "everything off". */
export function setChannelEnabled(id: ChannelId, enabled: boolean): ChannelEnabledMap {
  const next = { ...readChannelEnabled(), [id]: enabled }
  const path = enabledFile()
  const tmpPath = `${path}.${process.pid}.tmp`
  mkdirSync(channelsDir(), { recursive: true })
  writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
  renameSync(tmpPath, path)
  return next
}
