// 导出幻灯片 PDF (File → Export Slides PDF).
//
// 一页就是一个 `---`，切法与放映共用一处：装饰层按语法树里的 HorizontalRule 给每一行
// 打上页码类（`cm-md-page-N`，见 editor/live-preview.ts 的 collectPages）。这里不再自己
// 数 DOM 的第几个孩子：CM6 会往正文里插 gap 元素，序号对不上。
//
// 主进程负责文件和对话框；这个模块负责「把编辑面变成纸」：把窗口变成一张张 16:9 的纸，
// 量出每页内容落在纸上的高度，然后还原。
//
// 它不动编辑器的 DOM。每页的第一行带 `break-before: page`，上方那片空白用 `::before`
// 撑出来而不是 margin：margin 正是打印排版在分页处允许丢掉的东西，padding 又会把块自己
// 的底色一起带走。

import { PAGE_CLASS_PREFIX, PAGE_START_CLASS } from './editor/live-preview'
import { deckPages } from './slideshow'
import { renderWholeDocument, restoreViewport } from './print-layout'

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

function documentRoot(): HTMLElement | null {
  return document.querySelector('#editor .cm-content') as HTMLElement | null
}

function scroller(): HTMLElement | null {
  return document.querySelector('#editor .cm-scroller') as HTMLElement | null
}

function pageOfLine(line: Element): number | null {
  const match = new RegExp(`(?:^|\\s)${PAGE_CLASS_PREFIX}(\\d+)(?:\\s|$)`).exec(line.className ?? '')
  return match ? Number(match[1]) : null
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
/* 纸是普通的块流：CM6 的编辑器/滚动容器都是 flex 或 auto 高度，强制断开的分页在
   它们里面不会生效，所以这里把它们摊平成块。 */
body.${PRINT_CLASS} #editor .cm-editor { height: auto !important; }
body.${PRINT_CLASS} #editor .cm-scroller { display: block !important; height: auto !important; overflow: visible !important; }
body.${PRINT_CLASS} #editor .cm-content {
  display: block !important;
  width: min(${COLUMN_EM}em, ${Math.round(PAGE_WIDTH_PX * 0.86)}px) !important;
  max-width: none !important;
  margin: 0 auto !important;
  padding: 0 !important;
  font-size: ${FONT_SIZE_PX}px !important;
  line-height: 1.6;
}
/* 分隔线是分页边界，不是正文里的一行。 */
body.${PRINT_CLASS} #editor .cm-line.cm-md-hr { display: none !important; }
/* Nothing may be cut off at the sheet's edge: code and cells wrap, a diagram or
   a photo shrinks to fit the page it landed on. */
body.${PRINT_CLASS} #editor .cm-md-codeblock { white-space: pre-wrap !important; overflow-wrap: anywhere !important; }
body.${PRINT_CLASS} #editor .cm-md-table-widget th, body.${PRINT_CLASS} #editor .cm-md-table-widget td { overflow-wrap: anywhere !important; word-break: break-word !important; }
body.${PRINT_CLASS} #editor img, body.${PRINT_CLASS} #editor svg { max-height: ${Math.round(PAGE_HEIGHT_PX * 0.72)}px; }
`
}

// Turn the window into sheets and remember the page size, or return false when
// there is nothing to export (no editor, no document).
export async function enterPrintLayout(): Promise<SlidesSheet | false> {
  if (sheetStyle) return { width: PAGE_WIDTH_INCHES, height: PAGE_HEIGHT_INCHES }
  const root = documentRoot()
  if (!root) return false

  const background = getComputedStyle(document.body).backgroundColor
  const sheet = document.createElement('style')
  sheet.id = STYLE_ID
  sheet.textContent = layoutRules(background)
  document.head.appendChild(sheet)
  document.body.classList.add(PRINT_CLASS)
  sheetStyle = sheet
  restoreScrollTop = scroller()?.scrollTop ?? 0

  // Measure on paper, never on screen: a page's height depends on the width and
  // the type size it is printed at, and this read is what makes the rules above
  // take effect before anything is measured.
  root.getBoundingClientRect()

  // 摊平之后还要等 CodeMirror 把整篇渲染出来。页数和页高都要量在整篇上：
  // 不等这一步，长文档只有视口里那几页，后面的页根本不在 DOM 里（2026-09-26 报的）。
  await renderWholeDocument()

  const deck = deckPages()
  if (deck.length === 0) {
    exitPrintLayout()
    return false
  }

  const rules: string[] = []
  deck.forEach((page, order) => {
    const first = root.querySelector(`.${PAGE_CLASS_PREFIX}${page}.${PAGE_START_CLASS}`) as HTMLElement | null
    const lines = Array.from(root.children).filter(
      (line) => pageOfLine(line) === page && !line.classList.contains('cm-md-hr'),
    ) as HTMLElement[]
    const last = lines[lines.length - 1]
    if (!first || !last) return
    // The first line is measured without its own margin (a border box has none),
    // yet that margin is on the page as well.
    const ownMargin = parseFloat(getComputedStyle(first).marginTop)
    const owned = last.getBoundingClientRect().bottom - first.getBoundingClientRect().top
    const used = owned + (Number.isFinite(ownMargin) ? ownMargin : 0)
    const above = Math.max(0, Math.floor((PAGE_HEIGHT_PX - SAFETY_PX - used) / 2))
    const target = `.cm-content > .${PAGE_CLASS_PREFIX}${page}.${PAGE_START_CLASS}`
    if (order > 0) rules.push(`body.${PRINT_CLASS} #editor ${target} { break-before: page; }`)
    if (above > 0) {
      rules.push(`body.${PRINT_CLASS} #editor ${target}::before { content: ''; display: block; height: ${above}px; }`)
    }
  })

  sheet.textContent = layoutRules(background) + rules.join('\n') + '\n'
  return { width: PAGE_WIDTH_INCHES, height: PAGE_HEIGHT_INCHES }
}

export function exitPrintLayout(): void {
  restoreViewport()
  if (!sheetStyle) return
  sheetStyle.remove()
  sheetStyle = null
  document.body.classList.remove(PRINT_CLASS)
  const scroll = scroller()
  if (scroll) scroll.scrollTop = restoreScrollTop
}
