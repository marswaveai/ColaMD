// 编辑器：文本优先核心对外的一层薄适配。
//
// 这个文件曾经是 milkdown/ProseMirror 的集成层，现在它只做一件事：
// 把外壳需要的 18 个函数，接到 src/renderer/editor/core.ts 的 CodeMirror 6 缓冲区上。
//
// **导出的签名全部保持不变。** 外壳（标签、文件面板、大纲、导出、主题、IPC）
// 不需要知道内部换了实现，它只认这几个函数。因此这次替换是局部的：外壳不动。
//
// 设计原则见 docs/editor-architecture.md。一句话：缓冲区里存的就是文件的字节，
// 渲染是叠在上面的一层装饰，保存时原样写回，不做任何序列化。

import { EditorSelection, type EditorState, type SelectionRange } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { createEditorCore, getEditorHandle, type EditorHandle } from './core'
import { footnoteDefinitions } from './footnotes'
import { selectionHTMLFrom } from './clean-html'
import { renderWholeDocument, restoreViewport } from '../print-layout'

import { headingFlashEffect, setCleanExport as setCleanExportEffect, setDocumentFileUrlEffect, primeDocumentFileUrl } from './live-preview'
import { runFormatCommand as runFormat, type FormatCommandId } from './format-commands'
import { releaseMermaidRenderer as releaseMermaidRendererBridge } from './mermaid-bridge'
import { isChinese } from '../ui-language'

// katex 的样式表仍要引，公式 widget 里渲出来的 HTML 靠它排版。
import 'katex/dist/katex.min.css'

// --- 标题锚点（文档内跳转，见 #50）---

// GitHub 风格的标题 slug：小写、去标点（CJK 与字母保留）、空格变连字符。
// 重复的 slug 依次加 -1、-2 …
function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s+/g, '-')
}

function headingAnchorMap(root: HTMLElement): Map<string, Element> {
  const map = new Map<string, Element>()
  const seen = new Map<string, number>()
  root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading) => {
    const base = slugifyHeading(heading.textContent || '')
    if (!base) return
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    const slug = count === 0 ? base : `${base}-${count}`
    map.set(slug.toLowerCase(), heading)
  })
  return map
}

function findHeadingAnchor(root: HTMLElement, rawTarget: string): Element | null {
  let decoded = rawTarget
  try {
    decoded = decodeURIComponent(rawTarget)
  } catch {
    // 百分号编码坏掉了，拿原文再试
  }
  const map = headingAnchorMap(root)
  return map.get(decoded.toLowerCase()) ?? map.get(slugifyHeading(decoded).toLowerCase()) ?? null
}

// --- 标题跳转的落点反馈（见 #64）---

let headingFlashTimer: ReturnType<typeof setTimeout> | null = null

export type EditorJumpPhase = 'start' | 'settle'
let editorJumpPhaseListener: ((phase: EditorJumpPhase) => void) | null = null
export function onEditorJumpPhase(listener: ((phase: EditorJumpPhase) => void) | null): void {
  editorJumpPhaseListener = listener
}

// 跳转反馈要落在用户实际在看的地方，所以等平滑滚动停稳（scrollend）再闪，
// 而不是在目标还在屏幕外的时候就播（评审 #68）。
export function flashHeadingOnArrival(heading: Element): void {
  const container = document.getElementById('editor')
  if (!container) return
  editorJumpPhaseListener?.('start')
  let startTop = container.scrollTop
  let done = false
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null
  const finish = () => {
    if (done) return
    done = true
    container.removeEventListener('scrollend', finish)
    if (fallbackTimer) clearTimeout(fallbackTimer)
    editorJumpPhaseListener?.('settle')
    applyHeadingFlash(heading)
  }
  container.addEventListener('scrollend', finish)
  // 不滚动时 scrollend 永不触发，需要一个兜底。位置还在变（长距离平滑滚动）就重新计时，
  // 免得在终点之外的地方播掉（评审 #68）。
  fallbackTimer = setTimeout(function armFallback() {
    if (done) return
    if (container.scrollTop !== startTop) {
      startTop = container.scrollTop
      fallbackTimer = setTimeout(armFallback, 400)
      return
    }
    finish()
  }, 1500)
}

