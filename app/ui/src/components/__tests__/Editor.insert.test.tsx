// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Editor } from '../Editor'

afterEach(cleanup)

const docText = () => document.querySelector('.cm-content')?.textContent ?? ''

describe('Editor voice insert', () => {
  it('does not replay a pending insert request when the editor remounts', () => {
    const props = {
      content: 'hello world',
      filePath: 'a.md',
      insertText: ' dictated',
      insertRequestKey: 111,
    }
    // First mount: the request predates this editor — nothing is inserted.
    const first = render(<Editor {...props} />)
    expect(docText()).toBe('hello world')
    first.unmount()
    cleanup()

    // Remount with the SAME pending request: still nothing.
    render(<Editor {...props} />)
    expect(docText()).toBe('hello world')
  })

  it('inserts a request that arrives while mounted', () => {
    const view = render(<Editor content="hello world" filePath="a.md" />)
    view.rerender(<Editor content="hello world" filePath="a.md" insertText="X" insertRequestKey={222} />)
    expect(docText()).toBe('Xhello world')
  })
})
