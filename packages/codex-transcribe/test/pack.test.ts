/** The artifact, end to end: pack it, install it into a clean project outside
 *  this checkout, and use it from there.
 *
 *  Every other test in this suite imports `../src`, where a missing packaged
 *  file, an unbuilt `dist`, or a stray import of something else in the YACO
 *  monorepo still resolves by accident — the rest of the repository is right
 *  there. This file removes the repository: `npm pack` produces exactly the
 *  bytes a consumer installs, and each assertion below is made against the
 *  installed copy from a temporary directory with no YACO above it.
 *
 *  It is a gate step (`npm run test:pack`), not just a test, because the
 *  failure it catches — a package that only works next to its own source —
 *  is invisible from a source run and fatal to the consumer.
 */
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const PACKAGE_DIR = resolve(import.meta.dirname, '..')
const REPO_ROOT = resolve(PACKAGE_DIR, '../..')
const MANIFEST = JSON.parse(
  readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'),
) as { readonly name: string; readonly version: string }

let sandbox: string
let consumer: string
let tarballEntries: string[]

/** Node, run from the consumer project, with no Codex credentials in reach:
 *  `CODEX_HOME` points at an empty directory so the batch interface answers
 *  from its own contract instead of from whatever this machine is signed into. */
function runInConsumer(program: string) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    cwd: consumer,
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: join(sandbox, 'empty-codex-home') },
    timeout: 60_000,
  })
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'codex-transcribe-pack-'))
  consumer = join(sandbox, 'consumer')
  for (const dir of ['stage', 'consumer', 'empty-codex-home']) {
    mkdirSync(join(sandbox, dir), { recursive: true })
  }
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'consumer', version: '1.0.0', type: 'module', private: true }),
  )

  const packed = spawnSync(
    'npm',
    ['pack', '--workspace', MANIFEST.name, '--pack-destination', join(sandbox, 'stage')],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 300_000 },
  )
  if (packed.status !== 0) throw new Error(`npm pack failed:\n${packed.stderr}`)

  const tarballs = readdirSync(join(sandbox, 'stage')).filter((f) => f.endsWith('.tgz'))
  expect(tarballs).toEqual([`${MANIFEST.name}-${MANIFEST.version}.tgz`])
  const tarball = join(sandbox, 'stage', tarballs[0]!)

  tarballEntries = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter(Boolean)
    .map((path) => path.replace(/^package\//, ''))

  const installed = spawnSync('npm', ['install', '--no-audit', '--no-fund', tarball], {
    cwd: consumer,
    encoding: 'utf8',
    timeout: 300_000,
  })
  if (installed.status !== 0) {
    throw new Error(`npm install of the tarball failed:\n${installed.stderr}`)
  }
}, 600_000)

afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true })
})

describe('the tarball', () => {
  it('ships the built module, its declarations, the manifest and the license', () => {
    expect(tarballEntries).toContain('dist/index.js')
    expect(tarballEntries).toContain('dist/index.d.ts')
    expect(tarballEntries).toContain('package.json')
    expect(tarballEntries).toContain('LICENSE')
  })

  it('ships no TypeScript source, tests, or scripts', () => {
    // The `development` condition points at `src/index.ts`; a consumer who sets
    // it must fail loudly rather than resolve a `.ts` file that plain Node
    // refuses under node_modules.
    expect(
      tarballEntries.filter(
        (path) =>
          path.startsWith('src/') ||
          path.startsWith('test/') ||
          path.startsWith('scripts/') ||
          (path.endsWith('.ts') && !path.endsWith('.d.ts')),
      ),
    ).toEqual([])
  })

  it('is versioned, not 0.0.0', () => {
    expect(MANIFEST.version).not.toBe('0.0.0')
  })

  it('imports nothing from the YACO monorepo', () => {
    // The whole promise of the artifact: what it needs at runtime is Node and
    // its one declared dependency. A relative import that climbs out of `dist`,
    // or a bare specifier naming another workspace, would resolve here and
    // nowhere else.
    const declared = new Set(['ws'])
    for (const entry of tarballEntries.filter((path) => path.endsWith('.js'))) {
      const source = readFileSync(join(consumer, 'node_modules', MANIFEST.name, entry), 'utf8')
      for (const [, specifier] of source.matchAll(/\bfrom\s+'([^']+)'/g)) {
        if (specifier.startsWith('node:')) continue
        if (specifier.startsWith('./')) {
          expect(specifier).toMatch(/^\.\/[\w-]+\.js$/)
          continue
        }
        expect(declared).toContain(specifier)
      }
    }
  })

  it('declares no install-time lifecycle script', () => {
    const installed = JSON.parse(
      readFileSync(join(consumer, 'node_modules', MANIFEST.name, 'package.json'), 'utf8'),
    ) as { readonly scripts?: Record<string, string> }
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
      expect(installed.scripts?.[hook]).toBeUndefined()
    }
  })
})

describe('an installed consumer with no YACO checkout', () => {
  it('exposes the status, batch, and error interface under plain Node', () => {
    const result = runInConsumer(`
      const m = await import('yaco-codex-transcribe')
      const surface = ['inspectCodexTranscribe', 'transcribeCodex', 'openCodexDictationSession', 'CodexTranscribeError']
      for (const name of surface) {
        if (typeof m[name] !== 'function') throw new Error('missing ' + name)
      }
      console.log('ok')
    `)
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('ok')
  })

  it('answers its documented contract when Codex is not signed in', () => {
    const result = runInConsumer(`
      const { inspectCodexTranscribe, transcribeCodex, CodexTranscribeError } =
        await import('yaco-codex-transcribe')
      const status = await inspectCodexTranscribe()
      let code = null
      try {
        await transcribeCodex({ audio: new Uint8Array(1), filename: 'a.wav', mimeType: 'audio/wav' })
      } catch (error) {
        if (!(error instanceof CodexTranscribeError)) throw error
        code = error.code
      }
      console.log(JSON.stringify({ status, code }))
    `)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      status: { available: false, reason: 'missing_auth' },
      code: 'not_configured',
    })
  })

  it('typechecks a consumer written against the shipped declarations', () => {
    // tsc is run from this repository because it is a build tool, not a
    // dependency of the package: the declarations, the module resolution, and
    // the `node_modules` tree under test are all the consumer's own.
    writeFileSync(
      join(consumer, 'use.ts'),
      [
        `import { inspectCodexTranscribe, transcribeCodex, CodexTranscribeError } from 'yaco-codex-transcribe'`,
        `export async function caption(audio: Uint8Array<ArrayBuffer>): Promise<string> {`,
        `  const status = await inspectCodexTranscribe()`,
        `  if (!status.available) throw new Error(status.reason)`,
        `  try {`,
        `    return await transcribeCodex({ audio, filename: 'window.wav', mimeType: 'audio/wav' })`,
        `  } catch (error) {`,
        `    if (error instanceof CodexTranscribeError) return error.code`,
        `    throw error`,
        `  }`,
        `}`,
      ].join('\n'),
    )
    writeFileSync(
      join(consumer, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'nodenext',
          moduleResolution: 'nodenext',
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ['use.ts'],
      }),
    )
    const typecheck = spawnSync(
      join(REPO_ROOT, 'node_modules', '.bin', 'tsc'),
      ['-p', join(consumer, 'tsconfig.json')],
      { cwd: consumer, encoding: 'utf8', timeout: 120_000 },
    )
    expect(typecheck.stdout).toBe('')
    expect(typecheck.status).toBe(0)
  }, 180_000)
})
