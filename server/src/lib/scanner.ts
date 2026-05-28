import type { Project } from './projects'
import { readEvents, type YacoEvent } from './eventsLog'

export type ProgressType = 'info' | 'human_review' | 'blocked' | 'session_idle'
export type ProgressStatus = 'active' | 'dismissed'

export interface ProgressEntry {
  id: string
  agent: 'claude' | 'codex'
  type: ProgressType
  message: string
  timestamp: string
  status: ProgressStatus
  sessionName?: string
}

export interface ProgressEntryWithContext extends ProgressEntry {
  project: string
  workstream: string
}

/** Project an events.jsonl event into the ProgressEntry shape consumed by
 *  existing UI consumers (badge counts, unread watermarks). */
function projectEventToEntry(event: YacoEvent, projectName: string): ProgressEntryWithContext | null {
  const type = EVENT_KIND_TO_PROGRESS_TYPE[event.kind]
  if (!type) return null
  const payload = event.payload ?? {}
  const message = typeof payload.message === 'string' ? payload.message : event.kind
  const agentRaw = typeof payload.agent === 'string' ? payload.agent : 'claude'
  const agent: 'claude' | 'codex' = agentRaw === 'codex' ? 'codex' : 'claude'
  return {
    id: event.id,
    agent,
    type,
    message,
    timestamp: event.ts,
    status: 'active',
    sessionName: event.sessionId,
    project: projectName,
    workstream: event.taskId ?? '',
  }
}

const EVENT_KIND_TO_PROGRESS_TYPE: Record<string, ProgressType> = {
  session_idle: 'session_idle',
  human_review_requested: 'human_review',
  verification_failed: 'blocked',
  dispatched: 'info',
  verified: 'info',
}

/** Scan all projects for progress entries from the canonical YACO event stream.
 *  Runtime no longer reads repo-local progress.json files. */
export async function scanProgress(projects: Project[]): Promise<ProgressEntryWithContext[]> {
  const all: ProgressEntryWithContext[] = []

  for (const project of projects) {
    const events = await readEvents(project.name)
    for (const event of events) {
      const entry = projectEventToEntry(event, project.name)
      if (entry) all.push(entry)
    }
  }

  all.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  return all
}
