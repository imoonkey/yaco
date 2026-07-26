import { describe, it, expect, vi, beforeEach } from 'vitest'

const { sdkLoginMock, initWeChatMock, isInitializedMock } = vi.hoisted(() => ({
  sdkLoginMock: vi.fn(),
  initWeChatMock: vi.fn(),
  isInitializedMock: vi.fn(() => false),
}))

vi.mock('weixin-agent-sdk', () => ({ login: sdkLoginMock }))
vi.mock('../index', () => ({
  initWeChat: initWeChatMock,
  isInitialized: isInitializedMock,
}))

/** A login nobody scans: the SDK promise simply never settles. This is the
 *  normal state of a QR on screen, and the state the deadlock lived in. */
function neverScanned(): Promise<string> {
  return new Promise<string>(() => {})
}

describe('wechat login flow cancellation', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    isInitializedMock.mockReturnValue(false)
  })

  it('leaves an unscanned login in flight, which is what stop actions must survive', async () => {
    sdkLoginMock.mockImplementation(neverScanned)
    const { startLogin, getLoginState } = await import('../login-flow')

    startLogin()
    expect(getLoginState().phase).toBe('awaiting-qr')
  })

  it('resets to idle while a login is still unscanned', async () => {
    sdkLoginMock.mockImplementation(neverScanned)
    const { startLogin, resetLoginState, getLoginState } = await import('../login-flow')

    startLogin()
    resetLoginState()

    expect(getLoginState().phase).toBe('idle')
    expect(getLoginState().qrAscii).toBeUndefined()
  })

  it('allows a fresh login after a cancel — the old flow does not hold the slot', async () => {
    sdkLoginMock.mockImplementation(neverScanned)
    const { startLogin, resetLoginState, getLoginState } = await import('../login-flow')

    startLogin()
    resetLoginState()
    startLogin()

    expect(getLoginState().phase).toBe('awaiting-qr')
    expect(sdkLoginMock).toHaveBeenCalledTimes(2)
  })

  it('a cancelled login that later succeeds must not resurrect the channel', async () => {
    let settle!: (id: string) => void
    sdkLoginMock.mockImplementation(() => new Promise<string>((r) => { settle = r }))
    const { startLogin, resetLoginState, getLoginState } = await import('../login-flow')

    startLogin()
    resetLoginState()
    // The user scans the abandoned QR anyway — the SDK resolves late.
    settle('account-1')
    await vi.waitFor(() => expect(sdkLoginMock).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 10))

    expect(getLoginState().phase).toBe('idle')
    expect(initWeChatMock).not.toHaveBeenCalled()
  })

  it('a cancelled login that later fails must not overwrite the idle state', async () => {
    let reject!: (e: Error) => void
    sdkLoginMock.mockImplementation(() => new Promise<string>((_, rj) => { reject = rj }))
    const { startLogin, resetLoginState, getLoginState } = await import('../login-flow')

    startLogin()
    resetLoginState()
    reject(new Error('qr expired'))
    await new Promise(r => setTimeout(r, 10))

    expect(getLoginState().phase).toBe('idle')
    expect(getLoginState().error).toBeUndefined()
  })

  it('a cancelled flow does not restore console.log out from under a newer one', async () => {
    sdkLoginMock.mockImplementation(neverScanned)
    const { startLogin, resetLoginState } = await import('../login-flow')

    const pristine = console.log
    startLogin()
    resetLoginState()
    startLogin()
    const activeInterceptor = console.log

    expect(activeInterceptor).not.toBe(pristine)
    resetLoginState()
    console.log = pristine
  })
})
