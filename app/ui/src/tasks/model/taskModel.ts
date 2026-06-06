// V2 task types + normalizer
// Backward compatible: V1 tasks.json works without any new fields

import type { TaskState, RawTaskEntry, Priority } from '../taskGraphModel'
import { normalizeAgents } from '../taskGraphModel'

export type { TaskState, Priority } from '../taskGraphModel'

export type Estimate = 'xs' | 's' | 'm' | 'l' | 'xl'
export type BlockReason = 'verification-failed' | 'human-review' | 'external' | 'dependency'
export type Workset = 'active' | 'backlog' | 'archive'

export type WorktreeStatus = {
  active: boolean
  dirty: boolean
  branch: string
  ahead: number
  behind: number
}

/** Raw V2 task as stored in tasks.json — extends V1 with optional fields */
export type RawTaskV2 = RawTaskEntry & {
  worktree?: string | null
  worktreeStatus?: WorktreeStatus
  priority?: Priority
  agent?: string | null
  agents?: string[]
  tags?: string[]
  created?: string
  updated?: string
  estimate?: Estimate
  blockReason?: BlockReason
  design?: string | null
  resources?: string | string[]
  requireHumanReview?: boolean
  workset?: Workset
}

/** Normalized V2 task — all fields present with defaults */
export type TaskV2 = {
  id: string
  title: string
  description: string | null
  parent: string | null
  depends: string[]
  state: TaskState
  scope: string[]
  acceptCriteria: string[]
  note: string | null
  priority: Priority
  agents: string[]
  tags: string[]
  created: string | null
  updated: string | null
  estimate: Estimate | null
  blockReason: BlockReason | null
  design: string | null
  resources: string[]
  requireHumanReview: boolean
  worktree: string | null
  worktreeStatus: WorktreeStatus | null
  workset: Workset
}

function parseAcceptCriteria(raw: string | string[] | undefined): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  return raw
    .split('\n')
    .map(line => line.replace(/^[-\s]*[☐☑]\s*/, '').replace(/^-\s*/, '').trim())
    .filter(Boolean)
}

export function normalizeTask(id: string, raw: RawTaskV2): TaskV2 {
  return {
    id,
    title: raw.title,
    description: raw.description ?? null,
    parent: raw.parent ?? null,
    depends: raw.depends ?? [],
    state: raw.state ?? 'ready',
    scope: raw.scope ?? [],
    acceptCriteria: parseAcceptCriteria(raw.acceptCriteria),
    note: raw.note ?? null,
    priority: raw.priority ?? 'normal',
    agents: normalizeAgents(raw),
    tags: raw.tags ?? [],
    created: raw.created ?? null,
    updated: raw.updated ?? null,
    estimate: raw.estimate ?? null,
    blockReason: raw.blockReason ?? null,
    design: raw.design ?? null,
    resources: Array.isArray(raw.resources) ? raw.resources : raw.resources ? [raw.resources] : [],
    requireHumanReview: raw.requireHumanReview ?? false,
    worktree: raw.worktree ?? null,
    worktreeStatus: raw.worktreeStatus ?? null,
    workset: raw.workset ?? 'active',
  }
}

export function normalizeTaskMap(raw: Record<string, RawTaskV2>): Map<string, TaskV2> {
  const map = new Map<string, TaskV2>()
  for (const [id, entry] of Object.entries(raw)) {
    map.set(id, normalizeTask(id, entry))
  }
  return map
}
