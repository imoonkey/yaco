import { useMemo } from 'react'
import { getIcon } from '../lib/setiIcons'

// --- Git status colors ---
export const GIT_COLORS: Record<string, string> = { M: '#C4A241', U: '#73C991', A: '#73C991', D: '#C74E39' }

// --- Seti color name to hex (VS Code Seti icon theme, light background) ---
const SETI_COLORS: Record<string, string> = {
  blue: '#498ba7', grey: '#808080', 'grey-light': '#808080',
  'medium-blue': '#498ba7', 'dark-blue': '#2d5f7b',
  red: '#cc3e44', 'light-red': '#cc3e44',
  green: '#7fae42', 'medium-green': '#6a9e37',
  orange: '#cc6d2e', yellow: '#b7b73b', purple: '#9068b0',
  pink: '#c54b7b', white: '#808080', ignore: '#808080',
}

const svgCache = new Map<string, { svg: string; color: string }>()

function getSetiIcon(name: string): { svg: string; color: string } {
  const cached = svgCache.get(name)
  if (cached) return cached
  const result = getIcon(name)
  const entry = { svg: result.svg, color: SETI_COLORS[result.color] || 'var(--sol-muted)' }
  svgCache.set(name, entry)
  return entry
}

// --- Icons (shared with Workspace) ---
export function FileTypeIcon({ name }: { name: string }) {
  const { svg, color } = useMemo(() => getSetiIcon(name), [name])
  const colored = svg.replace('<svg ', `<svg width="16" height="16" style="fill:${color}" `)
  return <span className="shrink-0 inline-flex" dangerouslySetInnerHTML={{ __html: colored }} />
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

export function CollapseAllIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" className="shrink-0">
      <path d="M3 10l5-4 5 4M3 14l5-4 5 4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
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
