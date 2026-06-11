// Pre-boot cleanup for the isolated e2e server (run from the webServer command,
// once, before the server starts — web servers start before globalSetup).
//
// Reads YACO_HOME from the ENVIRONMENT (never a shell-interpolated path, so a
// quote/space in the path can't break `rm`) and refuses to touch anything that
// is not under the ephemeral e2e root. Wipes + recreates it for a clean slate.
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = process.env.YACO_HOME
const root = join(tmpdir(), 'yaco-e2e-home')

if (!home || !(home === root || home.startsWith(root + '/'))) {
  console.error(`[e2e preclean] refusing: YACO_HOME is not under ${root} (got: ${home ?? '<unset>'})`)
  process.exit(1)
}

rmSync(home, { recursive: true, force: true })
mkdirSync(home, { recursive: true })
