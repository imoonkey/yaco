import { DialogShell } from '../components/DialogShell'

const isMac = navigator.platform.startsWith('Mac')
const CMD = isMac ? '⌘' : 'Ctrl'

type Shortcut = { keys: string; label: string }
type Group = { title: string; shortcuts: Shortcut[] }

const GROUPS: Group[] = [
  {
    title: 'Global',
    shortcuts: [
      { keys: `${CMD} 1–9`, label: 'Switch project' },
      { keys: `${CMD} ⌃ 1–9`, label: 'Switch session' },
      { keys: `${CMD} ⌃ ↑ / ↓`, label: 'Prev / next session' },
      { keys: `${CMD} ⌃ ← / →`, label: 'Prev / next tab' },
      { keys: `${CMD} K`, label: 'Notifications' },
      { keys: '?', label: 'Shortcut cheatsheet' },
    ],
  },
  {
    title: 'Editor',
    shortcuts: [
      { keys: `${CMD} P`, label: 'Quick open' },
      { keys: `${CMD} S`, label: 'Save' },
      { keys: `${CMD} F`, label: 'Find' },
      { keys: `${CMD} ⇧ F`, label: 'Search all files' },
      { keys: `${CMD} B`, label: 'Toggle sidebar' },
      { keys: `${CMD} ⇧ B`, label: 'Toggle right panel' },
      { keys: `${CMD} ⇧ T`, label: 'Toggle tasks' },
      { keys: `${CMD} W`, label: 'Close tab / surface' },
    ],
  },
  {
    title: 'Task Graph',
    shortcuts: [
      { keys: '+ / − / 0', label: 'Zoom in / out / reset' },
      { keys: 'C', label: 'Collapse all' },
      { keys: 'Tab', label: 'Next task' },
      { keys: '← → ↑ ↓', label: 'Navigate' },
      { keys: 'Escape', label: 'Deselect' },
    ],
  },
]

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <DialogShell onClose={onClose} className="rounded-lg p-6 w-full max-w-lg">
      <h2
        className="text-ui-2xl font-semibold mb-4"
        style={{ color: 'var(--sol-text-dark)', fontFamily: 'var(--font-ui)' }}
      >
        Keyboard Shortcuts
      </h2>
      <div className="flex flex-col gap-5">
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h3
              className="text-ui-md font-semibold uppercase tracking-wide mb-2"
              style={{ color: 'var(--sol-text)' }}
            >
              {group.title}
            </h3>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1">
              {group.shortcuts.map((s) => (
                <div key={s.label} className="flex items-center justify-between gap-2 py-0.5">
                  <span className="text-ui-xl" style={{ color: 'var(--sol-text)' }}>
                    {s.label}
                  </span>
                  <kbd
                    className="text-ui-md px-1.5 py-0.5 rounded shrink-0"
                    style={{
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--sol-text)',
                      backgroundColor: 'var(--sol-code-bg)',
                      border: '1px solid var(--sol-border)',
                    }}
                  >
                    {s.keys}
                  </kbd>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </DialogShell>
  )
}
