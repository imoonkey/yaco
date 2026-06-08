import type { Terminal as XTerm } from '@xterm/xterm'
import type { TerminalInputPromptFrame } from './providerUi'

export interface InputPromptFrame {
  top: number
  height: number
}

type PromptFrameBoundary = 'prompt-menu' | 'reply' | 'status'
type TerminalBuffer = XTerm['buffer']['active']

type TerminalWithRenderMetrics = XTerm & {
  _core?: {
    _renderService?: {
      dimensions?: {
        css?: {
          cell?: {
            height: number
          }
        }
      }
    }
  }
}

interface TerminalBufferCell {
  getBgColorMode: () => number
  getBgColor: () => number
  isBgDefault: () => boolean
}

interface TerminalBufferLine {
  readonly length?: number
  getCell?: (x: number) => TerminalBufferCell | undefined
  translateToString: (trimRight?: boolean) => string
}

function sameInputPromptFrame(a: InputPromptFrame | null, b: InputPromptFrame | null): boolean {
  if (a === null || b === null) return a === b
  return a.top === b.top && a.height === b.height
}

export function sameInputPromptFrames(a: readonly InputPromptFrame[], b: readonly InputPromptFrame[]): boolean {
  if (a.length !== b.length) return false
  return a.every((frame, index) => sameInputPromptFrame(frame, b[index] ?? null))
}

function patternMatches(pattern: RegExp | undefined, text: string): boolean {
  if (!pattern) return false
  pattern.lastIndex = 0
  const matches = pattern.test(text)
  pattern.lastIndex = 0
  return matches
}

function readLineBackgroundKey(line: TerminalBufferLine, cols: number): string | null {
  if (!line.getCell) return null

  const limit = Math.min(line.length ?? cols, cols)
  for (let col = 0; col < limit; col++) {
    const cell = line.getCell(col)
    if (!cell || cell.isBgDefault()) continue
    return `${cell.getBgColorMode()}:${cell.getBgColor()}`
  }

  return null
}

function readLineText(buffer: TerminalBuffer, row: number): string {
  return buffer.getLine(row)?.translateToString(true) ?? ''
}

function isViewportTailBlank(buffer: TerminalBuffer, fromRow: number, lastRow: number): boolean {
  for (let row = fromRow + 1; row <= lastRow; row++) {
    const line = buffer.getLine(row)
    if (line?.translateToString(true).trim()) return false
  }
  return true
}

function stripPromptGlyph(text: string): string {
  return text.replace(/^› ?/, '')
}

function readLastNonblankPromptText(buffer: TerminalBuffer, firstRow: number, lastPromptRow: number): string | null {
  for (let row = lastPromptRow; row >= firstRow; row--) {
    const text = readLineText(buffer, row)
    if (text.trim() !== '') return text
  }
  return null
}

function hasSlashCommandTrigger(promptStartText: string): boolean {
  return stripPromptGlyph(promptStartText).startsWith('/')
}

function hasShellCommandTrigger(text: string): boolean {
  return /(^|\s)\$/.test(stripPromptGlyph(text))
}

function isCommandSuggestionRow(text: string, shellCommandActive: boolean): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return false
  if (/^\/\S*(?:\s{2,}|\t+)\S/.test(trimmed)) return true
  return shellCommandActive && /^.+?(?:\s{2,}|\t+)\[(?:Plugin|Skill)\]\s+\S/.test(trimmed)
}

function readPromptMenuBoundary(
  text: string,
  buffer: TerminalBuffer,
  promptStartRow: number,
  lastPromptRow: number,
): PromptFrameBoundary | null {
  const promptStartText = readLineText(buffer, promptStartRow)
  const lastPromptText = readLastNonblankPromptText(buffer, promptStartRow, lastPromptRow)
  const slashCommandActive = hasSlashCommandTrigger(promptStartText)
  const shellCommandActive = lastPromptText !== null && hasShellCommandTrigger(lastPromptText)

  if (!slashCommandActive && !shellCommandActive) return null
  return isCommandSuggestionRow(text, shellCommandActive) ? 'prompt-menu' : null
}

function readPromptFrameBoundary(
  text: string,
  buffer: TerminalBuffer,
  row: number,
  lastRow: number,
): PromptFrameBoundary | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (text.startsWith('•') || text.startsWith('■') || text.startsWith('$')) return 'reply'
  if (/^tab to queue message\b/i.test(trimmed) && isViewportTailBlank(buffer, row, lastRow)) return 'status'
  if (!trimmed.includes(' · ')) return null
  return trimmed.split(/\s·\s/).filter(Boolean).length >= 3 && isViewportTailBlank(buffer, row, lastRow)
    ? 'status'
    : null
}

export function readCodexInputPromptFrames(term: XTerm, config?: TerminalInputPromptFrame): InputPromptFrame[] {
  if (!config) return []

  const cellHeight = (term as TerminalWithRenderMetrics)._core?._renderService?.dimensions?.css?.cell?.height
  if (!cellHeight) return []

  const buffer = term.buffer.active
  const firstRow = buffer.viewportY
  const lastRow = Math.min(buffer.viewportY + term.rows - 1, buffer.length - 1)
  const fullHeight = term.rows * cellHeight
  const frames: InputPromptFrame[] = []

  for (let row = firstRow; row <= lastRow; row++) {
    const line = buffer.getLine(row)
    if (!line || !patternMatches(config.promptPattern, line.translateToString(true))) continue

    const promptBackgroundKey = readLineBackgroundKey(line, term.cols)
    let bottomRow = row
    let boundaryRow: number | null = null
    let boundaryType: PromptFrameBoundary | null = null
    while (bottomRow + 1 <= lastRow && bottomRow - row + 1 < config.maxRows) {
      const nextRow = bottomRow + 1
      const nextLine = buffer.getLine(nextRow)
      if (!nextLine) break
      const nextText = nextLine.translateToString(true)

      if (promptBackgroundKey) {
        if (readLineBackgroundKey(nextLine, term.cols) !== promptBackgroundKey) {
          boundaryRow = nextRow
          boundaryType = readPromptMenuBoundary(nextText, buffer, row, bottomRow)
            ?? readPromptFrameBoundary(nextText, buffer, nextRow, lastRow)
          break
        }
        bottomRow++
        continue
      }

      const nextBoundaryType = readPromptMenuBoundary(nextText, buffer, row, bottomRow)
        ?? readPromptFrameBoundary(nextText, buffer, nextRow, lastRow)
      if (nextBoundaryType !== null) {
        boundaryRow = nextRow
        boundaryType = nextBoundaryType
        break
      }
      bottomRow++
    }

    const bottomText = buffer.getLine(bottomRow)?.translateToString(true).trim() ?? ''
    const boundaryTrimRows = boundaryType === 'prompt-menu'
      ? (bottomText === '' ? 1 : 0)
      : boundaryType === 'reply'
        ? (bottomText === '' ? 2 : 1)
        : boundaryType === 'status'
          ? 1
          : 0
    const adjustedBottomRow = boundaryRow === null
      ? bottomRow
      : Math.max(row, bottomRow - boundaryTrimRows)
    const top = Math.max(0, (row - buffer.viewportY) * cellHeight - config.topPadding)
    const bottom = Math.min(fullHeight, (adjustedBottomRow - buffer.viewportY + 1) * cellHeight + config.bottomPadding)
    frames.push({ top, height: bottom - top })
    row = bottomRow
  }

  return frames
}
