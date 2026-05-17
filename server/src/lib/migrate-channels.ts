import { mkdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Legacy → new path pairs for the ~/.workflow/channels/<scope>/ reorg.
 *  Run once at boot, before any channel module reads files. Idempotent. */
const LEGACY_MOVES: ReadonlyArray<{ from: string[]; to: string[] }> = [
  { from: ['wechat-qr.txt'],       to: ['channels', 'wechat',   'qr.txt']   },
  { from: ['whatsapp-auth.json'],  to: ['channels', 'whatsapp', 'auth.json']  },
  { from: ['whatsapp-state.json'], to: ['channels', 'whatsapp', 'state.json'] },
  { from: ['whatsapp-session'],    to: ['channels', 'whatsapp', 'session']    },
]

export async function migrateLegacyChannelPaths(): Promise<void> {
  const workflowDir = join(homedir(), '.workflow')
  if (!existsSync(workflowDir)) return

  const channelsDir = join(workflowDir, 'channels')
  await mkdir(join(channelsDir, 'wechat'),   { recursive: true })
  await mkdir(join(channelsDir, 'whatsapp'), { recursive: true })

  for (const move of LEGACY_MOVES) {
    const src = join(workflowDir, ...move.from)
    const dst = join(workflowDir, ...move.to)
    if (!existsSync(src)) continue
    if (existsSync(dst)) continue
    try {
      await rename(src, dst)
      console.log(`[migrate-channels] ${src} → ${dst}`)
    } catch (err) {
      console.warn(`[migrate-channels] failed to migrate ${src}:`, err)
    }
  }
}
