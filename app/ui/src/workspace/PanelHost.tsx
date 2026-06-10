// PanelHost — given a panel id, look it up in the registry and render it.
//
// Design: "layout decides where a panel appears; panels decide what they
// render." The host is the thin bridge: registry lookup, frame chrome + header
// from the panel's metadata, and a graceful placeholder for anything the
// registry does not resolve — a phase-2 scaffold id, a stale/garbage id from a
// corrupt persisted layout tree, or a non-string value. It never crashes.
import { useWorkspaceEnv } from './context'
import {
  getPanelDefinition, resolvePanelTitle, type PanelDefinition,
} from './panelRegistry'
import { PanelFrame } from './PanelFrame'

// Loose by design: persisted layout trees feed ids in, so the host tolerates
// any value and falls back to the placeholder rather than forcing unsafe casts
// on every caller.
export type PanelHostProps = { id: unknown }

export function PanelHost({ id }: PanelHostProps) {
  const def = getPanelDefinition(id)
  // Placeholder path takes no hooks, so an unresolved id renders without a
  // provider and without violating the rules of hooks below. Keyed by panel id
  // so relocating a panel (phase 5/8) remounts the header hook instead of
  // swapping hook identity inside a reused fiber.
  if (!def) return <PanelPlaceholder id={id} />
  return <HostedPanel key={def.id} def={def} />
}

function HostedPanel({ def }: { def: PanelDefinition }) {
  const env = useWorkspaceEnv()
  const Body = def.Component
  return (
    <PanelFrame
      chrome={def.chrome}
      title={resolvePanelTitle(def.title, env)}
      useHeader={def.useHeader}
    >
      <Body />
    </PanelFrame>
  )
}

function PanelPlaceholder({ id }: { id: unknown }) {
  const label = typeof id === 'string' && id.length > 0 ? id : 'unknown'
  return (
    <div
      role="note"
      aria-label={`Panel ${label} unavailable`}
      className="flex h-full w-full items-center justify-center p-4 text-ui-sm select-none"
      style={{ color: 'var(--sol-text-faint)' }}
    >
      Panel “{label}” is not registered.
    </div>
  )
}
