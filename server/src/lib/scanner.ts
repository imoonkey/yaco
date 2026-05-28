import { readFile, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
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

/** Read a legacy progress.json file and attach context. Read-only fallback
 *  merged alongside events.jsonl until yc-migration-script deletes the
 *  legacy files (after the operator verifies events.jsonl is complete). */
async function readProgressFile(file: string, projectName: string, workstreamId: string): Promise<ProgressEntryWithContext[]> {
  try {
    const raw = await readFile(file, 'utf-8')
    const entries: ProgressEntry[] = JSON.parse(raw)
    return entries.map(e => ({
      ...e,
      project: projectName,
      workstream: workstreamId,
    }))
  } catch (e) {
    console.warn(`[scanner] failed to read progress file ${file}:`, e)
    return []
  }
}

/** Project an events.jsonl event into the legacy ProgressEntry shape so
 *  existing UI consumers (badge counts, unread watermarks) keep working. */
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

/** Scan all projects for progress entries. Reads events.jsonl AND merges in
 *  any legacy repo-local progress.json entries (deduped by project/workstream/id)
 *  so unmigrated data stays visible after the server starts emitting new events.
 *  Once yc-migration-script deletes the legacy files, the fallback becomes inert. */
export async function scanProgress(projects: Project[]): Promise<ProgressEntryWithContext[]> {
  const all: ProgressEntryWithContext[] = []
  const seenKeys = new Set<string>()
  const push = (entry: ProgressEntryWithContext): void => {
    const key = `${entry.project}\0${entry.workstream}\0${entry.id}`
    if (seenKeys.has(key)) return
    seenKeys.add(key)
    all.push(entry)
  }

  for (const project of projects) {
    const events = await readEvents(project.name)
    for (const event of events) {
      const entry = projectEventToEntry(event, project.name)
      if (entry) push(entry)
    }

    const projectsDir = join(project.path, 'projects')
    const activeDir = join(projectsDir, 'active')

    const projectProgress = join(projectsDir, 'progress.json')
    if (existsSync(projectProgress)) {
      const items = await readProgressFile(projectProgress, project.name, '')
      for (const item of items) push(item)
    }

    if (!existsSync(activeDir)) continue
    const entries = await readdir(activeDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const progressFile = join(activeDir, entry.name, 'progress.json')
      if (!existsSync(progressFile)) continue
      const items = await readProgressFile(progressFile, project.name, entry.name)
      for (const item of items) push(item)
    }
  }

  all.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  return all
}

/** Dismiss is a no-op under the events.jsonl model: events are immutable,
 *  and "read state" is owned by ui-state watermarks + notifications cache,
 *  not by mutating the source log. Retained as a no-op so the legacy
 *  /api/progress dismiss route keeps responding 200 until yc-* removes it. */
export async function dismissProgress(
  _projectPath: string,
  _workstreamId: string,
  _entryId: string,
): Promise<void> {
  // intentionally empty — see doc/main/data-model/persistence.md
}
