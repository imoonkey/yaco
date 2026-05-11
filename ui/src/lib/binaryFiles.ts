import { API, appendWorktree } from '../hooks/useApi'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp'])
const PDF_EXTS = new Set(['.pdf'])
const HTML_EXTS = new Set(['.html', '.htm'])
const MARKDOWN_EXTS = new Set(['.md', '.markdown'])

function getExt(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(dot).toLowerCase()
}

export function isImageFile(path: string): boolean {
  return IMAGE_EXTS.has(getExt(path))
}

export function isPdfFile(path: string): boolean {
  return PDF_EXTS.has(getExt(path))
}

export function isHtmlFile(path: string): boolean {
  return HTML_EXTS.has(getExt(path))
}

export function isMarkdownFile(path: string): boolean {
  return MARKDOWN_EXTS.has(getExt(path))
}

export function isBinaryPreviewFile(path: string): boolean {
  return isImageFile(path) || isPdfFile(path)
}

export function isPreviewableFile(path: string): boolean {
  return isMarkdownFile(path) || isHtmlFile(path)
}

export function rawFileUrl(project: string, path: string, worktree?: string | null): string {
  return `${API}${appendWorktree(
    `/files/${encodeURIComponent(project)}/raw?path=${encodeURIComponent(path)}`,
    worktree,
  )}`
}
