import { createContext } from 'react'
import type { ContextMenuHandlers } from './Menu'

// --- Context for passing data to the file-tree node renderer ---

export const ExplorerContext = createContext<{
  gitMap: Map<string, string>
  gitFolders: Set<string>
  bindContextMenu: (path: string, type: 'file' | 'dir') => ContextMenuHandlers
  reportContextFolder: (path: string, type: 'file' | 'dir') => void
  onPreviewFile?: (path: string) => void
  onPinFile?: (path: string) => void
  onExpandDir?: (path: string) => void
  pendingNewId: string | null
  cancelCreate: () => void
}>({ gitMap: new Map(), gitFolders: new Set(), bindContextMenu: () => ({ onContextMenu: () => {}, onTouchStart: () => {}, onTouchMove: () => {}, onTouchEnd: () => {}, onTouchCancel: () => {} }), reportContextFolder: () => {}, pendingNewId: null, cancelCreate: () => {} })
