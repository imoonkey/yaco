import { useMemo } from 'react'
import { Folder, FolderOpen, FilePlus, FolderPlus, ChevronsDownUp } from 'lucide-react'
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
  const Icon = open ? FolderOpen : Folder
  return <Icon size={14} className="shrink-0" color="#C09553" />
}

export function NewFileIcon() {
  return <FilePlus size={14} className="shrink-0" />
}

export function CollapseAllIcon() {
  return <ChevronsDownUp size={14} className="shrink-0" />
}

export function NewFolderIcon() {
  return <FolderPlus size={14} className="shrink-0" />
}
