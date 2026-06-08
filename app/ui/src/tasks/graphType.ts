// Graph typography — an intentional SECOND source of font sizes.
//
// The rest of app/ui sizes type through the `--text-ui-*` CSS tokens. The
// task-graph subsystem cannot: canvas `ctx.font` is a string the 2D context
// parses ITSELF and cannot resolve CSS `var()`, so title-width measurement
// (TaskGraphNode) and the rail-width math (metadataRail) both need a JS-numeric
// size. SVG `<text fontSize>` could read a token, but render and measurement
// must agree on one number, so the whole graph reads from here — render and
// measurement share the same constant and stay internally single-sourced. This
// is the same canvas-measurement coupling that justifies xterm's literal size;
// it is a deliberate, documented exception to the global token scale, not an
// oversight.

export const TITLE_FONT_SIZE = 13 // node title + canvas measurement font
export const ESTIMATE_FONT_SIZE = 9 // estimate badge
export const COUNT_FONT_SIZE = 10 // group progress / dep count / edge count / ruler ticks
export const SECTION_FONT_SIZE = 11 // workset section header

export const RAIL_FONT_SIZE = 10.5 // metadata rail badge text
// Monospace glyph advance at RAIL_FONT_SIZE. DERIVED so a font-size edit cannot
// desync the rail width math from the rendered text.
export const RAIL_CHAR_W = RAIL_FONT_SIZE * 0.6
