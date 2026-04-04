import { SOLARIZED_LIGHT, SOLARIZED_LIGHT_UI as C } from '../lib/solarizedLight'

// --- Shared icon colors ---
export const FILE_COLORS: Record<string, string> = {
  ts: '#3178C6', tsx: '#3178C6', js: '#CBCB41', jsx: '#CBCB41', json: SOLARIZED_LIGHT.yellow,
  md: '#519ABA', py: '#3776AB', css: '#42A5F5', scss: '#CD6799', html: '#E44D26',
  yml: '#F44D27', yaml: '#F44D27', sh: '#4EAA25', toml: '#9C4121', lock: SOLARIZED_LIGHT.base1,
  svg: '#FFB13B', txt: SOLARIZED_LIGHT.base1,
}
export const GIT_COLORS: Record<string, string> = { M: '#C4A241', U: '#73C991', A: '#73C991', D: '#C74E39' }

// --- Per-file-type badge config (inspired by vscode-icons, MIT) ---
// [background, foreground, label]
const BADGE: Record<string, [string, string, string]> = {
  ts:   ['#3178C6', '#fff', 'TS'],
  tsx:  ['#3178C6', '#fff', 'TS'],
  js:   ['#F7DF1E', '#333', 'JS'],
  jsx:  ['#F7DF1E', '#333', 'JS'],
  json: ['#BEB533', '#fff', '{}'],
  md:   ['#519ABA', '#fff', 'M'],
  css:  ['#42A5F5', '#fff', '#'],
  scss: ['#CD6799', '#fff', 'S'],
  html: ['#E44D26', '#fff', '<>'],
  py:   ['#3776AB', '#fff', 'Py'],
  sh:   ['#4EAA25', '#fff', '$'],
  yml:  ['#F44D27', '#fff', 'Y'],
  yaml: ['#F44D27', '#fff', 'Y'],
}

// --- Icons (shared with Workspace) ---
export function FileTypeIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const badge = BADGE[ext]
  if (badge) {
    const [bg, fg, label] = badge
    const fs = label.length === 1 ? 9 : 7.5
    return (
      <svg viewBox="0 0 16 16" width="14" height="14" className="shrink-0">
        <rect x="1" y="1" width="14" height="14" rx="2" fill={bg} />
        <text x="8" y="11.5" textAnchor="middle" fontSize={fs}
              fontWeight="700" fontFamily="system-ui,sans-serif" fill={fg}>{label}</text>
      </svg>
    )
  }
  const c = FILE_COLORS[ext] || C.muted
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" className="shrink-0">
      <path d="M3.5 1C2.67 1 2 1.67 2 2.5v11c0 .83.67 1.5 1.5 1.5h9c.83 0 1.5-.67 1.5-1.5V5.5L9.5 1H3.5z" fill={c} fillOpacity="0.15" stroke={c} strokeOpacity="0.5" strokeWidth="0.8" />
      <path d="M9.5 1V5.5H13" fill="none" stroke={c} strokeOpacity="0.5" strokeWidth="0.8" />
    </svg>
  )
}

export function FolderIcon({ open }: { open?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" className="shrink-0">
      {open
        ? <path d="M1.5 14h13c.28 0 .5-.22.5-.5V5H7.5L6 3.5H2c-.28 0-.5.22-.5.5v10c0 .28.22.5.5.5z" fill="#C09553" fillOpacity="0.75" />
        : <path d="M1.5 14h13c.28 0 .5-.22.5-.5V4.5c0-.28-.22-.5-.5-.5H7L5.5 2.5c-.2-.3-.5-.5-.8-.5H2c-.28 0-.5.22-.5.5v11c0 .28.22.5.5.5z" fill="#C09553" fillOpacity="0.75" />
      }
    </svg>
  )
}

export function NewFileIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" className="shrink-0">
      <path d="M9.5 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5L9.5 1z" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 7v4M6 9h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

export function NewFolderIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" className="shrink-0">
      <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h2.879a1 1 0 0 1 .707.293L8.5 3.707a1 1 0 0 0 .707.293H12.5A1.5 1.5 0 0 1 14 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-9z" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 7v4M6 9h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}
