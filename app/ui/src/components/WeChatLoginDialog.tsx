import { useState, useEffect, useRef, type ComponentType } from 'react'
import { X, MessagesSquare, RefreshCw } from 'lucide-react'
import { DialogShell } from './DialogShell'
import { WeChatIcon, WhatsAppIcon } from './BrandIcons'

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
  /** Brand icon component for the dropdown row. */
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
    Icon: WeChatIcon,
    livePhases: ['awaiting-qr', 'awaiting-scan', 'authenticating'],
    qrHint: 'Scan with WeChat to complete login (enlarge the window for better scan reliability)',
  },
  whatsapp: {
    id: 'whatsapp',
    label: 'WhatsApp',
    envVar: 'WHATSAPP_ENABLED',
    Icon: WhatsAppIcon,
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
        <span className="text-ui-lg font-semibold" style={{ color: 'var(--sol-text-dark)' }}>
          {channel.label} Login
        </span>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded text-ui-2xl cursor-pointer"
          style={{ color: 'var(--sol-text)' }}
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>

      <div className="px-4 py-4 space-y-3">
        {!status && <div className="text-ui-md" style={{ color: 'var(--sol-text)' }}>Loading status…</div>}

        {status && !status.enabled && (
          <div className="text-ui-md" style={{ color: 'var(--sol-warning)' }}>
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
                <div className="text-ui-sm text-center" style={{ color: 'var(--sol-text)' }}>
                  {channel.qrHint}
                </div>
              </div>
            )}

            {isQrLive && !status.login.qrAscii && (
              <div className="text-ui-md" style={{ color: 'var(--sol-text)' }}>
                Waiting for QR…
              </div>
            )}

            {status.loggedIn && (
              <div className="text-ui-md" style={{ color: 'var(--sol-green, #859900)' }}>
                ✓ Logged in{status.login.accountId ? `: ${status.login.accountId}` : ''}
              </div>
            )}

            {status.login.error && (
              <div className="text-ui-md" style={{ color: 'var(--sol-red)' }}>
                {status.login.error}
              </div>
            )}

            {error && (
              <div className="text-ui-sm" style={{ color: 'var(--sol-red)' }}>
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
              className="text-ui-md px-3 h-8 rounded border cursor-pointer disabled:opacity-50"
              style={{ borderColor: 'var(--sol-border)', color: 'var(--sol-text)' }}
            >
              Logout
            </button>
          )}
          <button
            onClick={handleStart}
            disabled={busy || isQrLive}
            className="text-ui-md px-3 h-8 rounded border cursor-pointer flex items-center gap-1 disabled:opacity-50"
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
    <div className="flex items-center justify-between text-ui-md">
      <span style={{ color: 'var(--sol-text-faint)' }}>{label}</span>
      <span style={{ color: 'var(--sol-text)' }}>{value}</span>
    </div>
  )
}

/** Single merged header trigger for all messaging channels. Opens a dropdown
 *  to pick a channel, then shows that channel's login dialog. Renders nothing
 *  until at least one channel is enabled on the server. */
export function ChannelsHeaderButton() {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState<ChannelConfig | null>(null)
  const [statuses, setStatuses] = useState<Record<string, { enabled: boolean, loggedIn: boolean }>>({})

  const refresh = async () => {
    const entries = await Promise.all(
      Object.values(CHANNELS).map(async (c): Promise<[string, { enabled: boolean, loggedIn: boolean }]> => {
        try {
          const d = await fetchStatus(c.id)
          return [c.id, { enabled: d.enabled, loggedIn: d.loggedIn }]
        } catch {
          return [c.id, { enabled: false, loggedIn: false }]
        }
      }),
    )
    setStatuses(Object.fromEntries(entries))
  }

  // refresh() sets state only after its await — no synchronous cascading render.
  useEffect(() => { refresh() }, []) // eslint-disable-line react-hooks/set-state-in-effect

  const channels = Object.values(CHANNELS).filter(c => statuses[c.id]?.enabled)
  if (channels.length === 0) return null
  const anyLoggedIn = channels.some(c => statuses[c.id]?.loggedIn)

  return (
    <span className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        title="Messaging channels"
        aria-label="Messaging channels"
        className="chrome-icon-btn flex items-center justify-center cursor-pointer w-7 h-7 rounded"
      >
        <MessagesSquare size={15} />
      </button>
      {anyLoggedIn && (
        <span
          className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full"
          style={{ backgroundColor: 'var(--sol-green)' }}
        />
      )}
      {open && (
        <DialogShell
          onClose={() => setOpen(false)}
          overlay={false}
          animation="panel"
          className="absolute right-0 top-8 z-50 rounded-xl w-max min-w-[132px] overflow-hidden"
        >
          {channels.map(c => (
            <button
              key={c.id}
              onClick={() => { setActive(c); setOpen(false) }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-ui-md cursor-pointer hover:bg-[var(--sol-hover-bg)]"
            >
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: statuses[c.id]?.loggedIn ? 'var(--sol-green)' : 'var(--sol-text-faint)' }}
              />
              <span className="inline-flex" style={{ color: 'var(--sol-text-dim)' }}>
                <c.Icon size={14} strokeWidth={2.5} />
              </span>
              <span style={{ color: 'var(--sol-text)' }}>{c.label}</span>
            </button>
          ))}
        </DialogShell>
      )}
      {active && <ChannelLoginDialog channel={active} onClose={() => { setActive(null); refresh() }} />}
    </span>
  )
}
