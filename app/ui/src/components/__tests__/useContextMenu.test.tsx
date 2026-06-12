// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Menu, MenuItem } from '../Menu'
import { useContextMenu } from '../useContextMenu'

function TestContextMenu({ onAction, onDragStart }: { onAction: () => void; onDragStart?: () => void }) {
  const menu = useContextMenu()

  return (
    <>
      <button type="button" data-testid="target" draggable={!!onDragStart} onDragStart={onDragStart} {...menu.bind()}>
        Target
      </button>
      <button type="button">Outside</button>
      {menu.position && (
        <Menu
          position={menu.position}
          exiting={menu.exiting}
          armed={menu.armed}
          focusOnOpen={menu.focusOnOpen}
          onExitDone={menu.onExitDone}
        >
          <MenuItem label="Action" onClick={onAction} />
        </Menu>
      )}
    </>
  )
}

function TriggerMenu({ onAction }: { onAction: () => void }) {
  const menu = useContextMenu()

  return (
    <>
      <button type="button" data-testid="trigger" onClick={menu.openFromTrigger}>
        Split
      </button>
      <button type="button">Outside</button>
      {menu.position && (
        <Menu
          position={menu.position}
          exiting={menu.exiting}
          armed={menu.armed}
          focusOnOpen={menu.focusOnOpen}
          onExitDone={menu.onExitDone}
        >
          <MenuItem label="Action" onClick={onAction} />
        </Menu>
      )}
    </>
  )
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useContextMenu openFromTrigger', () => {
  it('opens a menu from a left-click trigger and keeps it open through that click', () => {
    const docClick = vi.fn()
    document.addEventListener('click', docClick)
    const onAction = vi.fn()
    render(<TriggerMenu onAction={onAction} />)

    fireEvent.click(screen.getByTestId('trigger'))

    // The menu is open — the opening click did NOT instantly dismiss it (Bug 2).
    expect(screen.getByRole('menuitem', { name: 'Action' })).toBeTruthy()
    // The opening click never reached the document dismiss path (stopPropagation).
    expect(docClick).not.toHaveBeenCalled()
    document.removeEventListener('click', docClick)

    // A choice still fires normally.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Action' }))
    expect(onAction).toHaveBeenCalledTimes(1)
  })
})

describe('useContextMenu touch behavior', () => {
  it('keeps desktop context-menu actions immediately clickable', () => {
    const onAction = vi.fn()
    render(<TestContextMenu onAction={onAction} />)

    fireEvent.contextMenu(screen.getByTestId('target'), { clientX: 20, clientY: 30 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Action' }))

    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('opens touch menus on release and requires a second click', () => {
    vi.useFakeTimers()
    const onAction = vi.fn()
    render(<TestContextMenu onAction={onAction} />)
    const target = screen.getByTestId('target')

    act(() => {
      fireEvent.touchStart(target, { touches: [{ clientX: 20, clientY: 30 }] })
      vi.advanceTimersByTime(350)
    })

    expect(screen.queryByRole('menuitem', { name: 'Action' })).toBeNull()

    act(() => {
      fireEvent.touchEnd(target)
    })

    const item = screen.getByRole('menuitem', { name: 'Action' })
    fireEvent.click(item)
    expect(onAction).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(500)
    })
    fireEvent.click(item)

    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('keeps the drag path available when a long press turns into movement', () => {
    vi.useFakeTimers()
    const onAction = vi.fn()
    const onDragStart = vi.fn()
    render(<TestContextMenu onAction={onAction} onDragStart={onDragStart} />)
    const target = screen.getByTestId('target')

    act(() => {
      fireEvent.touchStart(target, { touches: [{ clientX: 20, clientY: 30 }] })
      vi.advanceTimersByTime(350)
      fireEvent.touchMove(target, { touches: [{ clientX: 40, clientY: 30 }] })
      fireEvent.touchEnd(target)
    })

    expect(screen.queryByRole('menuitem', { name: 'Action' })).toBeNull()
    expect(fireEvent.dragStart(target)).toBe(true)
    expect(onDragStart).toHaveBeenCalledTimes(1)
  })

  it('dismisses a touch-opened menu from an outside click after it is armed', () => {
    vi.useFakeTimers()
    const onAction = vi.fn()
    render(<TestContextMenu onAction={onAction} />)
    const target = screen.getByTestId('target')
    const outside = screen.getByRole('button', { name: 'Outside' })

    act(() => {
      fireEvent.touchStart(target, { touches: [{ clientX: 20, clientY: 30 }] })
      vi.advanceTimersByTime(350)
      fireEvent.touchEnd(target)
    })

    const menu = screen.getByRole('menu')
    fireEvent.click(outside)
    expect(screen.getByRole('menu')).toBe(menu)

    act(() => {
      vi.advanceTimersByTime(500)
    })
    act(() => {
      fireEvent.click(outside)
    })

    expect(screen.getByRole('menu').getAttribute('style')).toContain('menu-exit')
    expect(onAction).not.toHaveBeenCalled()
  })
})
