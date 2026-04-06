import {
  EditorView,
  GutterMarker,
  gutter,
  Decoration,
  WidgetType,
  keymap,
} from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { StateField, StateEffect, RangeSetBuilder } from '@codemirror/state'
import type { DiffHunk, ChangeType, DiffRow } from './parseDiff'
import { SOLARIZED_LIGHT } from './solarizedLight'

// --- State Effects ---

export const setDiffData = StateEffect.define<DiffHunk[]>()
const toggleHunkPopup = StateEffect.define<string>() // hunk id
const closePopup = StateEffect.define<null>()

// --- State Field ---

type DiffGutterState = {
  hunks: DiffHunk[]
  openHunkId: string | null
}

const diffState = StateField.define<DiffGutterState>({
  create: () => ({ hunks: [], openHunkId: null }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setDiffData)) {
        const hunks = e.value
        const openHunkId = value.openHunkId && hunks.some(h => h.id === value.openHunkId)
          ? value.openHunkId
          : null
        return { hunks, openHunkId }
      }
      if (e.is(toggleHunkPopup)) {
        const id = e.value
        return { ...value, openHunkId: value.openHunkId === id ? null : id }
      }
      if (e.is(closePopup)) {
        return value.openHunkId ? { ...value, openHunkId: null } : value
      }
    }
    return value
  },
})

// --- Gutter Markers ---

class AddedMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('div')
    el.className = 'cm-diff-added'
    return el
  }
}

class ModifiedMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('div')
    el.className = 'cm-diff-modified'
    return el
  }
}

class DeletedMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('div')
    el.className = 'cm-diff-deleted'
    return el
  }
}

const addedMarker = new AddedMarker()
const modifiedMarker = new ModifiedMarker()
const deletedMarker = new DeletedMarker()

function markerForType(type: ChangeType): GutterMarker {
  if (type === 'added') return addedMarker
  if (type === 'modified') return modifiedMarker
  return deletedMarker
}

// --- Diff Gutter ---

const diffGutter = gutter({
  class: 'cm-diff-gutter',
  lineMarkerChange(update) {
    return update.transactions.some(tr => tr.effects.some(e => e.is(setDiffData)))
  },
  markers(view) {
    const { hunks } = view.state.field(diffState)
    const doc = view.state.doc
    const markers: Array<{ from: number; marker: GutterMarker }> = []

    for (const hunk of hunks) {
      if (hunk.type === 'deleted') {
        const line = Math.min(hunk.anchorLine, doc.lines)
        markers.push({ from: doc.line(Math.max(1, line)).from, marker: deletedMarker })
      } else {
        const marker = markerForType(hunk.type)
        for (const ln of hunk.markedLines) {
          if (ln >= 1 && ln <= doc.lines) {
            markers.push({ from: doc.line(ln).from, marker })
          }
        }
      }
    }

    markers.sort((a, b) => a.from - b.from)
    const builder = new RangeSetBuilder<GutterMarker>()
    for (const m of markers) builder.add(m.from, m.from, m.marker)
    return builder.finish()
  },
  domEventHandlers: {
    mousedown(view, line) {
      const { hunks } = view.state.field(diffState)
      const lineNumber = view.state.doc.lineAt(line.from).number
      const hunk = hunks.find(h => {
        if (h.type === 'deleted') return h.anchorLine === lineNumber
        return h.markedLines.includes(lineNumber)
      })
      if (hunk) {
        view.dispatch({ effects: toggleHunkPopup.of(hunk.id) })
        return true
      }
      return false
    },
  },
})

// --- Line Decorations ---

const addedLineDeco = Decoration.line({ class: 'cm-diff-added-line' })
const modifiedLineDeco = Decoration.line({ class: 'cm-diff-modified-line' })

const lineDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    const diffChanged = tr.effects.some(e => e.is(setDiffData))
    if (!diffChanged && !tr.docChanged) return value

    const { hunks } = tr.state.field(diffState)
    const doc = tr.state.doc
    const builder = new RangeSetBuilder<Decoration>()

    const decos: Array<{ from: number; deco: Decoration }> = []
    for (const hunk of hunks) {
      if (hunk.type === 'deleted') continue
      const deco = hunk.type === 'added' ? addedLineDeco : modifiedLineDeco
      for (const ln of hunk.markedLines) {
        if (ln >= 1 && ln <= doc.lines) {
          decos.push({ from: doc.line(ln).from, deco })
        }
      }
    }
    decos.sort((a, b) => a.from - b.from)
    for (const d of decos) builder.add(d.from, d.from, d.deco)

    return builder.finish()
  },
  provide: f => EditorView.decorations.from(f),
})

