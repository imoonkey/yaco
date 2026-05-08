import { useState, useEffect, useRef } from 'react'
import { X, MessageCircle, RefreshCw } from 'lucide-react'
import { DialogShell } from './DialogShell'

type LoginPhase = 'idle' | 'awaiting-qr' | 'awaiting-scan' | 'logged-in' | 'failed'

interface LoginState {
  phase: LoginPhase
  qrAscii?: string
  accountId?: string
  error?: string
}

interface StatusResponse {
  enabled: boolean
  initialized: boolean
  loggedIn: boolean
  auth: { mode: 'whitelist' | 'tofu', whitelist: string[], tofuBound: string | null }
  login: LoginState
}

const POLL_MS = 1500

async function fetchStatus(): Promise<StatusResponse> {
  const r = await fetch('/api/wechat/status')
  return r.json()
}

async function postLogin(): Promise<void> {
  await fetch('/api/wechat/login', { method: 'POST' })
}

async function postLogout(): Promise<void> {
  await fetch('/api/wechat/logout', { method: 'POST' })
}

export function WeChatLoginDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const cancelled = useRef(false)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    cancelled.current = false
    const tick = async () => {
      if (cancelled.current) return
      try {
        const data = await fetchStatus()
        setStatus(data)
        setError(null)
        const phase = data.login.phase
        if (phase === 'logged-in' || phase === 'failed' || phase === 'idle') {
          // Slow down once terminal — still poll for late state changes
          timer.current = window.setTimeout(tick, 5000)
          return
        }
      } catch (e) {
        setError((e as Error).message)
      }
      timer.current = window.setTimeout(tick, POLL_MS)
    }
    tick()
    return () => {
      cancelled.current = true
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [])

  const handleStart = async () => {
    setBusy(true)
    try {
      await postLogin()
      setStatus(await fetchStatus())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const handleLogout = async () => {
    setBusy(true)
    try {
      await postLogout()
      setStatus(await fetchStatus())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell onClose={onClose} className="rounded-xl w-full mx-4" style={{ maxWidth: 420 }}>
      <div
        className="flex items-center justify-between px-4 h-10"
        style={{ borderBottom: '1px solid var(--sol-tab-bg)' }}
      >
        <span className="text-[13px] font-semibold" style={{ color: 'var(--sol-text-dark)' }}>
          WeChat 登录
        </span>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded text-[16px] cursor-pointer"
          style={{ color: 'var(--sol-muted)' }}
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>

      <div className="px-4 py-4 space-y-3">
        {!status && <div className="text-[12px]" style={{ color: 'var(--sol-muted)' }}>Loading status…</div>}

        {status && !status.enabled && (
          <div className="text-[12px]" style={{ color: 'var(--sol-warning)' }}>
            WECHAT_ENABLED=1 not set on the server. Restart with that env to use this dialog.
          </div>
        )}

        {status?.enabled && (
          <>
            <StatusRow label="Logged in" value={status.loggedIn ? 'yes' : 'no'} />
            <StatusRow label="Bot running" value={status.initialized ? 'yes' : 'no'} />
            <StatusRow
              label="Auth mode"
              value={status.auth.mode === 'whitelist'
                ? `whitelist (${status.auth.whitelist.length})`
                : `TOFU${status.auth.tofuBound ? ` (${status.auth.tofuBound})` : ' (unbound)'}`}
            />

            {status.login.phase === 'awaiting-qr' && status.login.qrAscii && (
              <div className="flex flex-col items-center gap-2">
                <pre
                  aria-label="WeChat login QR"
                  className="rounded border p-2"
                  style={{
                    borderColor: 'var(--sol-border)',
                    backgroundColor: 'var(--sol-bg)',
                    color: 'var(--sol-text)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 8,
                    lineHeight: 1,
                    margin: 0,
                  }}
                >{status.login.qrAscii}</pre>
                <div className="text-[11px]" style={{ color: 'var(--sol-muted)' }}>
                  使用微信扫描二维码完成登录（建议放大窗口以提高扫码成功率）
                </div>
              </div>
            )}

            {status.login.phase === 'awaiting-qr' && !status.login.qrAscii && (
              <div className="text-[12px]" style={{ color: 'var(--sol-muted)' }}>
                Waiting for QR…
              </div>
            )}

            {status.login.phase === 'awaiting-scan' && (
              <div className="text-[12px]" style={{ color: 'var(--sol-text)' }}>
                已扫描，等待手机端确认…
              </div>
            )}

            {status.login.phase === 'logged-in' && (
              <div className="text-[12px]" style={{ color: 'var(--sol-green, #859900)' }}>
                ✓ 已登录: {status.login.accountId}
              </div>
            )}

            {status.login.phase === 'failed' && (
              <div className="text-[12px]" style={{ color: 'var(--sol-red)' }}>
                登录失败: {status.login.error}
              </div>
            )}

            {error && (
              <div className="text-[11px]" style={{ color: 'var(--sol-red)' }}>
                {error}
              </div>
            )}
          </>
        )}
      </div>

      {status?.enabled && (
        <div
          className="flex items-center justify-end gap-2 px-4 h-12"
          style={{ borderTop: '1px solid var(--sol-tab-bg)' }}
        >
          {status.loggedIn && (
            <button
              onClick={handleLogout}
              disabled={busy}
              className="text-[12px] px-3 h-8 rounded border cursor-pointer disabled:opacity-50"
              style={{ borderColor: 'var(--sol-border)', color: 'var(--sol-text)' }}
            >
              Logout
            </button>
          )}
          <button
            onClick={handleStart}
            disabled={busy || status.login.phase === 'awaiting-qr' || status.login.phase === 'awaiting-scan'}
            className="text-[12px] px-3 h-8 rounded border cursor-pointer flex items-center gap-1 disabled:opacity-50"
            style={{ borderColor: 'var(--sol-border)', color: 'var(--sol-text)' }}
          >
            <RefreshCw size={12} />
            {status.loggedIn ? 'Re-scan' : 'Start QR login'}
          </button>
        </div>
      )}
    </DialogShell>
  )
}

function StatusRow({ label, value }: { label: string, value: string }) {
  return (
    <div className="flex items-center justify-between text-[12px]">
      <span style={{ color: 'var(--sol-muted)' }}>{label}</span>
      <span style={{ color: 'var(--sol-text)' }}>{value}</span>
    </div>
  )
}

/** Header trigger button — only renders when `WECHAT_ENABLED` is set on the server.
 *  Single-flight status fetch on mount; re-fetch on dialog close to refresh badge. */
export function WeChatHeaderButton() {
  const [open, setOpen] = useState(false)
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [loggedIn, setLoggedIn] = useState(false)

  const refresh = async () => {
    try {
      const r = await fetch('/api/wechat/status')
      const data: StatusResponse = await r.json()
      setEnabled(data.enabled)
      setLoggedIn(data.loggedIn)
    } catch {
      setEnabled(false)
    }
  }

  useEffect(() => { refresh() }, [])

  if (enabled !== true) return null

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={loggedIn ? 'WeChat (logged in)' : 'WeChat (not logged in)'}
        aria-label="WeChat"
        className="inline-flex items-center justify-center rounded border p-1 cursor-pointer"
        style={{
          borderColor: 'var(--sol-border)',
          color: loggedIn ? 'var(--sol-green, #859900)' : 'var(--sol-muted)',
        }}
      >
        <MessageCircle size={14} strokeWidth={2.5} />
      </button>
      {open && <WeChatLoginDialog onClose={() => { setOpen(false); refresh() }} />}
    </>
  )
}