// 落点高亮用一条装饰画出来，不往 DOM 上挂 class：
// 外部改 class 会触发 ProseMirror 时代的重绘问题，而 CM6 这边装饰本来就是
// 唯一的画法，顺手也更干净。
// 落点高亮：整行加一条短暂的装饰，不往 DOM 上挂 class。
// 装饰住在 live-preview 的 StateField 里，所以这里要派发一个 effect 让它重算；
// 派发一个空选区事务是不行的（field 只在文档或选区真的变了时才重算）。
function flashLine(view: EditorView, from: number, to: number): void {
  view.dispatch({ effects: headingFlashEffect.of({ from, to }) })
  if (headingFlashTimer) clearTimeout(headingFlashTimer)
  headingFlashTimer = setTimeout(() => {
    const current = getEditorHandle()?.getView()
    if (current) current.dispatch({ effects: headingFlashEffect.of(null) })
  }, 1600)
}

function applyHeadingFlash(heading: Element): void {
  const handle = getEditorHandle()
  if (!handle || !(heading instanceof HTMLElement) || !heading.isConnected) return
  const view = handle.getView()
  const pos = posFromDOM(view, heading)
  if (pos === null) return

  const line = view.state.doc.lineAt(pos)
  flashLine(view, line.from, line.to)
}

/** 用 DOM 元素反查它在文档里的位置。CM6 提供 posAtDOM。 */
function posFromDOM(view: EditorView, element: Element): number | null {
  try {
    return view.posAtDOM(element, 0)
  } catch {
    return null
  }
}

// --- 公式 ---
//
// 公式没有弹层，也没有第二个编辑器。它就是缓冲区里的几行文字：光标进那一行，
// `$...$` 自动显形，就地改；光标离开，重新渲染。点击渲染后的公式只是把光标放进源码。

// --- mermaid ---

export function releaseMermaidRenderer(): void {
  releaseMermaidRendererBridge()
}

// --- 格式命令 ---

export type { FormatCommandId }

export function runFormatCommand(id: FormatCommandId): void {
  const view = getEditorHandle()?.getView()
  if (!view) return
  runFormat(view, id)
}

// --- 生命周期 ---

let handle: EditorHandle | null = null

function defaultContent(): string {
  return isChinese() ? '# **欢迎使用 ColaMD**\n\n开始写作...\n' : '# **Welcome to ColaMD**\n\nStart typing here...\n'
}

export async function createEditor(
  rootId: string,
  onChange?: (markdown: string) => void,
  onDocumentChange?: () => void
): Promise<EditorHandle> {
  const root = document.getElementById(rootId)
  if (!root) throw new Error(`Element #${rootId} not found`)

  handle = createEditorCore(root, {
    doc: defaultContent(),
    onChange: (text) => {
      onChange?.(text)
      onDocumentChange?.()
    },
    editable: true,
  })

  // 装饰层已经在创建编辑器时就装好了（见 core.ts 的 livePreview）。
  installEditorInteractions(root, getViewOf(handle))

  return handle
}

/** 拿到句柄背后的 view。刚创建完一定存在。 */
function getViewOf(handle: EditorHandle): EditorView {
  return handle.getView()
}

/**
 * 编辑器上的交互：文档内锚点跳转、⌘点击开外部链接、任务列表勾选、可复制代码块。
 * 这些行为与用什么编辑器核心无关，都是 DOM 层面的事。
 */
/**
 * 一个元素指向的地址。
 *
 * 链接在正文里不是 `<a>`，而是一段带 `data-href` 的装饰（换成 `<a>` 就得把链接文字整个
 * 换成 widget，文字里的加粗、行内代码会跟着没掉）。这里把两种都认下来：
 * 表格、HTML 块里画出来的真 `<a>` 也算。
 */
function linkHrefOf(target: EventTarget | null): string | null {
  if (!(target instanceof HTMLElement)) return null
  const anchor = target.closest('a[href]')
  if (anchor) return anchor.getAttribute('href')
  const marked = target.closest('[data-href]')
  return marked ? marked.getAttribute('data-href') : null
}

