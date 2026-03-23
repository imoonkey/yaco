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
import type { DiffHunk, ChangeType } from './parseDiff'
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
        // If open hunk no longer exists, close
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
    return update.transactions.some(tr => tr.effects.some(e => e.is(setDiffData) || e.is(toggleHunkPopup) || e.is(closePopup)))
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

    // Collect all decorations sorted by position
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

// --- Inline Popup Widget ---

class DiffPopupWidget extends WidgetType {
  readonly hunk: DiffHunk
  constructor(hunk: DiffHunk) { super(); this.hunk = hunk }

  eq(other: DiffPopupWidget) { return this.hunk.id === other.hunk.id }

  toDOM(view: EditorView) {
    const wrap = document.createElement('div')
    wrap.className = 'cm-diff-popup'

    const accentColor = this.hunk.type === 'added' ? SOLARIZED_LIGHT.green
      : this.hunk.type === 'modified' ? SOLARIZED_LIGHT.blue
      : SOLARIZED_LIGHT.red
    wrap.style.borderLeftColor = accentColor

    // Header
    const header = document.createElement('div')
    header.className = 'cm-diff-popup-header'
    const headerText = document.createElement('span')
    headerText.textContent = this.hunk.header
    header.appendChild(headerText)

    const closeBtn = document.createElement('button')
    closeBtn.textContent = '\u00D7'
    closeBtn.className = 'cm-diff-popup-close'
    closeBtn.onclick = (e) => {
      e.preventDefault()
      e.stopPropagation()
      view.dispatch({ effects: closePopup.of(null) })
    }
    header.appendChild(closeBtn)
    wrap.appendChild(header)

    // Body
    const body = document.createElement('div')
    body.className = 'cm-diff-popup-body'
    for (const change of this.hunk.changes) {
      const row = document.createElement('div')
      row.className = `cm-diff-popup-line cm-diff-popup-${change.type}`
      const prefix = change.type === 'add' ? '+' : change.type === 'del' ? '-' : ' '
      row.textContent = prefix + change.content
      body.appendChild(row)
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

    const hunk = hunks.find(h => h.id === openHunkId)
    if (!hunk) return Decoration.none

    const doc = tr.state.doc
    const anchorLine = Math.max(1, Math.min(hunk.anchorLine, doc.lines))
    const line = doc.line(anchorLine)

    return Decoration.set([
      Decoration.widget({
        widget: new DiffPopupWidget(hunk),
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
    view.dispatch({ effects: closePopup.of(null) })
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
