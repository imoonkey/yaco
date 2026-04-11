import { ApiError } from '../../lib/apiError'

const API = '/api'

/** Archive a terminal task and all its descendants */
export async function archiveTask(
  projectName: string,
  taskId: string,
): Promise<void> {
  const res = await fetch(
    `${API}/tasks/${encodeURIComponent(projectName)}/${encodeURIComponent(taskId)}/archive`,
    { method: 'POST' },
  )
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(res.status, body)
  }
}
