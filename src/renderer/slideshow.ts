// 放映幻灯片 (View → Play Slideshow).
//
// 一页就是一个 `---`。切法只有一处：装饰层按语法树里的 HorizontalRule 给每一行打上
// 页码类（`cm-md-page-N`，见 editor/live-preview.ts 的 collectPages）。放映这里不再自己
// 数 DOM 的第几个孩子：CM6 会往正文里插 gap 元素，序号对不上；而用类名判断，
// `---` 在代码块里根本不是 HorizontalRule，也就不会被误当分页。
//
// 一页的显示方式是「只留这一页的行」：一条注入的样式把 `.cm-content` 下不属于当前页的
// 行藏起来。不克隆、不动编辑器的 DOM，所以主题排版、表格、公式、图与图片都原样到场，
// 也没有第二个渲染器要同步。

import { PAGE_CLASS_PREFIX, PAGE_START_CLASS } from './editor/live-preview'

export type Page = {
  /** 页码，就是行装饰里的那个 N。 */
  number: number
}

type SlideshowOptions = {
  /** Editing is the caller's to freeze; the surface cannot see the editor. */
  onStart?: () => void
  /** Called once the surface is gone, whatever the reason for leaving. */
  onExit?: () => void
}

const PRESENTING_CLASS = 'presenting'
const RULE_STYLE_ID = 'slideshow-rules'
// A press that moved further than this was a drag (selecting text on a slide),
// not a request for the next page.
const DRAG_SLOP = 4

let presenting = false
let pages: number[] = []
let index = 0
let rules: HTMLStyleElement | null = null
let options: SlideshowOptions = {}
let pressAt: { x: number; y: number } | null = null
let watch: MutationObserver | null = null

export function isPresenting(): boolean {
  return presenting
}

function editorElement(): HTMLElement | null {
  return document.getElementById('editor')
}

/** 正文容器。CM6 的滚动发生在 `.cm-scroller` 上，`#editor` 自己不动。 */
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

/**
 * 文档里真正有内容的页码。
 *
 * 只有分隔线的那一页不算一页：开头一个 `---`、结尾一个 `---`、或者两个 `---` 挨着，
 * 都不该变成一张没有人要的空白幻灯片。
 */
function pageNumbers(root: Element): number[] {
  const found = new Set<number>()
  for (const line of Array.from(root.children)) {
    const page = pageOfLine(line)
    if (page === null) continue
    if (line.classList.contains('cm-md-hr')) continue
    found.add(page)
  }
  return [...found].sort((a, b) => a - b)
}

/** 文档的分页。导出幻灯片 PDF 读这里，不自己再算一遍切法。 */
export function deckPages(): number[] {
  const root = documentRoot()
  return root ? pageNumbers(root) : []
}

function firstLineOf(page: number): Element | null {
  const root = documentRoot()
  if (!root) return null
  return (
    root.querySelector(`.${PAGE_CLASS_PREFIX}${page}.${PAGE_START_CLASS}`) ??
    root.querySelector(`.${PAGE_CLASS_PREFIX}${page}`)
  )
}

// Open a deck where the writer is working, not always on page one: a 40 page
// document is not presented from the top every time it is checked.
function pageAtCaret(root: Element): number {
  const anchor = window.getSelection()?.anchorNode ?? null
  if (!anchor || !root.contains(anchor)) return 0
  const inside = anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement
  const line = inside?.closest?.('.cm-line')
  const page = line ? pageOfLine(line) : null
  if (page === null) return 0
  const found = pages.indexOf(page)
  return found > 0 ? found : 0
}

function applyPage(): void {
  if (!rules) return
  const page = pages[index]
  rules.textContent =
    `body.${PRESENTING_CLASS} #editor .cm-content > :not(.${PAGE_CLASS_PREFIX}${page}) { display: none !important; }\n`
}

function show(next: number): void {
  const clamped = Math.max(0, Math.min(next, pages.length - 1))
  if (clamped === index) return
  index = clamped
  applyPage()
  // A new page starts at its own top, however far the last one was scrolled.
  const scroll = scroller()
  if (scroll) scroll.scrollTop = 0
}

// The document is em-based, so one number scales headings, code, formulas and
// diagrams together. Read off the window so a laptop and a 4K display both look
// deliberate rather than merely larger.
function layout(): void {
  const editor = editorElement()
  if (!editor) return
  const scale = Math.min(window.innerWidth / 1440, window.innerHeight / 900)
  const size = Math.round(Math.min(Math.max(24 * scale, 20), 44))
  editor.style.setProperty('--slide-font-size', `${size}px`)
}