function installEditorInteractions(root: HTMLElement, view: EditorView): void {
  // 文档内锚点是纯导航：在捕获阶段处理掉，别让 CM6 再插手，
  // 否则放置光标（以及它异步的滚动到选区）会盖掉这次标题跳转（#50）。
  root.addEventListener(
    'click',
    (e) => {
      const href = linkHrefOf(e.target)
      if (!href || !href.startsWith('#')) return
      e.preventDefault()
      e.stopPropagation()
      const heading = findHeadingAnchor(root, href.slice(1))
      if (heading) {
        heading.scrollIntoView({ behavior: 'smooth', block: 'start' })
        flashHeadingOnArrival(heading)
      }
    },
    true,
  )

  // ⌘/Ctrl + 点击在浏览器里打开外部链接
  root.addEventListener('click', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return
    const href = linkHrefOf(e.target)
    if (href && !href.startsWith('#')) {
      e.preventDefault()
      window.electronAPI.openExternal(href)
    }
  })

  // 任务列表：点复选框切换勾选。
  // CM6 这边没有节点可以改 attrs，勾选就是改写源码里的 `[ ]` / `[x]`。
  root.addEventListener('click', (e) => {
    if (!(e.target instanceof HTMLElement)) return
    const source = sourceFromTaskClick(view, e)
    if (source === null) return
    e.preventDefault()
    toggleTaskAt(view, source)
  })

  // ⌘/Ctrl+Enter 切换光标所在的任务列表项
  root.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return
    e.preventDefault()
    toggleTaskAt(view, view.state.selection.main.from)
  })

  setupFootnotePreview(root)
  setupRichCopy(root)

  // 代码块右上角的复制按钮：把围栏里的代码原样写进剪贴板
  root.addEventListener('click', (e) => {
    if (!(e.target instanceof HTMLElement)) return
    const button = e.target.closest('.code-copy-btn')
    if (!(button instanceof HTMLElement)) return
    e.preventDefault()
    e.stopPropagation()
    void copyText(button.getAttribute('data-code') ?? '').then((ok) => {
      if (!ok) return
      button.classList.add('copied')
      button.textContent = isChinese() ? '已复制' : 'Copied'
      setTimeout(() => {
        button.classList.remove('copied')
        button.textContent = isChinese() ? '复制' : 'Copy'
      }, 1200)
    })
  })

  // 点击公式：把光标放进这段公式的源码里，就地改。
  //
  // 曾经点一下弹一个编辑框，框里还得再填一次公式（而且填的是空白的，用户得自己把
  // 原来那行删掉）。公式本来就是几行文字，光标进去就能改，不需要第二个地方放它。
  root.addEventListener('click', (e) => {
    const widget = (e.target as HTMLElement).closest('.cm-md-math')
    if (!widget) return
    // 公式在缓冲区里的区间由 widget 自己带出来
    const from = Number(widget.getAttribute('data-math-from'))
    const to = Number(widget.getAttribute('data-math-to'))
    if (!Number.isFinite(from) || !Number.isFinite(to)) return
    e.preventDefault()
    view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true })
    view.focus()
  })
}

/** 写剪贴板。`navigator.clipboard` 在个别环境下会被拒，退回 execCommand。 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  }
}

// --- 脚注悬停预览（#25）---

const FOOTNOTE_PREVIEW_DELAY = 300
// 指针从引用移到卡片上要跨过一段空隙，中间给一点宽限，别一离开就收
const FOOTNOTE_HIDE_GRACE = 120

/**
 * 鼠标停在脚注引用上，浮出它的定义。
 *
 * 定义从**当前文档的文本**里扫出来（footnotes.ts），不查第二份状态：文件就是真相。
 * 悬停区是「引用 + 卡片本身」，所以定义长了可以滚着看。
 */
/**
 * 选区是否完全落在已经渲染出来的范围里。
 *
 * CodeMirror 只为视口内的行建 DOM，其余用 `.cm-gap` 占位元素撑高。富文本口味只能从
 * DOM 里取，所以得先问这一句；不问的后果就是全选复制只得到第一屏（2026-09-26 报的）。
 *
 * 判据用 `.cm-gap` 而不是 `view.visibleRanges`：后者是「装饰没盖住的空隙」，
 * 不是「已经渲染的范围」。实测一篇 13 行的小文档，装饰把它切成两段，
 * `visibleRanges` 就报 `[[0,29],[51,101]]`，看着像有内容没渲染。
 */
