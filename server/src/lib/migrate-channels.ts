import { mkdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Legacy → new path pairs for the ~/.workflow/channels/<scope>/ reorg.
 *  Run once at boot, before any channel module reads files. Idempotent. */
const LEGACY_MOVES: ReadonlyArray<{ from: string[]; to: string[] }> = [
  { from: ['wechat-qr.txt'],       to: ['channels', 'wechat',   'qr.txt']    },
  { from: ['wechat-auth.json'],    to: ['channels', 'wechat',   'auth.json']  },
  { from: ['wechat-state.json'],   to: ['channels', 'wechat',   'state.json'] },
  { from: ['whatsapp-auth.json'],  to: ['channels', 'whatsapp', 'auth.json']  },
  { from: ['whatsapp-state.json'], to: ['channels', 'whatsapp', 'state.json'] },
  { from: ['whatsapp-session'],    to: ['channels', 'whatsapp', 'session']    },
]

/** rename() races we tolerate silently:
 *   ENOENT — source disappeared between existsSync and rename (concurrent boot
 *            already moved it).
 *   EEXIST — destination appeared between existsSync and rename (concurrent
 *            boot already moved it).
 *  Anything else (EXDEV, EACCES, ENOTEMPTY, EBUSY, …) means real corruption
 *  risk: legacy file stays put while channel modules read empty new paths.
 *  Re-throw so the boot fails loudly. */
function isBenignRenameRace(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code
  return code === 'ENOENT' || code === 'EEXIST'
}

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
      if (isBenignRenameRace(err)) continue
      throw err
    }
  }
}
