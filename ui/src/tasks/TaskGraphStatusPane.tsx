import { SOLARIZED_LIGHT } from '../lib/solarizedLight'

function StateButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-3 py-1.5 rounded text-[12px] font-medium cursor-pointer transition-colors disabled:cursor-default disabled:opacity-60"
      style={{
        backgroundColor: SOLARIZED_LIGHT.base2,
        color: SOLARIZED_LIGHT.base01,
        border: `1px solid ${SOLARIZED_LIGHT.border}`,
      }}
    >
      {label}
    </button>
  )
}

function StatePane({
  title,
  message,
  tone,
  actions,
  detail,
}: {
  title: string
  message: string
  tone: string
  actions?: React.ReactNode
  detail?: string | null
}) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-[440px] rounded-md border px-5 py-4 text-center" style={{ borderColor: SOLARIZED_LIGHT.border, backgroundColor: SOLARIZED_LIGHT.base3 }}>
        <div className="text-[15px] font-semibold" style={{ color: tone }}>{title}</div>
        <div className="mt-2 text-[12px]" style={{ color: SOLARIZED_LIGHT.base01 }}>{message}</div>
        {actions && <div className="mt-4 flex flex-wrap justify-center gap-2">{actions}</div>}
        {detail && <div className="mt-3 text-[11px]" style={{ color: SOLARIZED_LIGHT.base1 }}>{detail}</div>}
      </div>
    </div>
  )
}

export function TaskGraphStatusPane({
  status,
  error,
  creating,
  actionError,
  onOpenTasksFile,
  onCreateTasksFile,
  onRetry,
}: {
  status: 'loading' | 'missing' | 'error' | 'empty'
  error?: Error | null
  creating?: boolean
  actionError?: string | null
  onOpenTasksFile?: () => void
  onCreateTasksFile?: () => void
  onRetry?: () => void
}) {
  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: SOLARIZED_LIGHT.base1 }}>
        Loading task graph...
      </div>
    )
  }

  if (status === 'missing') {
    return (
      <StatePane
        title="No tasks.json yet"
        message="This project does not have a task graph file yet."
        tone={SOLARIZED_LIGHT.base01}
        actions={
          <>
            {onOpenTasksFile && <StateButton label="Open tasks.json" onClick={onOpenTasksFile} />}
            {onCreateTasksFile && (
              <StateButton label={creating ? 'Creating\u2026' : 'Create tasks.json'} onClick={onCreateTasksFile} disabled={creating} />
            )}
          </>
        }
        detail={actionError}
      />
    )
  }

  if (status === 'error') {
    return (
      <StatePane
        title="Unable to load task graph"
        message={error?.message ?? 'Failed to load tasks'}
        tone={SOLARIZED_LIGHT.red}
        actions={
          <>
            {onOpenTasksFile && <StateButton label="Open tasks.json" onClick={onOpenTasksFile} />}
            {onRetry && <StateButton label="Retry" onClick={onRetry} />}
          </>
        }
      />
    )
  }

  // empty
  return (
    <div className="flex items-center justify-center h-full" style={{ color: SOLARIZED_LIGHT.base1 }}>
      No tasks defined
    </div>
  )
}
