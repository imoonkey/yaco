import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { WHATSAPP_MISSING_DEPENDENCY } from '../load'

const execFileAsync = promisify(execFile)

const SERVER_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

/** Runs a probe in a fresh process against a throwaway YACO_HOME — where no
 *  channel is switched on, since an absent enabled.json reads as all-off. */
async function runProbe(
  name: string,
  { args = [], env = {} }: { args?: string[]; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string }> {
  const home = await mkdtemp(join(tmpdir(), 'whatsapp-lazy-'))
  try {
    return await execFileAsync(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL(`./${name}`, import.meta.url)), ...args],
      { cwd: SERVER_ROOT, env: { ...process.env, YACO_HOME: home, ...env }, timeout: 90_000 },
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

/** Probes report one JSON object on the last stdout line. */
function probeResult<T>(stdout: string): T {
  return JSON.parse(stdout.trim().split('\n').at(-1) as string) as T
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe('whatsapp-web.js is loaded lazily', () => {
  it('stays out of the module registry when the channel is off, and loads on demand', async () => {
    const port = await freePort()
    const { stdout } = await runProbe('boot-probe.ts', { env: { WORKFLOW_PORT: String(port) } })
    const probe = probeResult<{
      afterBoot: string[]
      afterLoad: string[]
      constructors: string[]
    }>(stdout)

    expect(probe.afterBoot).toEqual([])
    // Same process, one loadWweb() later: the deferred import resolves the real
    // package, puppeteer and all — the graph was skipped, not broken.
    expect(probe.afterLoad).toEqual(['whatsapp-web.js', 'puppeteer', 'puppeteer-core'])
    expect(probe.constructors).toEqual(['Client', 'LocalAuth', 'MessageMedia'])
  }, 120_000)

  it('reports an actionable install command when the optional dependency is absent', async () => {
    const { stdout, stderr } = await runProbe('missing-dep-probe.ts')
    const probe = probeResult<{
      login: { phase: string; error?: string; ready: boolean }
      initialized: boolean
    }>(stdout)

    expect(probe.login.phase).toBe('failed')
    expect(probe.login.ready).toBe(false)
    expect(probe.initialized).toBe(false)
    expect(probe.login.error).toBe(WHATSAPP_MISSING_DEPENDENCY)
    expect(WHATSAPP_MISSING_DEPENDENCY).toContain('npm install --workspace app/server whatsapp-web.js')

    // The operator sees one actionable line, not a rejected promise's stack.
    expect(stderr).toContain(`[whatsapp] ${WHATSAPP_MISSING_DEPENDENCY}`)
    expect(stderr).not.toMatch(/^\s+at /m)
  }, 60_000)

})

interface LifecycleResult {
  constructed: number
  initialized: number
  destroyed: number
  log: string[]
  sessionDirAtStart: boolean[]
  sessionDirExists: boolean
  tofuBound: string | null
  login: { phase: string; ready: boolean }
  isInitialized: boolean
}

const lifecycle = async (mode: string): Promise<LifecycleResult> =>
  probeResult<LifecycleResult>((await runProbe('lifecycle-probe.ts', { args: [mode] })).stdout)

describe('a stop wins against the start it races', () => {
  // The load is the one window where a start is running but `client` is not yet
  // published, so a stop arriving in it has nothing to destroy.
  it.each(['shutdown', 'logout'])('%s during the load leaves no browser behind', async (stop) => {
    const probe = await lifecycle(`${stop}-during-load`)

    expect(probe.constructed).toBe(0)
    expect(probe.initialized).toBe(0)
    expect(probe.isInitialized).toBe(false)
    expect(probe.login).toMatchObject({ phase: 'idle', ready: false })
  }, 60_000)

  it('ignores a torn-down client that keeps emitting', async () => {
    const probe = await lifecycle('ghost-event')

    // destroy() is asynchronous, so a `ready` fired during and after it must not
    // resurrect a channel the user switched off.
    expect(probe.login).toMatchObject({ phase: 'idle', ready: false })
    expect(probe.isInitialized).toBe(false)
  }, 60_000)

  it.each(['shutdown', 'logout'])(
    'restarts after a %s finishes releasing, not before',
    async (stop) => {
      const probe = await lifecycle(`restart-during-${stop}`)

      // The restart owns the channel; the stop unwinding behind it writes nothing.
      expect(probe.isInitialized).toBe(true)
      expect(probe.login.phase).toBe('awaiting-qr')
      expect(probe.constructed).toBe(2)
      expect(probe.initialized).toBe(2)
      // Ownership flips at once, but the replacement reuses the previous
      // session's browser profile directory, so it must wait for the release.
      expect(probe.log).toEqual(['construct#1', 'destroy#1:start', 'destroy#1:end', 'construct#2'])
    },
    60_000,
  )

  it('never lets logout delete the session directory of the session that replaced it', async () => {
    const probe = await lifecycle('restart-during-logout')

    // The replacement opened the profile only after logout had already wiped
    // it — the inverse ordering is what would delete a live profile.
    expect(probe.sessionDirAtStart).toEqual([true, false])
  }, 60_000)

  it('does not carry the previous session readiness over to its replacement', async () => {
    const probe = await lifecycle('stale-readiness')

    // The replacement has not emitted `ready`, so a message reaching it must be
    // ignored — not TOFU-bound and not answered on a half-built session.
    expect(probe.login).toMatchObject({ phase: 'awaiting-qr', ready: false })
    expect(probe.log).not.toContain('replied')
    expect(probe.tofuBound).toBeNull()
  }, 60_000)
})
