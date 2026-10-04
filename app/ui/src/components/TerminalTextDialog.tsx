// TerminalTextDialog — the touch-device way to copy terminal output. xterm draws
// to a canvas and owns touch gestures, so a phone cannot select text in it. This
// dialog shows the session's tmux pane (scrollback included) in a native textarea,
// where long-press selection and the OS copy menu work as usual; "Copy all" covers
// the whole-buffer case in one tap. The textarea stays editable because iOS gives a
// readOnly one no selection handles; `inputMode="none"` keeps the keyboard down, and
// edits are a local scratch copy (handy for trimming before "Copy all").
import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { DialogShell } from './DialogShell'
import { fetchSessionText } from '../hooks/useApi'
import { writeTextToClipboard } from '../lib/clipboard'

type Load = { status: 'loading' } | { status: 'ready'; text: string } | { status: 'error'; message: string }

export function TerminalTextDialog({ sessionName, onClose }: { sessionName: string; onClose: () => void }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchSessionText(sessionName, controller.signal)
      .then(text => setLoad({ status: 'ready', text }))
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setLoad({ status: 'error', message: e instanceof Error ? e.message : String(e) })
      })
    return () => controller.abort()
  }, [sessionName])

  // Open at the bottom, where the latest output is — the same view the terminal had.
  useEffect(() => {
    const el = textareaRef.current
    if (el && load.status === 'ready') el.scrollTop = el.scrollHeight
  }, [load])

  const copyAll = async () => {
    const text = textareaRef.current?.value
    if (load.status !== 'ready' || text === undefined) return
    if (await writeTextToClipboard(text)) {
      toast.success('Copied terminal text')
      onClose()
    } else {
      toast.error('Copy failed — long-press to select instead')
    }
  }

  return (
    <DialogShell
      onClose={onClose}
      overlayClassName="z-[1000] items-center justify-center"
      className="flex flex-col gap-2 rounded-lg p-3"
      style={{ width: '94%', maxWidth: 720, height: '80%', backgroundColor: 'var(--sol-editor-bg)' }}
      ariaLabelledBy="terminal-text-title"
    >
      <div className="flex items-center gap-2 text-ui-md" style={{ color: 'var(--sol-text)' }}>
        <span id="terminal-text-title" className="flex-1 truncate font-semibold">Terminal text · {sessionName}</span>
        <button type="button" className="p-1 cursor-pointer" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>
      {load.status === 'error' ? (
        <div role="alert" className="flex-1 text-ui-md" style={{ color: 'var(--sol-red)' }}>{load.message}</div>
      ) : (
        <textarea
          ref={textareaRef}
          key={load.status}
          inputMode="none"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label="Terminal text"
          defaultValue={load.status === 'ready' ? load.text : 'Loading…'}
          className="flex-1 min-h-0 w-full resize-none rounded p-2 font-mono text-ui-md outline-none select-text"
          style={{ color: 'var(--sol-editor-fg)', background: 'var(--sol-input-bg)', border: '1px solid var(--sol-border)', lineHeight: 'var(--lh-normal)' }}
        />
      )}
      <div className="flex items-center gap-2">
        <span className="flex-1 text-ui-sm" style={{ color: 'var(--sol-text-faint)' }}>Long-press to select part of it</span>
        <button
          type="button"
          className="h-8 px-3 rounded font-medium text-ui-md cursor-pointer touch-manipulation disabled:cursor-default"
          style={{ background: 'var(--sol-accent)', color: 'var(--sol-base3)' }}
          disabled={load.status !== 'ready'}
          onClick={copyAll}
        >
          Copy all
        </button>
      </div>
    </DialogShell>
  )
}