// --- Popup helpers ---

const TRUNCATE_ROWS = 20

const BADGE_LABELS: Record<ChangeType, string> = {
  added: 'Added',
  modified: 'Changed',
  deleted: 'Deleted',
}

const BADGE_COLORS: Record<ChangeType, string> = {
  added: SOLARIZED_LIGHT.green,
  modified: SOLARIZED_LIGHT.blue,
  deleted: SOLARIZED_LIGHT.red,
}

function renderWordSegments(parent: HTMLElement, segments: { text: string; kind: string }[], highlight: string) {
  for (const seg of segments) {
    const span = document.createElement('span')
    span.textContent = seg.text
    if (seg.kind !== 'same') span.style.backgroundColor = highlight
    parent.appendChild(span)
  }
}

function renderRow(row: DiffRow, body: HTMLElement) {
  if (row.kind === 'modified') {
    // Old line
    const delEl = document.createElement('div')
    delEl.className = 'cm-diff-popup-line cm-diff-popup-del'
    const delNum = document.createElement('span')
    delNum.className = 'cm-diff-popup-linenum'
    delNum.textContent = String(row.oldLine)
    delEl.appendChild(delNum)
    renderWordSegments(delEl, row.oldSegments, 'rgba(220,50,47,0.25)')
    body.appendChild(delEl)

    // New line
    const addEl = document.createElement('div')
    addEl.className = 'cm-diff-popup-line cm-diff-popup-add'
    const addNum = document.createElement('span')
    addNum.className = 'cm-diff-popup-linenum'
    addNum.textContent = String(row.newLine)
    addEl.appendChild(addNum)
    renderWordSegments(addEl, row.newSegments, 'rgba(133,153,0,0.25)')
    body.appendChild(addEl)
    return
  }

  const el = document.createElement('div')
  const num = document.createElement('span')
  num.className = 'cm-diff-popup-linenum'

  if (row.kind === 'added') {
    el.className = 'cm-diff-popup-line cm-diff-popup-add'
    num.textContent = String(row.newLine)
    el.appendChild(num)
    el.appendChild(document.createTextNode(row.text))
  } else if (row.kind === 'deleted') {
    el.className = 'cm-diff-popup-line cm-diff-popup-del'
    num.textContent = String(row.oldLine)
    el.appendChild(num)
    el.appendChild(document.createTextNode(row.text))
  } else {
    el.className = 'cm-diff-popup-line cm-diff-popup-normal'
    num.textContent = String(row.newLine)
    el.appendChild(num)
    el.appendChild(document.createTextNode(row.text))
  }
  body.appendChild(el)
}

// --- Inline Popup Widget ---

class DiffPopupWidget extends WidgetType {
  readonly hunk: DiffHunk
  readonly hunkIndex: number
  readonly totalHunks: number

