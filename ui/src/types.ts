// Types matching the design doc — shared between UI and API responses

export type WorkstreamStatus = 'active' | 'human_review' | 'blocked' | 'parked' | 'done'
export type ProgressType = 'info' | 'human_review' | 'blocked'
export type ProgressStatus = 'active' | 'dismissed'
export type SessionStatus = 'processing' | 'idle'

export interface Project {
  name: string
  path: string
}

export interface Checkpoint {
  label: string
  done: boolean
  need_human_review?: boolean
}

export interface Workstream {
  id: string
  name: string
  status: WorkstreamStatus
  project: string
  projectPath: string
  doc?: string
  checkpoints: Checkpoint[]
}

export interface AgentSession {
  name: string
  status: SessionStatus
  project: string
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
}

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: FileNode[]
}

export interface GitChange {
  path: string
  status: 'M' | 'A' | 'D' | 'U'
}
