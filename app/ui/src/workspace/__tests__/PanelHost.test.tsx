// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { PanelHost } from '../PanelHost'
import { PanelFrame } from '../PanelFrame'
import { usePanelInstance } from '../panelInstance'
import { WorkspaceEnvContext, type WorkspaceEnv } from '../context'
import * as registry from '../panelRegistry'
import type { PanelDefinition } from '../panelRegistry'

// Control what the host looks up without populating the (intentionally empty)
// registry. resolvePanelTitle stays real so the title-resolver path is exercised.
vi.mock('../panelRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../panelRegistry')>()
  return { ...actual, getPanelDefinition: vi.fn() }
})

const getPanelDefinition = vi.mocked(registry.getPanelDefinition)

afterEach(cleanup)
beforeEach(() => getPanelDefinition.mockReset())

const fakeEnv = {
  project: { name: 'demo', path: '/demo', effectivePath: '/demo' },
} as unknown as WorkspaceEnv

const renderInEnv = (ui: ReactNode) =>
  render(<WorkspaceEnvContext.Provider value={fakeEnv}>{ui}</WorkspaceEnvContext.Provider>)

function FakeBody() {
  return <div>panel-body</div>
}

// Reads the published per-instance identity so tests can assert PanelHost wiring.
function InstanceProbe() {
  const inst = usePanelInstance()
  return <div data-testid="instance">{inst ? `${inst.type}/${inst.instanceId}` : 'none'}</div>
}

const framedDef: PanelDefinition = {
  id: 'changes',
  title: 'Changes',
  chrome: 'framed',
  mobileDock: 'browse',
  mobileOrder: 0,
  minSize: { width: 100, height: 100 },
  Component: FakeBody,
  useHeader: () => ({
    title: 'Changes (stale)',
    actions: <button type="button">refresh</button>,
    badge: 3,
    stats: <span>+5</span>,
  }),
}

const unframedDef: PanelDefinition = {
  id: 'editor',
  title: 'Editor',
  chrome: 'unframed',
  mobileDock: 'editor',
  mobileOrder: 0,
  minSize: { width: 100, height: 100 },
  Component: FakeBody,
}

describe('PanelHost — unresolved ids render a placeholder, never crash', () => {
  it.each([
    ['valid but unregistered', 'files', 'files'],
    ['empty string', '', 'unknown'],
    ['null', null, 'unknown'],
    ['undefined', undefined, 'unknown'],
    ['garbage string', '\0bogus', '\0bogus'],
    ['number', 123, 'unknown'],
    ['object', { panel: 'x' }, 'unknown'],
  ])('handles %s', (_label, id, expectedLabel) => {
    getPanelDefinition.mockReturnValue(undefined)
    expect(() => render(<PanelHost id={id as unknown} />)).not.toThrow()
    expect(screen.getByRole('note', { name: `Panel ${expectedLabel} unavailable` })).toBeTruthy()
    expect(screen.getByText(/not registered/)).toBeTruthy()
  })
})

describe('PanelHost — registered panels', () => {
  it('framed panel renders header (dynamic title + actions + badge + stats) and body', () => {
    getPanelDefinition.mockReturnValue(framedDef)
    renderInEnv(<PanelHost id="changes" />)
    expect(screen.getByText('Changes (stale)')).toBeTruthy() // useHeader title overrides static
    expect(screen.getByRole('button', { name: 'refresh' })).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy() // badge
    expect(screen.getByText('+5')).toBeTruthy() // stats
    expect(screen.getByText('panel-body')).toBeTruthy()
  })

  it('unframed panel renders the body bare with no header chrome', () => {
    getPanelDefinition.mockReturnValue(unframedDef)
    renderInEnv(<PanelHost id="editor" />)
    expect(screen.getByText('panel-body')).toBeTruthy()
    expect(screen.queryByText('Editor')).toBeNull() // no framed header
  })

  it('publishes the instance identity to the panel (instanceId prop, type from def)', () => {
    const def: PanelDefinition = { ...unframedDef, Component: InstanceProbe }
    getPanelDefinition.mockReturnValue(def)
    renderInEnv(<PanelHost id="editor" instanceId="editor:2" />)
    expect(screen.getByTestId('instance').textContent).toBe('editor/editor:2')
  })

  it('defaults instanceId to the panel type for a singleton (no instanceId prop)', () => {
    const def: PanelDefinition = { ...unframedDef, id: 'changes', Component: InstanceProbe }
    getPanelDefinition.mockReturnValue(def)
    renderInEnv(<PanelHost id="changes" />)
    expect(screen.getByTestId('instance').textContent).toBe('changes/changes')
  })
})