function selectionRendered(view: EditorView): boolean {
  if (view.contentDOM.querySelector('.cm-gap')) return false
  const viewport = view.viewport
  return view.state.selection.ranges.every(
    (range) => range.empty || (range.from >= viewport.from && range.to <= viewport.to),
  )
}

/** 选区对应的 DOM 区间。位置从文档坐标换算，所以只要那些行在 DOM 里就能取到。 */
function selectionRange(view: EditorView, ranges: readonly SelectionRange[]): Range {
  const start = view.domAtPos(ranges[0].from)
  const end = view.domAtPos(ranges[ranges.length - 1].to)
  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  return range
}

function selectionHTML(view: EditorView, ranges: readonly SelectionRange[]): string {
  return selectionHTMLFrom(selectionRange(view, ranges).cloneContents())
}

/**
 * 大选区的复制：把整篇渲染出来再取 HTML，然后两个口味一起写回剪贴板。
 *
 * 为什么不在事件里直接写：整篇渲染要等下一帧（实测 35ms 上下），而剪贴板事件是同步的。
 * 纯文本口味在事件里已经给出去了，所以即使这一步失败，粘出来也只是没有排版，不会丢内容。
 */
async function writeRichCopy(
  view: EditorView,
  ranges: readonly SelectionRange[],
  text: string,
): Promise<void> {
  try {
    if (!(await renderWholeDocument())) return
    const html = selectionHTML(view, ranges)
    if (!html) return
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      }),
    ])
  } catch (error) {
    console.error('复制富文本口味失败:', error)
  } finally {
    restoreViewport()
  }
}

/**
 * 复制给两个口味，各自管一种去处：
 *
 *   text/plain 给**原文**（markdown 本身）。它从文档里取，所以总是完整的，不受
 *   「只渲染了视口」影响；粘到 Typora、另一个编辑器、聊天框里，拿到的就是 markdown
 *   原文，可以接着编辑（Obsidian 也是这么做的）。
 *   text/html 给渲染后的样子，粘到 Word、飞书这类富文本去处时用。
 *
 * 为什么挂在 `#editor` 上，而不是 CodeMirror 的事件链里：CodeMirror 自己也处理 copy，
 * 它先 `clearData()` 再写 text/plain。它的监听器在 contentDOM（事件目标）上，我们在祖先上，
 * 所以我们的永远在它之后跑。挂进它的处理器列表反而不确定：内置处理器排在最后，
 * 我们返回 true 也拦不住它，实测 text/html 会被它清掉。
 */
function setupRichCopy(root: HTMLElement): void {
  root.addEventListener('copy', (event) => {
    if (!(event instanceof ClipboardEvent)) return
    const view = getEditorView()
    if (!view) return
    // 没选中东西时不动：CodeMirror 那时复制的是整行，那是它更懂的行为。
    const ranges = view.state.selection.ranges.filter((range) => !range.empty)
    if (ranges.length === 0) return
    const text = ranges.map((range) => view.state.sliceDoc(range.from, range.to)).join('\n')
    event.clipboardData?.setData('text/plain', text)
    if (selectionRendered(view)) {
      const html = selectionHTML(view, ranges)
      if (html) event.clipboardData?.setData('text/html', html)
      return
    }
    // 选区伸到了还没渲染的行上。CodeMirror 只为视口建 DOM，所以此刻拿不到完整的 HTML。
    // 富文本口味只能在事件之后补：先同步给出纯文本口味（它来自文档本身，总是完整的），
    // 再把整篇渲染出来、取 HTML，两个口味一起写回剪贴板。
    event.preventDefault()
    void writeRichCopy(view, ranges, text)
  })
}

