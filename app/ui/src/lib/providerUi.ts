// Browser presentation policy keyed by provider. This is a UI-local superset of
// the CLI provider catalog: it also carries `shell` and a generic terminal
// fallback, neither of which is a CLI agent provider. It governs only what xterm
// renders to a human — icons, contrast floors, and OSC suppression — never
// detached-runtime behaviour, which the CLI provider config owns.
export type ProviderIconKey = 'claude' | 'codex' | 'terminal' | 'gemini' | 'cursor'

export interface ProviderUiConfig {
  id: string
  label: string
  icon: ProviderIconKey
  terminal: {
    // Codex renders prose in a light gray that washes out against the editor
    // background, so it gets a high contrast floor; others render fine at 1.
    minimumContrastRatio: number
    // app/server answers Codex OSC 10/11/12 color queries at the PTY bridge.
    // Keep Codex pass-through as a fallback; Claude/shell queries are swallowed
    // browser-side to avoid visible echoed color reports.
    suppressOscColorReportQuery: boolean
    inputPromptFrame?: TerminalInputPromptFrame
  }
  canStart: boolean
}

export interface TerminalInputPromptFrame {
  promptPattern: RegExp
  continuationPattern?: RegExp
  maxRows: number
  lineWidth: number
  topPadding: number
  bottomPadding: number
}

// Single source of truth for provider presentation. Adding a provider here is the
// only edit needed for icons, terminal policy, and the startable controls below.
const PROVIDER_UI = {
  claude: {
    id: 'claude',
    label: 'Claude',
    icon: 'claude',
    terminal: { minimumContrastRatio: 1, suppressOscColorReportQuery: true },
    canStart: true,
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    icon: 'codex',
    terminal: {
      minimumContrastRatio: 5,
      suppressOscColorReportQuery: false,
      inputPromptFrame: { promptPattern: /^›/, continuationPattern: /^\s{2,}/, maxRows: 24, lineWidth: 2, topPadding: 19, bottomPadding: 19 },
    },
    canStart: true,
  },
  shell: {
    id: 'shell',
    label: 'Shell',
    icon: 'terminal',
    terminal: { minimumContrastRatio: 1, suppressOscColorReportQuery: true },
    canStart: true,
  },
} satisfies Record<string, ProviderUiConfig>

type ProviderId = keyof typeof PROVIDER_UI

const FALLBACK_PROVIDER_UI: ProviderUiConfig = {
  id: 'terminal',
  label: 'Terminal',
  icon: 'terminal',
  terminal: { minimumContrastRatio: 1, suppressOscColorReportQuery: false },
  canStart: false,
}

// Unknown provider ids fall back to the generic terminal entry so live/history
// sessions for not-yet-configured providers still render.
export function getProviderUi(provider?: string | null): ProviderUiConfig {
  if (!provider) return FALLBACK_PROVIDER_UI
  return (PROVIDER_UI as Record<string, ProviderUiConfig>)[provider] ?? FALLBACK_PROVIDER_UI
}

// Providers the session-creation controls may launch, in display order.
export const startableProviders: ProviderId[] = (Object.keys(PROVIDER_UI) as ProviderId[]).filter(
  (id) => PROVIDER_UI[id].canStart,
)