describe('PanelFrame — chrome + header slots', () => {
  it('framed renders the static title when no useHeader is given', () => {
    render(
      <PanelFrame chrome="framed" title="SESSIONS">
        <div>body</div>
      </PanelFrame>,
    )
    expect(screen.getByText('SESSIONS')).toBeTruthy()
    expect(screen.getByText('body')).toBeTruthy()
  })

  it('framed lays out useHeader actions/badge/stats and overrides the title', () => {
    render(
      <PanelFrame
        chrome="framed"
        title="Changes"
        useHeader={() => ({ title: 'Changes (stale)', actions: <button type="button">act</button>, badge: 2, stats: <span>stat</span> })}
      >
        <div>body</div>
      </PanelFrame>,
    )
    expect(screen.getByText('Changes (stale)')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'act' })).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getByText('stat')).toBeTruthy()
  })

  it('unframed renders the body bare without a header', () => {
    render(
      <PanelFrame chrome="unframed" title="EDITOR">
        <div>body</div>
      </PanelFrame>,
    )
    expect(screen.getByText('body')).toBeTruthy()
    expect(screen.queryByText('EDITOR')).toBeNull()
  })
})

describe('PanelFrame — collapse contract (renderer chrome slot)', () => {
  const headerOf = (title: string) => screen.getByRole('button', { name: `${title} section` })

  it('expanded slot renders aria-expanded=true, the actions, and the body', () => {
    render(
      <PanelFrame
        chrome="framed"
        title="Files"
        useHeader={() => ({ actions: <button type="button">act</button> })}
        slot={{ collapsed: false, onToggle: () => {} }}
      >
        <div>body</div>
      </PanelFrame>,
    )
    expect(headerOf('Files').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'act' })).toBeTruthy()
    expect(screen.getByText('body')).toBeTruthy()
  })

  it('collapsed slot flips aria-expanded=false, hides the actions, and suppresses the body', () => {
    render(
      <PanelFrame
        chrome="framed"
        title="Files"
        useHeader={() => ({ actions: <button type="button">act</button> })}
        slot={{ collapsed: true, onToggle: () => {} }}
      >
        <div>body</div>
      </PanelFrame>,
    )
    expect(headerOf('Files').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: 'act' })).toBeNull() // actions hidden while collapsed
    expect(screen.queryByText('body')).toBeNull() // body suppressed (drives the data-owner lifetime rules)
  })

  it('clicking the header invokes the slot onToggle', () => {
    const onToggle = vi.fn()
    render(
      <PanelFrame chrome="framed" title="Files" slot={{ collapsed: false, onToggle }}>
        <div>body</div>
      </PanelFrame>,
    )
    fireEvent.click(headerOf('Files'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('without a slot the framed header defaults to expanded with body shown', () => {
    render(
      <PanelFrame chrome="framed" title="Files">
        <div>body</div>
      </PanelFrame>,
    )
    expect(headerOf('Files').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('body')).toBeTruthy()
  })
})

describe('registry helpers (real implementations)', () => {
  it('getPanelDefinition resolves registered ids and returns undefined for unknown / non-string ids', async () => {
    const actual = await vi.importActual<typeof import('../panelRegistry')>('../panelRegistry')
    expect(actual.getPanelDefinition('files')?.id).toBe('files') // registered in phase 3h
    expect(actual.getPanelDefinition('not-a-panel')).toBeUndefined() // unknown id
    expect(actual.getPanelDefinition(null)).toBeUndefined()
    expect(actual.getPanelDefinition(undefined)).toBeUndefined()
    expect(actual.getPanelDefinition(123)).toBeUndefined()
    expect(actual.getPanelDefinition({ panel: 'x' })).toBeUndefined()
    expect(actual.allPanelDefinitions()).toHaveLength(7) // the 7 panels assembled in phase 3h
  })

  it('resolvePanelTitle handles string and env-function titles', async () => {
    const meta = await vi.importActual<typeof import('../panelMeta')>('../panelMeta')
    expect(meta.resolvePanelTitle('Changes', fakeEnv)).toBe('Changes')
    expect(meta.resolvePanelTitle((ctx) => ctx.env.project.name, fakeEnv)).toBe('demo')
  })
})
