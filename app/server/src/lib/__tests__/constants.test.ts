import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'

const originalEnv = { ...process.env }

async function loadYacoPath(env: Record<string, string | undefined>): Promise<string> {
  vi.resetModules()
  process.env = { ...originalEnv, ...env }
  const mod = await import('../constants')
  return mod.YACO_PATH
}

function writeExecutable(path: string): void {
  writeFileSync(path, '#!/usr/bin/env bash\nexit 0\n')
  chmodSync(path, 0o755)
}

describe('YACO_PATH', () => {
  afterEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
  })

  it('honors explicit YACO_PATH', async () => {
    await expect(loadYacoPath({ YACO_PATH: '/tmp/custom-yaco' })).resolves.toBe('/tmp/custom-yaco')
  })

  it('prefers the installed compiled binary over npm workspace PATH shims', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaco-path-home-'))
    const shimDir = mkdtempSync(join(tmpdir(), 'yaco-path-shim-'))
    try {
      const installedDir = join(home, '.local', 'bin')
      mkdirSync(installedDir, { recursive: true })
      const installed = join(installedDir, 'yaco')
      writeExecutable(installed)

      const shim = join(shimDir, 'yaco')
      writeFileSync(shim, '#!/usr/bin/env bun\n')
      chmodSync(shim, 0o755)

      await expect(loadYacoPath({
        HOME: home,
        YACO_PATH: undefined,
        YACO_BIN_DIR: undefined,
        PATH: `${shimDir}${delimiter}${originalEnv.PATH ?? ''}`,
      })).resolves.toBe(installed)
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(shimDir, { recursive: true, force: true })
    }
  })

  it('uses YACO_BIN_DIR when provided', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'yaco-path-bin-'))
    try {
      const installed = join(binDir, 'yaco')
      writeExecutable(installed)

      await expect(loadYacoPath({
        YACO_PATH: undefined,
        YACO_BIN_DIR: binDir,
      })).resolves.toBe(installed)
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  })
})
