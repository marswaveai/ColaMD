// 放映幻灯片 (View → Play Slideshow).
//
// A deck is the document cut at its thematic breaks. Pages are taken from the
// RENDERED document, never from the Markdown text: every `---` is already an
// <hr> in the editor's DOM, and a `---` inside a fenced code block is plain
// text there, so nothing is re-parsed and nothing can be misread. The file's
// frontmatter is not in the editor at all, so it cannot become a page either.
//
// A page is shown by hiding the blocks around it with one injected stylesheet
// rule range — not by cloning, and not by touching the editor's DOM. That the
// document keeps its own blocks is the whole point: theme typography, tables,
// formulas, diagrams and images arrive intact with no second renderer to keep
// in sync, and ProseMirror never sees a DOM change it did not make (clicking
// through a deck must not look like an external edit).

type Page = {
  /** Index of the page's first top-level block, in the editor's children. */
  start: number
  /** Index of its last one, inclusive. */
  end: number
  /** That first block, kept so leaving the deck can show the page again. */
  first: Element
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
let pages: Page[] = []
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

function documentRoot(): HTMLElement | null {
  return document.querySelector('#editor .ProseMirror') as HTMLElement | null
}

// Group the top-level blocks between thematic breaks. A group with no block of
// its own is not a page: two separators in a row (a leading `---`, a stray one
// at the end) should not become a blank slide nobody asked for.
function collectPages(root: Element): Page[] {
  const children = Array.from(root.children)
  const found: Page[] = []
  let start = -1
  let blocks = 0

  const close = (end: number): void => {
    if (start >= 0 && blocks > 0) found.push({ start, end: end - 1, first: children[start] })
    start = -1
    blocks = 0
  }

  children.forEach((child, i) => {
    if (child.tagName === 'HR') {
      close(i)
      return
    }
    if (start < 0) start = i
    blocks += 1
  })
  close(children.length)
  return found
}

// Open a deck where the writer is working, not always on page one: a 40 page
// document is not presented from the top every time it is checked.
function pageAtCaret(root: Element, deck: Page[]): number {
  const anchor = window.getSelection()?.anchorNode ?? null
  if (!anchor || !root.contains(anchor)) return 0
  const inside = anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement
  let block: Element | null = inside
  while (block && block.parentElement !== root) block = block.parentElement
  if (!block) return 0
  const position = Array.prototype.indexOf.call(root.children, block)
  const found = deck.findIndex((page) => position >= page.start && position <= page.end)
  return found > 0 ? found : 0
}

// One rule range instead of a class per block: hiding the two stretches outside
// the page leaves the page's own blocks untouched, so their styles, their image
// sizes and their node views are exactly what the editor had.
function applyPage(): void {
  if (!rules) return
  const page = pages[index]
  const hidden: string[] = []
  if (page.start > 0) {
    hidden.push(`body.${PRESENTING_CLASS} #editor .ProseMirror > :nth-child(-n+${page.start})`)
  }
  // 1-based index of the first block past the page, so the separator that ends
  // the page goes with the hidden stretch.
  hidden.push(`body.${PRESENTING_CLASS} #editor .ProseMirror > :nth-child(n+${page.end + 2})`)
  rules.textContent = `${hidden.join(',\n')} { display: none !important; }\n` +
    // The page's own first block keeps the space it would have had in the
    // document, which is space above nothing: flush, so the page centres on its
    // text rather than on that gap.
    `body.${PRESENTING_CLASS} #editor .ProseMirror > :nth-child(${page.start + 1}) { margin-top: 0 !important; }`
}

function show(next: number): void {
  const clamped = Math.max(0, Math.min(next, pages.length - 1))
  if (clamped === index) return
  index = clamped
  applyPage()
  // A new page starts at its own top, however far the last one was scrolled.
  const editor = editorElement()
  if (editor) editor.scrollTop = 0
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
  const deck = collectPages(root)
  if (deck.length === 0) return false

  pages = deck
  options = next
  index = pageAtCaret(root, deck)

  // A page is a position in the document. If the document is replaced under the
  // deck (an edit from another program, another window), those positions stop
  // meaning what they meant, and a presentation showing the wrong page is worse
  // than no presentation: leave as soon as the blocks we measured are gone.
  // The caller stops the deck on the paths it owns; this catches the rest.
  const blocks = deck.length ? Array.from(root.children).slice(deck[0].start, deck[deck.length - 1].end + 1) : []
  watch = new MutationObserver(() => {
    if (blocks.some((block) => !block.isConnected)) stopSlideshow()
  })
  watch.observe(root, { childList: true })

  rules = document.createElement('style')
  rules.id = RULE_STYLE_ID
  document.head.appendChild(rules)
  applyPage()

  document.body.classList.add(PRESENTING_CLASS)
  layout()
  editor.scrollTop = 0
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
  if (lastShown?.first.isConnected) claimPage(lastShown.first)
}
