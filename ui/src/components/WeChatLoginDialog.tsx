import { useState, useEffect, useRef, type ComponentType } from 'react'
import { X, MessageCircle, MessageSquare, RefreshCw } from 'lucide-react'
import { DialogShell } from './DialogShell'

interface LoginState {
  phase: string
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

interface ChannelConfig {
  /** Internal channel id used for the API base path (`/api/<id>`). */
  id: string
  /** Title shown in the dialog header and tooltip. */
  label: string
  /** Env var that must be set on the server for the dialog to be useful. */
  envVar: string
  /** Lucide icon component for the header trigger. */
  Icon: ComponentType<{ size?: number; strokeWidth?: number }>
  /** Phases to keep polling fast for (1.5s). Other phases poll every 5s. */
  livePhases: string[]
  /** Optional helper text shown under the QR (e.g. scan instructions). */
  qrHint: string
}

const CHANNELS: Record<string, ChannelConfig> = {
  wechat: {
    id: 'wechat',
    label: 'WeChat',
    envVar: 'WECHAT_ENABLED',
    Icon: MessageCircle,
    livePhases: ['awaiting-qr', 'awaiting-scan', 'authenticating'],
    qrHint: '使用微信扫描二维码完成登录（建议放大窗口以提高扫码成功率）',
  },
  whatsapp: {
    id: 'whatsapp',
    label: 'WhatsApp',
    envVar: 'WHATSAPP_ENABLED',
    Icon: MessageSquare,
    livePhases: ['awaiting-qr', 'authenticating'],
    qrHint: 'Scan with WhatsApp → Settings → Linked devices → Link a device',
  },
}

async function fetchStatus(channel: string): Promise<StatusResponse> {
  const r = await fetch(`/api/${channel}/status`)
  return r.json()
}

async function postLogin(channel: string): Promise<void> {
  await fetch(`/api/${channel}/login`, { method: 'POST' })
}

async function postLogout(channel: string): Promise<void> {
  await fetch(`/api/${channel}/logout`, { method: 'POST' })
}

function ChannelLoginDialog({ channel, onClose }: { channel: ChannelConfig, onClose: () => void }) {
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
        const data = await fetchStatus(channel.id)
        setStatus(data)
        setError(null)
        const fast = channel.livePhases.includes(data.login.phase)
        timer.current = window.setTimeout(tick, fast ? POLL_MS : 5000)
        return
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
  }, [channel])

  const handleStart = async () => {
    setBusy(true)
    try {
      await postLogin(channel.id)
      setStatus(await fetchStatus(channel.id))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const handleLogout = async () => {
    setBusy(true)
    try {
      await postLogout(channel.id)
      setStatus(await fetchStatus(channel.id))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const phase = status?.login.phase
  const isQrLive = channel.livePhases.includes(phase ?? '')

  return (
    <DialogShell onClose={onClose} className="rounded-xl w-full mx-4" style={{ maxWidth: 420 }}>
      <div
        className="flex items-center justify-between px-4 h-10"
        style={{ borderBottom: '1px solid var(--sol-tab-bg)' }}
      >
        <span className="text-[13px] font-semibold" style={{ color: 'var(--sol-text-dark)' }}>
          {channel.label} 登录 / Login
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
            {channel.envVar}=1 not set on the server. Restart with that env to use this dialog.
          </div>
        )}

        {status?.enabled && (
          <>
            <StatusRow label="Logged in" value={status.loggedIn ? 'yes' : 'no'} />
            <StatusRow label="Bot running" value={status.initialized ? 'yes' : 'no'} />
            <StatusRow label="Phase" value={phase ?? 'unknown'} />
            <StatusRow
              label="Auth mode"
              value={status.auth.mode === 'whitelist'
                ? `whitelist (${status.auth.whitelist.length})`
                : `TOFU${status.auth.tofuBound ? ` (${status.auth.tofuBound})` : ' (unbound)'}`}
            />

            {status.login.qrAscii && (
              <div className="flex flex-col items-center gap-2">
                <pre
                  aria-label={`${channel.label} login QR`}
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
                <div className="text-[11px] text-center" style={{ color: 'var(--sol-muted)' }}>
                  {channel.qrHint}
                </div>
              </div>
            )}

            {isQrLive && !status.login.qrAscii && (
              <div className="text-[12px]" style={{ color: 'var(--sol-muted)' }}>
                Waiting for QR…
              </div>
            )}

            {status.loggedIn && (
              <div className="text-[12px]" style={{ color: 'var(--sol-green, #859900)' }}>
                ✓ Logged in{status.login.accountId ? `: ${status.login.accountId}` : ''}
              </div>
            )}

            {status.login.error && (
              <div className="text-[12px]" style={{ color: 'var(--sol-red)' }}>
                {status.login.error}
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
            disabled={busy || isQrLive}
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

/** Header button + dialog for a single messaging channel. Renders nothing
 *  when the channel's env gate is unset on the server. */
function ChannelHeaderButton({ channel }: { channel: ChannelConfig }) {
  const [open, setOpen] = useState(false)
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [loggedIn, setLoggedIn] = useState(false)

  const refresh = async () => {
    try {
      const data = await fetchStatus(channel.id)
      setEnabled(data.enabled)
      setLoggedIn(data.loggedIn)
    } catch {
      setEnabled(false)
    }
  }

  useEffect(() => { refresh() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (enabled !== true) return null

  const Icon = channel.Icon

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={`${channel.label} (${loggedIn ? 'logged in' : 'not logged in'})`}
        aria-label={channel.label}
        className="inline-flex items-center justify-center rounded border p-1 cursor-pointer"
        style={{
          borderColor: 'var(--sol-border)',
          color: loggedIn ? 'var(--sol-green, #859900)' : 'var(--sol-muted)',
        }}
      >
        <Icon size={14} strokeWidth={2.5} />
      </button>
      {open && <ChannelLoginDialog channel={channel} onClose={() => { setOpen(false); refresh() }} />}
    </>
  )
}

// Public exports — kept stable so App.tsx doesn't need to know channel internals.
export const WeChatHeaderButton = () => <ChannelHeaderButton channel={CHANNELS.wechat} />
export const WhatsAppHeaderButton = () => <ChannelHeaderButton channel={CHANNELS.whatsapp} />

/** Backwards-compatible export so nothing else has to be renamed. */
export const WeChatLoginDialog = ({ onClose }: { onClose: () => void }) => (
  <ChannelLoginDialog channel={CHANNELS.wechat} onClose={onClose} />
)
