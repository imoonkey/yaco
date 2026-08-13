import { DialogShell } from '../components/DialogShell'

const isMac = navigator.platform.startsWith('Mac')
const META = isMac ? '⌘' : 'Meta'
const MOD = isMac ? '⌘' : 'Ctrl'
const CTRL = isMac ? '⌃' : 'Ctrl'

type Shortcut = { readonly keys: string; readonly label: string }
type Group = { readonly title: string; readonly shortcuts: readonly Shortcut[] }

const GROUPS: readonly Group[] = [
  {
    title: 'Global',
    shortcuts: [
      { keys: `${META} 1–9`, label: 'Switch project' },
      { keys: `${META} ${CTRL} 1–9`, label: 'Switch session' },
      { keys: `${META} ${CTRL} ↑ / ↓`, label: 'Prev / next session' },
      { keys: `${META} ${CTRL} ← / →`, label: 'Prev / next editor tab' },
      { keys: '?', label: 'Shortcut cheatsheet' },
    ],
  },
  {
    title: 'Workspace',
    shortcuts: [
      { keys: `${META} P`, label: 'Quick open' },
      { keys: `${META} ⇧ F`, label: 'Search all files' },
      { keys: `${META} B`, label: 'Toggle left sidebar' },
      { keys: `${META} ⇧ B`, label: 'Toggle right panel' },
      { keys: `${META} ⇧ T`, label: 'Toggle tasks' },
      { keys: `${META} \\`, label: 'Split focused group' },
      { keys: `${META} K ${META} \\`, label: 'Split on other axis' },
      { keys: `${META} W`, label: 'Close focused tab / group' },
      { keys: `${META} ⇧ V`, label: 'Cycle editor view' },
      { keys: 'F5 / Ctrl ⇧ V', label: 'Record voice' },
    ],
  },
  {
    title: 'Editor',
    shortcuts: [
      { keys: `${MOD} S`, label: 'Save' },
      { keys: `${MOD} F`, label: 'Find' },
    ],
  },
  {
    title: 'Explorer',
    shortcuts: [
      { keys: `${META} ⏎`, label: 'Open selected file to side' },
      { keys: `${META} C`, label: 'Copy selected path' },
      { keys: 'F2', label: 'Rename selected file' },
      { keys: '⏎', label: 'Open selected file' },
    ],
  },
  {
    title: 'Task Graph',
    shortcuts: [
      { keys: '/', label: 'Search tasks' },
      { keys: 'c', label: 'Collapse / expand selected' },
      { keys: '⇧ C', label: 'Collapse all' },
      { keys: '⇧ E', label: 'Expand all' },
      { keys: 'Tab / ⇧ Tab', label: 'Next / previous task' },
      { keys: '← → ↑ ↓', label: 'Navigate' },
      { keys: 'Home / End', label: 'First / last task' },
      { keys: 'Escape', label: 'Deselect' },
    ],
  },
  {
    title: 'Terminal',
    shortcuts: [
      { keys: isMac ? '⌘ C' : 'Ctrl ⇧ C', label: 'Copy selected text' },
    ],
  },
]

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <DialogShell onClose={onClose} className="rounded-lg p-6 w-full max-w-2xl max-h-[82vh] overflow-y-auto">
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
