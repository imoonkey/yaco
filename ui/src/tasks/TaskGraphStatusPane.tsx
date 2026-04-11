
function StateButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-3 py-1.5 rounded text-[11px] font-semibold cursor-pointer transition-colors disabled:cursor-default disabled:opacity-60"
      style={{
        backgroundColor: 'var(--sol-subtle-bg)',
        color: 'var(--sol-text)',
        border: `1px solid var(--sol-border)`,
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
      <div className="max-w-[400px] rounded-lg px-5 py-4 text-center" style={{ border: '1px solid var(--sol-border)', backgroundColor: 'var(--sol-editor-bg)' }}>
        <div className="text-[14px] font-bold" style={{ color: tone }}>{title}</div>
        <div className="mt-1.5 text-[12px]" style={{ color: 'var(--sol-text)' }}>{message}</div>
        {actions && <div className="mt-3 flex flex-wrap justify-center gap-2">{actions}</div>}
        {detail && <div className="mt-2 text-[11px]" style={{ color: 'var(--sol-muted)' }}>{detail}</div>}
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
      <div className="flex items-center justify-center h-full gap-2" style={{ color: 'var(--sol-muted)' }}>
        <div className="loading-spinner" />
        <span className="text-[12px]">Loading task graph...</span>
      </div>
    )
  }

  if (status === 'missing') {
    return (
      <StatePane
        title="No tasks.json yet"
        message="This project does not have a task graph file yet."
        tone={'var(--sol-base01)'}
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
        tone={'var(--sol-red)'}
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
    <div className="flex items-center justify-center h-full" style={{ color: 'var(--sol-muted)' }}>
      <span className="text-[12px]">No tasks defined</span>
    </div>
  )
}