// Put one block at the top of the view, and keep saying so while the window is
// changing size. Leaving a deck gives back the screen's space, the editor
// re-lays out under the new size, and a position written before that lands
// somewhere else; the listener lives only for the length of that transition, so
// it can never fight the reader's own scrolling.
function claimPage(block: Element): void {
  const claim = (): void => {
    if (block.isConnected) block.scrollIntoView({ block: 'start' })
  }
  claim()
  window.addEventListener('resize', claim)
  setTimeout(() => window.removeEventListener('resize', claim), 2500)
}

function onKeyDown(event: KeyboardEvent): void {
  // Leave the app's own shortcuts alone (⌘⇧P leaves the deck, ⌘Q quits, ⌘+click
  // opens a link). Only plain keys belong to the deck.
  if (event.metaKey || event.ctrlKey || event.altKey) return
  let handled = true
  switch (event.key) {
    case 'Escape':
      stopSlideshow()
      break
    case 'ArrowRight':
    case 'ArrowDown':
    case 'PageDown':
    case 'Enter':
    case ' ':
      show(index + 1)
      break
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'PageUp':
    case 'Backspace':
      show(index - 1)
      break
    case 'Home':
      show(0)
      break
    case 'End':
      show(pages.length - 1)
      break
    default:
      handled = false
  }
  // A key the deck does not own is stopped from reaching the editor as well: a
  // frozen surface must not take input even if the freeze is undone elsewhere.
  event.stopPropagation()
  if (handled) event.preventDefault()
}

function onMouseDown(event: MouseEvent): void {
  pressAt = event.metaKey || event.ctrlKey ? null : { x: event.clientX, y: event.clientY }
}

function onClick(event: MouseEvent): void {
  const press = pressAt
  pressAt = null
  if (event.metaKey || event.ctrlKey) return
  if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > DRAG_SLOP) return
  // A link is a link: in-document anchors jump, ⌘+click opens the browser. The
  // app already decides that; the deck must not eat the click as a page turn.
  if ((event.target as Element | null)?.closest?.('a')) return
  event.preventDefault()
  event.stopPropagation()
  show(index + 1)
}

function onContextMenu(event: MouseEvent): void {
  // Right click is the one gesture a presentation needs that the keyboard has
  // too: back one page, and no system menu over the slide.
  event.preventDefault()
  event.stopPropagation()
  show(index - 1)
}

export function startSlideshow(next: SlideshowOptions = {}): boolean {
  if (presenting) return true
  const editor = editorElement()
  const root = documentRoot()
  if (!editor || !root) return false
  const deck = pageNumbers(root)
  if (deck.length === 0) return false

  pages = deck
  options = next
  index = pageAtCaret(root)

  // A page is a position in the document. If the document is replaced under the
  // deck (an edit from another program, another window), those positions stop
  // meaning what they meant, and a presentation showing the wrong page is worse
  // than no presentation: leave as soon as the page we are showing is gone.
  const shownLine = firstLineOf(pages[index])
  watch = new MutationObserver(() => {
    if (shownLine && !shownLine.isConnected) stopSlideshow()
  })
  watch.observe(root, { childList: true })

  rules = document.createElement('style')
  rules.id = RULE_STYLE_ID
  document.head.appendChild(rules)
  applyPage()

  document.body.classList.add(PRESENTING_CLASS)
  layout()
  const scroll = scroller()
  if (scroll) scroll.scrollTop = 0
  presenting = true

  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('mousedown', onMouseDown, true)
  window.addEventListener('click', onClick, true)
  window.addEventListener('contextmenu', onContextMenu, true)
  window.addEventListener('resize', layout)

  options.onStart?.()
  return true
}

export function stopSlideshow(): void {
  if (!presenting) return
  presenting = false
  window.removeEventListener('keydown', onKeyDown, true)
  window.removeEventListener('mousedown', onMouseDown, true)
  window.removeEventListener('click', onClick, true)
  window.removeEventListener('contextmenu', onContextMenu, true)
  window.removeEventListener('resize', layout)
  watch?.disconnect()
  watch = null

  document.body.classList.remove(PRESENTING_CLASS)
  rules?.remove()
  rules = null
  const editor = editorElement()
  // Before the deck is forgotten: the page that was on screen is what the
  // viewport goes back to.
  const lastShown = pages[index]
  pages = []
  index = 0
  pressAt = null
  const done = options.onExit
  options = {}
  done?.()

  if (editor) editor.style.removeProperty('--slide-font-size')
  // Leaving a deck lands on the page that was on screen. Restoring the scroll
  // offset from before the deck would be restoring a position in a document
  // whose other pages were hidden while the deck was up, and the caret is not a
  // guide either: presenting pages 1 to 5 and landing back at the top reads as
  // having lost your place.
  if (lastShown !== undefined) {
    const line = firstLineOf(lastShown)
    if (line) claimPage(line)
  }
}
