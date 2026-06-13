// @vitest-environment jsdom
//
// Menu / MenuItem — the checkable MenuItem API (role=menuitemcheckbox + aria-checked
// + leading Check icon) and that keyboard nav (arrow + Enter) reaches and activates a
// checkbox item alongside plain menuitems.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Menu, MenuItem } from '../Menu'

afterEach(cleanup)

const POS = { x: 0, y: 0 }

describe('MenuItem — checkable', () => {
  it('renders role=menuitemcheckbox + aria-checked + the Check icon when checked', () => {
    const { container } = render(
      <Menu position={POS}>
        <MenuItem label="Separate editors and terminals" checked onClick={vi.fn()} />
      </Menu>,
    )
    const item = screen.getByRole('menuitemcheckbox', { name: 'Separate editors and terminals' })
    expect(item.getAttribute('aria-checked')).toBe('true')
    expect(container.querySelector('.lucide-check')).toBeTruthy()
  })

  it('renders aria-checked=false and NO Check icon when unchecked (slot reserved)', () => {
    const { container } = render(
      <Menu position={POS}>
        <MenuItem label="Separate editors and terminals" checked={false} onClick={vi.fn()} />
      </Menu>,
    )
    const item = screen.getByRole('menuitemcheckbox', { name: 'Separate editors and terminals' })
    expect(item.getAttribute('aria-checked')).toBe('false')
    expect(container.querySelector('.lucide-check')).toBeNull()
  })

  it('leaves a plain MenuItem as role=menuitem with no aria-checked', () => {
    render(
      <Menu position={POS}>
        <MenuItem label="Split Left" onClick={vi.fn()} />
      </Menu>,
    )
    const item = screen.getByRole('menuitem', { name: 'Split Left' })
    expect(item.getAttribute('aria-checked')).toBeNull()
  })
})

describe('Menu — keyboard nav reaches a checkbox item', () => {
  it('arrow-navigates to a menuitemcheckbox and Enter activates it', () => {
    const onToggle = vi.fn()
    render(
      <Menu position={POS} focusOnOpen={false}>
        <MenuItem label="Split Left" onClick={vi.fn()} />
        <MenuItem label="Separate editors and terminals" checked={false} onClick={onToggle} />
      </Menu>,
    )
    const menu = screen.getByRole('menu')
    // From the first item, one ArrowDown lands on the checkbox item; Enter clicks it.
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    const checkbox = screen.getByRole('menuitemcheckbox', { name: 'Separate editors and terminals' })
    expect(document.activeElement).toBe(checkbox)
    fireEvent.keyDown(menu, { key: 'Enter' })
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})