function setupFootnotePreview(root: HTMLElement): void {
  const card = document.createElement('div')
  card.className = 'footnote-preview'
  card.hidden = true
  root.appendChild(card)

  let showTimer: ReturnType<typeof setTimeout> | null = null
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let currentRef: HTMLElement | null = null

  const cancelHide = (): void => {
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
  }

  const hide = (): void => {
    cancelHide()
    if (showTimer) {
      clearTimeout(showTimer)
      showTimer = null
    }
    currentRef = null
    card.hidden = true
  }

  const scheduleHide = (): void => {
    cancelHide()
    hideTimer = setTimeout(hide, FOOTNOTE_HIDE_GRACE)
  }

  const inZone = (el: EventTarget | null): boolean => {
    return el instanceof HTMLElement && (card.contains(el) || (currentRef !== null && currentRef.contains(el)))
  }

  const show = (ref: HTMLElement): void => {
    // 定时器跑的时候文档可能已经换了，脱了树的引用绝不能浮出旧卡片
    if (!ref.isConnected) {
      hide()
      return
    }
    const label = ref.getAttribute('data-footnote') ?? ''
    const text = label ? footnoteDefinitions(getMarkdown()).get(label) ?? '' : ''
    if (!text.trim()) {
      hide()
      return
    }
    card.textContent = text
    card.hidden = false
    const refRect = ref.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    const left = Math.max(8, Math.min(refRect.left, window.innerWidth - cardRect.width - 8))
    let top = refRect.bottom + 6
    if (top + cardRect.height > window.innerHeight - 8) {
      top = Math.max(8, refRect.top - cardRect.height - 6)
    }
    card.style.left = `${left}px`
    card.style.top = `${top}px`
  }

  root.addEventListener('mouseover', (e) => {
    const target = e.target as HTMLElement
    // 悬停在卡片上要让它留着，定义长了才能滚
    if (card.contains(target)) {
      cancelHide()
      return
    }
    const ref = target.closest<HTMLElement>('.cm-md-footnote-ref')
    if (!ref) return
    cancelHide()
    if (ref === currentRef) return
    if (showTimer) clearTimeout(showTimer)
    currentRef = ref
    showTimer = setTimeout(() => {
      if (currentRef === ref) show(ref)
    }, FOOTNOTE_PREVIEW_DELAY)
  })
  root.addEventListener('mouseout', (e) => {
    if (!inZone(e.target)) return
    if (inZone(e.relatedTarget)) {
      cancelHide()
      return
    }
    scheduleHide()
  })
  // 固定定位在文档一动就失效：编辑器自己滚动时收起卡片
  root.addEventListener('scroll', (e) => {
    if (e.target === root || (e.target as HTMLElement).classList?.contains('cm-scroller')) hide()
  }, { passive: true })
  window.addEventListener('resize', hide)
}

// 任务列表源码里的一段：`- [ ] 文案` 或 `- [x] 文案`。
const TASK_RE = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\])/

/** 从点击位置找回任务项那一行；不是任务项就返回 null。 */
function sourceFromTaskClick(view: EditorView, e: MouseEvent): number | null {
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
  if (pos === null) return null
  const line = view.state.doc.lineAt(pos)
  if (!TASK_RE.test(line.text)) return null
  // 只有复选框那块区域才切换，点文案仍旧放光标
  const rect = (e.target as HTMLElement).getBoundingClientRect()
  if (e.clientX - rect.left > 24) return null
  return line.from
}

/** 切换某个位置上的任务列表项。 */
function toggleTaskAt(view: EditorView, pos: number): void {
  const line = view.state.doc.lineAt(pos)
  const match = TASK_RE.exec(line.text)
  if (!match) return
  const markerOffset = line.from + match[1].length
  const next = match[2] === ' ' ? 'x' : ' '
  view.dispatch({ changes: { from: markerOffset, to: markerOffset + 1, insert: next } })
}

// --- 内容读写。保存不再过序列化器，这一条就是整个重构的价值所在 ---

export function getMarkdown(): string {
  return handle?.getText() ?? ''
}

export function setMarkdown(content: string, flushHistory = false): void {
  if (!handle) return
  // flush=true 换掉整个编辑状态，撤销栈一并清空。
  // 文档身份变化时（切文件、新建、外部重载）用它，撤销就永远够不到别的文档的内容。
  handle.setText(content, flushHistory)
}

export function getEditorView(): EditorView | null {
  return handle?.getView() ?? null
}

