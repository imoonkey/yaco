// Types matching the design doc — shared between UI and API responses

export type ProgressType = 'info' | 'human_review' | 'blocked' | 'session_idle'
export type ProgressStatus = 'active' | 'dismissed'
export type SessionStatus = 'starting' | 'processing' | 'idle'
export type SessionProvider = 'claude' | 'codex' | 'shell'

export interface Project {
  name: string
  path: string
}

export interface AgentSession {
  name: string
  provider: SessionProvider
  status: SessionStatus
  project: string
  summary: string
  worktree?: string
}

export interface ProgressEntry {
  id: string
  agent: 'claude' | 'codex'
  type: ProgressType
  message: string
  timestamp: string
  status: ProgressStatus
  project: string
  workstream: string
  sessionName?: string
}

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: FileNode[]
  gitignored?: boolean
}

export interface GitChange {
  path: string
  status: 'M' | 'A' | 'D' | 'U'
}

export interface HistorySession {
  id: string
  provider: 'claude' | 'codex'
  title: string | null
  summary: string
  created: string
  modified: string
  messageCount: number | null
  gitBranch: string | null
  liveSessionName: string | null
}
