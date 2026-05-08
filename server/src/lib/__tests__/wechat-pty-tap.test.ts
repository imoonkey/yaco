import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  stripAnsi,
  acquireTap,
  releaseTap,
  recordOffset,
  sliceFromOffset,
  waitForQuiet,
  hasTap,
  shutdownAllTaps,
  sweepStaleTaps,
} from '../channels/pty-tap'

describe('stripAnsi', () => {
  it('removes CSI sequences', () => {
    expect(stripAnsi('hello\x1b[31mworld\x1b[0m')).toBe('helloworld')
  })

  it('removes OSC sequences with BEL terminator', () => {
    expect(stripAnsi('\x1b]0;title\x07after')).toBe('after')
  })

  it('removes OSC sequences with ST terminator', () => {
    expect(stripAnsi('\x1b]0;title\x1b\\after')).toBe('after')
  })

  it('removes charset designators', () => {
    expect(stripAnsi('\x1b(Bhello')).toBe('hello')
  })

  it('removes other C0 controls but keeps \\n and \\t', () => {
    expect(stripAnsi('a\nb\tc\x07d')).toBe('a\nb\tc d'.replace(' d', 'd'))
  })

  it('passes through plain text', () => {
    expect(stripAnsi('plain text 123')).toBe('plain text 123')
  })
})

const tmuxAvailable = (() => {
  try {
    const r = spawnSync('tmux', ['-V'])
    return r.status === 0
  } catch { return false }
})()

const testIfTmux = tmuxAvailable ? it : it.skip

describe('pty-tap (real tmux)', () => {
  let sessionName = ''

  beforeEach(async () => {
    await shutdownAllTaps()
    sessionName = `wf-tap-test-${process.pid}-${Date.now()}`
    spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' })
  })

  afterAll(async () => {
    await shutdownAllTaps()
    if (sessionName) spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' })
  })

  testIfTmux('captures pane output through tap', async () => {
    spawnSync('tmux', ['new-session', '-d', '-s', sessionName, '-x', '80', '-y', '24',
      'sleep 0.3; for i in 1 2 3 4 5; do echo line $i; sleep 0.2; done; sleep 5'])

    await acquireTap(sessionName)
    expect(hasTap(sessionName)).toBe(true)

    // Wait for the script's burst to flow through
    await new Promise(r => setTimeout(r, 2000))

    const offset = recordOffset(sessionName)
    expect(offset).toBeGreaterThan(0)

    const slice = sliceFromOffset(sessionName, 0)
    expect(slice.text).toMatch(/line 5/)
    expect(slice.truncated).toBe(false)

    await releaseTap(sessionName)
    expect(hasTap(sessionName)).toBe(false)

    spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' })
  }, 10_000)

  testIfTmux('refCounts when acquired twice', async () => {
    spawnSync('tmux', ['new-session', '-d', '-s', sessionName, '-x', '80', '-y', '24', 'sleep 30'])

    await acquireTap(sessionName)
    await acquireTap(sessionName)
    expect(hasTap(sessionName)).toBe(true)

    await releaseTap(sessionName)
    // Still held by second reference
    expect(hasTap(sessionName)).toBe(true)

    await releaseTap(sessionName)
    expect(hasTap(sessionName)).toBe(false)

    spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' })
  }, 10_000)

  testIfTmux('waitForQuiet returns when buffer stops growing', async () => {
    spawnSync('tmux', ['new-session', '-d', '-s', sessionName, '-x', '80', '-y', '24',
      'echo burst1; echo burst2; sleep 30'])

    await acquireTap(sessionName)
    const result = await waitForQuiet(sessionName, { quietMs: 500, timeoutMs: 3000, pollMs: 100 })
    expect(result.quiet).toBe(true)

    await releaseTap(sessionName)
    spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' })
  }, 8_000)

  testIfTmux('acquire fails for nonexistent tmux session', async () => {
    await expect(acquireTap('definitely-not-a-real-session-xyz')).rejects.toThrow()
  })

  testIfTmux('sweepStaleTaps unlinks orphan fifos', async () => {
    const orphan = join(tmpdir(), `wf-wechat-tap-orphan-${process.pid}.fifo`)
    spawnSync('mkfifo', [orphan])
    sweepStaleTaps()
    expect(existsSync(orphan)).toBe(false)
  })
})
