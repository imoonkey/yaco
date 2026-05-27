import { mkdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { channelsDir } from './yacoHome'

/** Legacy → new path moves for the channels/<scope>/ reorg.
 *  Run once at boot, before any channel module reads files. Idempotent.
 *
 *  The legacy source is the historical `~/.workflow/` flat layout (pre-channels
 *  reorg). The destination is the canonical YACO channels root
 *  (`${YACO_HOME}/channels/<scope>/`). */
const LEGACY_FILES: ReadonlyArray<{ legacy: string; scope: string; name: string[] }> = [
  { legacy: 'wechat-qr.txt',       scope: 'wechat',   name: ['qr.txt']     },
  { legacy: 'wechat-auth.json',    scope: 'wechat',   name: ['auth.json']  },
  { legacy: 'wechat-state.json',   scope: 'wechat',   name: ['state.json'] },
  { legacy: 'whatsapp-auth.json',  scope: 'whatsapp', name: ['auth.json']  },
  { legacy: 'whatsapp-state.json', scope: 'whatsapp', name: ['state.json'] },
  { legacy: 'whatsapp-session',    scope: 'whatsapp', name: ['session']    },
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
  const legacyDir = join(homedir(), '.workflow')
  if (!existsSync(legacyDir)) return

  const channels = channelsDir()
  await mkdir(join(channels, 'wechat'),   { recursive: true })
  await mkdir(join(channels, 'whatsapp'), { recursive: true })

  for (const move of LEGACY_FILES) {
    const src = join(legacyDir, move.legacy)
    const dst = join(channels, move.scope, ...move.name)
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
