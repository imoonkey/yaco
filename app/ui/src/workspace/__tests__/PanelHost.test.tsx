// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { PanelHost } from '../PanelHost'
import { PanelFrame } from '../PanelFrame'
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

describe('registry helpers (real implementations)', () => {
  it('getPanelDefinition returns undefined for non-string / unknown ids', async () => {
    const actual = await vi.importActual<typeof import('../panelRegistry')>('../panelRegistry')
    expect(actual.getPanelDefinition('files')).toBeUndefined() // unregistered in phase 2
    expect(actual.getPanelDefinition(null)).toBeUndefined()
    expect(actual.getPanelDefinition(undefined)).toBeUndefined()
    expect(actual.getPanelDefinition(123)).toBeUndefined()
    expect(actual.getPanelDefinition({ panel: 'x' })).toBeUndefined()
    expect(actual.allPanelDefinitions()).toHaveLength(0) // registry stays empty/assembling
  })

  it('resolvePanelTitle handles string and env-function titles', async () => {
    const actual = await vi.importActual<typeof import('../panelRegistry')>('../panelRegistry')
    expect(actual.resolvePanelTitle('Changes', fakeEnv)).toBe('Changes')
    expect(actual.resolvePanelTitle((ctx) => ctx.env.project.name, fakeEnv)).toBe('demo')
  })
})