/**
 * 编辑器的滚动容器。
 *
 * 外壳里到处需要「读/写正文的滚动位置」，而 CodeMirror 把滚动放在 `.cm-scroller` 上，
 * `#editor` 自己不动（`.cm-editor` 高度 100%，内容在 scroller 里溢出）。
 * 以前那些直接读写 `#editor.scrollTop` 的代码全都变成了空操作：切标签不恢复位置、
 * 新建文档不回顶部、大纲的阅读进度判断也拿不到滚动量。
 */
export function getEditorScroller(): HTMLElement | null {
  return handle?.getView().scrollDOM ?? null
}

// 把光标放进文档，不动内容。新开的标签是空的，得能直接敲字：
// 加号（或 ⌘T）就是「我要写字」的意思，还要先点一下页面是每个新文档都白挨一次的摩擦。
export function focusEditor(): void {
  handle?.focus()
}

// 放映幻灯片时把编辑器冻住。按键在到达编辑器之前就已经被拦住了
// （renderer/slideshow.ts）；这是第二道锁，万一有键漏过来，也落不到没人看得见的页面上。
export function setEditorEditable(editable: boolean): void {
  handle?.setEditable(editable)
}

// 多个标签共用一个编辑器实例。编辑器状态带着文档、选区和撤销栈，
// 所以按标签把它存下来，才是每个标签各有各的撤销历史，而不是共用一个栈。
export function getEditorState(): EditorState | null {
  return handle?.getView()?.state ?? null
}

// 恢复一份存下来的状态。切回某个标签时用它，这条路不能绕 markdown，
// 否则撤销栈和选区就丢了。
export function restoreEditorState(state: EditorState): void {
  const view = handle?.getView()
  if (!view) return
  view.setState(state)
  // setState 会换掉 view 的 DOM，焦点随之丢掉：把光标找回来，让切过去的标签能直接敲字。
  view.focus()
}

// 这个函数保留下来只为了外壳那一处调用点不用改。
//
// 它原来的职责是「探测当前文档用的是哪种标点风格，再把它套给序列化器」，也就是
// 让保存时别把用户写的 `*` 列表改成 `-` 列表。文本优先之后这件事不需要做了：
// 原文就在缓冲区里，没改过的字节根本不参与写回，也就没有风格要探测、要套用。
//
// 参数收得松：调用方传什么都没关系，反正不看。等外壳那处调用点清理干净，这个函数可以删。
export function applyMarkdownStyle(_style: Record<string, unknown> = {}): void {
  // 有意为空，理由见上。
}

/**
 * 导出开关：打开后，装饰层不再把「正在编辑」那一行的源码显形。
 *
 * 导出的是一篇文档，不是编辑器此刻的样子。用户光标停在哪一行、哪一行显着 `#` 和 `**`，
 * 都不是文档的内容（2026-09-26 报的：导出的 PDF 里带着当前行的源码）。
 * 光标与选区由 body 上的 `exporting` 类交给 CSS 藏起来。
 */
/**
 * 告诉编辑器当前文档的 `file://` URL：图片的相对路径靠它解析。
 * 无标题文档传 null，图片就按文件里写的那样原样放着。
 */
export function setDocumentFileUrl(url: string | null): void {
  primeDocumentFileUrl(url)
  const view = handle?.getView()
  if (!view) return
  view.dispatch({ effects: setDocumentFileUrlEffect.of(url) })
}

export function setCleanExport(on: boolean): void {
  const view = handle?.getView()
  if (!view) return
  view.dispatch({ effects: setCleanExportEffect.of(on) })
}

/** 跳转到某一行并高亮它（大纲点击用）。行号从 0 算。 */
export function jumpToLine(line: number): void {
  const view = handle?.getView()
  if (!view) return
  if (line < 0 || line >= view.state.doc.lines) return
  const target = view.state.doc.line(line + 1)
  view.dispatch({
    selection: { anchor: target.from },
    effects: EditorView.scrollIntoView(target.from, { y: 'start', yMargin: 24 }),
    scrollIntoView: false,
  })
  view.focus()
  // 落点闪烁：整行加一条短暂的装饰
  flashLine(view, target.from, target.to)
}

/** 当前文本（视觉模式下即缓冲区内容）。 */
export function getText(): string {
  return handle?.getText() ?? ''
}

/** 供测试与调试查看装饰层的落点高亮状态。 */
export { EditorSelection }
