// 导出幻灯片 PDF (File → Export Slides PDF).
//
// The same cut as the deck — the rendered document split at its thematic
// breaks, so one `---` is one page — laid out as sheets instead of shown one at
// a time. The main process owns the file and the dialog; this module owns the
// page: it turns the editing surface into paper, measures where each page's
// content sits on its sheet, and puts the editor back afterwards.
//
// Nothing here touches the editor's DOM. A run of blocks after the first is
// pushed onto its own sheet with `break-before`, and the empty space above it is
// a `::before` spacer rather than a margin: a margin is exactly what print
// layout is allowed to discard at a page break, and a padding would take the
// block's own background with it.

import { deckPages } from './slideshow'

/** 16:9, the shape a projector expects and the shape the deck fills. */
const PAGE_WIDTH_INCHES = 13.3333
const PAGE_HEIGHT_INCHES = 7.5

/** Chromium prints at 96 CSS pixels to the inch. */
const PX_PER_INCH = 96
const PAGE_WIDTH_PX = Math.round(PAGE_WIDTH_INCHES * PX_PER_INCH)
const PAGE_HEIGHT_PX = Math.round(PAGE_HEIGHT_INCHES * PX_PER_INCH)
/** The deck's column and type size at this page, so a sheet reads as a slide. */
const COLUMN_EM = 38
const FONT_SIZE_PX = 20
/** A page that fills its sheet exactly is a page that spills over it: leave a hair. */
const SAFETY_PX = 4

const PRINT_CLASS = 'slides-printing'
const STYLE_ID = 'slides-print-style'

export type SlidesSheet = { width: number; height: number }

let sheetStyle: HTMLStyleElement | null = null
let restoreScrollTop = 0

declare global {
  interface Window {
    /** The main process asks the document to become paper through this. */
    __colamdSlidesExport?: { enter: () => Promise<SlidesSheet | false>; exit: () => void }
  }
}

function layoutRules(background: string): string {
  return `/* The sheet is the page: what margins exist in here are the document's own. */
@page { size: ${PAGE_WIDTH_INCHES}in ${PAGE_HEIGHT_INCHES}in; margin: 0; background: ${background}; }
html, body { display: block !important; height: auto !important; overflow: visible !important; background: ${background} !important; }
body.${PRINT_CLASS} #editor {
  position: static !important;
  inset: auto !important;
  height: auto !important;
  overflow: visible !important;
  padding: 0 !important;
  background: ${background} !important;
}
/* The wrapper is a flex column on screen; paper is a plain block, so that a
   forced break between two blocks means what it says. */
body.${PRINT_CLASS} #editor > .milkdown { display: block !important; min-height: 0 !important; }
body.${PRINT_CLASS} #editor .ProseMirror {
  width: min(${COLUMN_EM}em, ${Math.round(PAGE_WIDTH_PX * 0.86)}px);
  max-width: none !important;
  margin: 0 auto !important;
  padding: 0 !important;
  font-size: ${FONT_SIZE_PX}px !important;
  line-height: 1.6;
}
/* A separator is a page boundary, not a line of the document. */
body.${PRINT_CLASS} #editor .ProseMirror > hr { display: none !important; }
/* Nothing may be cut off at the sheet's edge: code and cells wrap, a diagram or
   a photo shrinks to fit the page it landed on. */
body.${PRINT_CLASS} #editor .ProseMirror pre { white-space: pre-wrap !important; overflow: visible !important; overflow-wrap: anywhere !important; }
body.${PRINT_CLASS} #editor .ProseMirror th, body.${PRINT_CLASS} #editor .ProseMirror td { overflow-wrap: anywhere !important; word-break: break-word !important; }
body.${PRINT_CLASS} #editor .ProseMirror img, body.${PRINT_CLASS} #editor .ProseMirror svg { max-height: ${Math.round(PAGE_HEIGHT_PX * 0.72)}px; }
`
}

// Turn the window into sheets and remember the page size, or return false when
// there is nothing to export (no editor, no document).
export function enterPrintLayout(): SlidesSheet | false {
  if (sheetStyle) return { width: PAGE_WIDTH_INCHES, height: PAGE_HEIGHT_INCHES }
  const root = document.querySelector('#editor .ProseMirror') as HTMLElement | null
  if (!root) return false
  const deck = deckPages()
  if (deck.length === 0) return false

  const children = Array.from(root.children)
  const background = getComputedStyle(document.body).backgroundColor
  const sheet = document.createElement('style')
  sheet.id = STYLE_ID
  sheet.textContent = layoutRules(background)
  document.head.appendChild(sheet)
  document.body.classList.add(PRINT_CLASS)
  sheetStyle = sheet
  restoreScrollTop = (document.getElementById('editor') as HTMLElement | null)?.scrollTop ?? 0

  // Measure on paper, never on screen: a run's height depends on the width and
  // the type size it is printed at, and this read is what makes the rules above
  // take effect before anything is measured.
  root.getBoundingClientRect()

  const rules: string[] = []
  deck.forEach((entry, index) => {
    const first = children[entry.start] as HTMLElement | undefined
    const last = children[entry.end] as HTMLElement | undefined
    if (!first || !last) return
    // The first block is measured without its own margin (a border box has
    // none), yet that margin is on the page as well.
    const ownMargin = parseFloat(getComputedStyle(first).marginTop)
    const owned = last.getBoundingClientRect().bottom - first.getBoundingClientRect().top
    const used = owned + (Number.isFinite(ownMargin) ? ownMargin : 0)
    const above = Math.max(0, Math.floor((PAGE_HEIGHT_PX - SAFETY_PX - used) / 2))
    const target = `body.${PRINT_CLASS} #editor .ProseMirror > :nth-child(${entry.start + 1})`
    if (index > 0) rules.push(`${target} { break-before: page; }`)
    if (above > 0) {
      rules.push(`${target}::before { content: ''; display: block; height: ${above}px; }`)
    }
  })

  sheet.textContent = layoutRules(background) + rules.join('\n') + '\n'
  return { width: PAGE_WIDTH_INCHES, height: PAGE_HEIGHT_INCHES }
}

export function exitPrintLayout(): void {
  if (!sheetStyle) return
  sheetStyle.remove()
  sheetStyle = null
  document.body.classList.remove(PRINT_CLASS)
  const editor = document.getElementById('editor') as HTMLElement | null
  if (editor) editor.scrollTop = restoreScrollTop
}
