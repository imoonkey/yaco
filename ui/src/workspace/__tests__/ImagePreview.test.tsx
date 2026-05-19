// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ImagePreview } from '../ImagePreview'

afterEach(() => {
  cleanup()
})

describe('ImagePreview', () => {
  it('defaults to fit-width and supports zoom controls', () => {
    render(<ImagePreview src="/sample.png" />)

    const image = screen.getByAltText('Image preview') as HTMLImageElement
    expect(image.style.width).toBe('100%')
    expect(screen.getByText('100%')).toBeTruthy()

    fireEvent.click(screen.getByTitle('Zoom in (+)'))

    expect(image.style.width).toBe('125%')
    expect(image.parentElement?.className).toContain('justify-start')
    expect(screen.getByText('125%')).toBeTruthy()

    fireEvent.click(screen.getByTitle('Zoom out (−)'))

    expect(image.style.width).toBe('100%')
    expect(image.parentElement?.className).toContain('justify-center')
    expect(screen.getByText('100%')).toBeTruthy()
  })

  it('resets zoom back to fit-width', () => {
    render(<ImagePreview src="/sample.png" />)

    const image = screen.getByAltText('Image preview') as HTMLImageElement

    fireEvent.click(screen.getByTitle('Zoom in (+)'))
    fireEvent.click(screen.getByTitle('Zoom in (+)'))
    fireEvent.click(screen.getByTitle('Fit width (W)'))

    expect(image.style.width).toBe('100%')
    expect(screen.getByText('100%')).toBeTruthy()
  })

  it('switches to fit-height mode', () => {
    render(<ImagePreview src="/sample.png" />)

    fireEvent.click(screen.getByTitle('Fit height (H)'))

    const image = screen.getByAltText('Image preview') as HTMLImageElement
    expect(image.style.height).toBe('100%')
    expect(image.style.width).toBe('auto')
    expect(screen.getByText('Fit')).toBeTruthy()
    expect(screen.getByTitle('Fit height (H)').getAttribute('aria-pressed')).toBe('true')
  })

  it('exits fit-height when zooming', () => {
    render(<ImagePreview src="/sample.png" />)

    fireEvent.click(screen.getByTitle('Fit height (H)'))
    expect(screen.getByText('Fit')).toBeTruthy()

    fireEvent.click(screen.getByTitle('Zoom in (+)'))

    const image = screen.getByAltText('Image preview') as HTMLImageElement
    expect(image.style.width).toBe('125%')
    expect(screen.getByText('125%')).toBeTruthy()
  })

  it('supports keyboard shortcuts W, H, +, -', () => {
    const { container } = render(<ImagePreview src="/sample.png" />)
    const root = container.firstChild as HTMLElement

    fireEvent.keyDown(root, { key: 'h' })
    expect(screen.getByText('Fit')).toBeTruthy()

    fireEvent.keyDown(root, { key: 'w' })
    expect(screen.getByText('100%')).toBeTruthy()

    fireEvent.keyDown(root, { key: '+' })
    expect(screen.getByText('125%')).toBeTruthy()

    fireEvent.keyDown(root, { key: '-' })
    expect(screen.getByText('100%')).toBeTruthy()
  })

  it('ignores shortcuts with modifier keys', () => {
    const { container } = render(<ImagePreview src="/sample.png" />)
    const root = container.firstChild as HTMLElement

    fireEvent.keyDown(root, { key: 'h', metaKey: true })
    expect(screen.queryByText('Fit')).toBeNull()
    expect(screen.getByText('100%')).toBeTruthy()
  })
})