  constructor(hunk: DiffHunk, hunkIndex: number, totalHunks: number) {
    super()
    this.hunk = hunk
    this.hunkIndex = hunkIndex
    this.totalHunks = totalHunks
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement('div')
    wrap.className = 'cm-diff-popup'

    const accentColor = BADGE_COLORS[this.hunk.type]
    wrap.style.borderLeftColor = accentColor

    // Header
    const header = document.createElement('div')
    header.className = 'cm-diff-popup-header'

    // Change badge
    const badge = document.createElement('span')
    badge.className = 'cm-diff-popup-badge'
    badge.textContent = BADGE_LABELS[this.hunk.type]
    badge.style.color = accentColor
    badge.style.fontWeight = '600'
    badge.style.fontSize = '11px'
    header.appendChild(badge)

    // Hunk header text (with deletion context for deleted-only hunks)
    const headerText = document.createElement('span')
    if (this.hunk.type === 'deleted') {
      headerText.textContent = `${this.hunk.stats.deleted} lines deleted nearby`
    } else {
      headerText.textContent = this.hunk.header
    }
    headerText.style.marginLeft = '8px'
    headerText.style.opacity = '0.7'
    header.appendChild(headerText)

    // Nav + close controls
    const controls = document.createElement('span')
    controls.style.marginLeft = 'auto'
    controls.style.display = 'flex'
    controls.style.gap = '4px'
    controls.style.alignItems = 'center'

    // Prev button
    if (this.totalHunks > 1) {
      const prevBtn = document.createElement('button')
      prevBtn.className = 'cm-diff-popup-nav'
      prevBtn.textContent = '\u2191'
      prevBtn.title = 'Previous change'
      prevBtn.disabled = this.hunkIndex === 0
      prevBtn.onclick = (e) => {
        e.preventDefault()
        e.stopPropagation()
        const { hunks } = view.state.field(diffState)
        const prevHunk = hunks[this.hunkIndex - 1]
        if (prevHunk) view.dispatch({ effects: toggleHunkPopup.of(prevHunk.id) })
      }
      controls.appendChild(prevBtn)

      const nextBtn = document.createElement('button')
      nextBtn.className = 'cm-diff-popup-nav'
      nextBtn.textContent = '\u2193'
      nextBtn.title = 'Next change'
      nextBtn.disabled = this.hunkIndex === this.totalHunks - 1
      nextBtn.onclick = (e) => {
        e.preventDefault()
        e.stopPropagation()
        const { hunks } = view.state.field(diffState)
        const nextHunk = hunks[this.hunkIndex + 1]
        if (nextHunk) view.dispatch({ effects: toggleHunkPopup.of(nextHunk.id) })
      }
      controls.appendChild(nextBtn)

      // Hunk counter
      const counter = document.createElement('span')
      counter.style.fontSize = '10px'
      counter.style.opacity = '0.6'
      counter.textContent = `${this.hunkIndex + 1}/${this.totalHunks}`
      controls.appendChild(counter)
    }

    const closeBtn = document.createElement('button')
    closeBtn.textContent = '\u00D7'
    closeBtn.className = 'cm-diff-popup-close'
    closeBtn.onclick = (e) => {
      e.preventDefault()
      e.stopPropagation()
      view.dispatch({ effects: closePopup.of(null) })
    }
    controls.appendChild(closeBtn)
    header.appendChild(controls)
    wrap.appendChild(header)

    // Body
    const body = document.createElement('div')
    body.className = 'cm-diff-popup-body'

    const rows = this.hunk.rows
    const truncated = rows.length > TRUNCATE_ROWS

    const visibleRows = truncated ? rows.slice(0, TRUNCATE_ROWS) : rows
    for (const row of visibleRows) {
      renderRow(row, body)
    }

    // Show more button
    if (truncated) {
      const showMore = document.createElement('div')
      showMore.className = 'cm-diff-popup-showmore'
      showMore.textContent = `Show ${rows.length - TRUNCATE_ROWS} more lines`
      showMore.onclick = () => {
        // Render remaining rows and remove button
        for (let i = TRUNCATE_ROWS; i < rows.length; i++) {
          renderRow(rows[i], body)
        }
        showMore.remove()
      }
      body.appendChild(showMore)
    }

    wrap.appendChild(body)
    return wrap
  }

  ignoreEvent() { return true }
}

const popupDecoration = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    const popupChanged = tr.effects.some(e => e.is(setDiffData) || e.is(toggleHunkPopup) || e.is(closePopup))
    if (!popupChanged && !tr.docChanged) return value

    const { hunks, openHunkId } = tr.state.field(diffState)
    if (!openHunkId) return Decoration.none

    const hunkIndex = hunks.findIndex(h => h.id === openHunkId)
    if (hunkIndex === -1) return Decoration.none
    const hunk = hunks[hunkIndex]

    const doc = tr.state.doc
    const anchorLine = Math.max(1, Math.min(hunk.anchorLine, doc.lines))
    const line = doc.line(anchorLine)

    return Decoration.set([
      Decoration.widget({
        widget: new DiffPopupWidget(hunk, hunkIndex, hunks.length),
        block: true,
        side: 1,
      }).range(line.to),
    ])
  },
  provide: f => EditorView.decorations.from(f),
})

// --- Dismiss handlers ---

const escapeKeymap = keymap.of([{
  key: 'Escape',
  run(view) {
    if (view.state.field(diffState).openHunkId) {
      view.dispatch({ effects: closePopup.of(null) })
      return true
    }
    return false
  },
}])

const clickOutsideDismiss = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (!view.state.field(diffState).openHunkId) return false
    const target = event.target as HTMLElement
    if (target.closest('.cm-diff-popup') || target.closest('.cm-diff-gutter')) return false
    requestAnimationFrame(() => {
      view.dispatch({ effects: closePopup.of(null) })
    })
    return false
  },
})

// --- Extension Factory ---

export function diffGutterExtension() {
  return [
    diffState,
    diffGutter,
    lineDecorations,
    popupDecoration,
    escapeKeymap,
    clickOutsideDismiss,
  ]
}
