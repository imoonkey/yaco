// PanelHost — given a panel id, look it up in the registry and render it.
//
// Design: "layout decides where a panel appears; panels decide what they
// render." The host is the thin bridge: registry lookup, frame chrome + header
// from the panel's metadata, and a graceful placeholder for anything the
// registry does not resolve — a phase-2 scaffold id, a stale/garbage id from a
// corrupt persisted layout tree, or a non-string value. It never crashes.
import { useWorkspaceEnv } from './context'
import { getPanelDefinition, type PanelDefinition } from './panelRegistry'
import { resolvePanelTitle } from './panelMeta'
import { PanelFrame } from './PanelFrame'
import { usePanelChromeSlot } from './panelChrome'
import { PanelInstanceProvider } from './panelInstance'

// Loose by design: persisted layout trees feed ids in, so the host tolerates
// any value and falls back to the placeholder rather than forcing unsafe casts
// on every caller. `instanceId` identifies WHICH instance of a multi-instance
// type this is (the renderer passes the leaf/tabs-entry id); it defaults to the
// resolved panel type, so singletons get instanceId === type.
export type PanelHostProps = { id: unknown; instanceId?: string }

export function PanelHost({ id, instanceId }: PanelHostProps) {
  const def = getPanelDefinition(id)
  // Placeholder path takes no hooks, so an unresolved id renders without a
  // provider and without violating the rules of hooks below. Keyed by panel id
  // so relocating a panel (phase 5/8) remounts the header hook instead of
  // swapping hook identity inside a reused fiber.
  if (!def) return <PanelPlaceholder id={id} />
  return <HostedPanel key={def.id} def={def} instanceId={instanceId ?? def.id} />
}

function HostedPanel({ def, instanceId }: { def: PanelDefinition; instanceId: string }) {
  const env = useWorkspaceEnv()
  // Renderer-supplied collapse + body sizing for this panel id (undefined when no
  // renderer is sizing sections, e.g. isolation tests — the frame then defaults
  // to expanded + fill).
  const slot = usePanelChromeSlot(def.id)
  const Body = def.Component
  return (
    <PanelInstanceProvider value={{ type: def.id, instanceId }}>
      <PanelFrame
        chrome={def.chrome}
        title={resolvePanelTitle(def.title, env)}
        useHeader={def.useHeader}
        slot={slot}
        panelId={def.id}
      >
        <Body />
      </PanelFrame>
    </PanelInstanceProvider>
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
