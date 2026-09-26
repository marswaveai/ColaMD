// 导出布局：让编辑器把**整篇**渲染出来，并把窗口暂时摆成一张连续的纸。
//
// 为什么必须做这件事：CodeMirror 只为视口内的行建 DOM。一篇长文档在屏幕上真正存在的
// 只有十几行元素，其余靠占位元素撑高；滚动到哪，渲染到哪。而导出拿到的是这个 DOM：
//
//   · 打印时 Chromium 重排页面**不执行脚本**，CodeMirror 没有机会补渲染；
//   · 图片导出与 HTML 导出取的是 `.cm-content` 的 innerHTML，同样只有当前视口那一屏。
//
// 结果是长文档导出只有开头一段（2026-09-26 报的「长文档只渲染了前面」，实测 166 行的
// 文档在打印媒体下 DOM 里只有 17 行）。所以导出前先把整篇渲染出来，再打印或取快照。
//
// 怎么让它渲染整篇：CodeMirror 自己有一个「正在打印」的开关，打开时视口就是整篇
// （`ViewState.printing` → `fullPixelRange`，见 @codemirror/view 的 measure）。
// 它没有公开 API：CM6 只在收到打印媒体查询变化时自己打开，而 printToPDF 的媒体切换是
// 异步的，等不到。所以这里直接开，导出结束再还原；拿不到内部字段时安全失败，
// 导出退回原来的行为（宁可少渲染，不要崩）。

import { getEditorScroller, getEditorView } from './editor/editor'

const STYLE_ID = 'colamd-paper-layout'
/** 纸上的标记类。与 `exporting` 分开：那个管「藏起光标与属性区」，这个管「摊平」。 */
const PAPER_CLASS = 'paper'
/** 等 CodeMirror 补渲染的上限。实测 4800 行不到一秒，这里留足余量。 */
const RENDER_TIMEOUT_MS = 5000

let styleEl: HTMLStyleElement | null = null
let savedScrollTop = 0

// 选择器带上 `body.paper`：CodeMirror 的 baseTheme 是运行时注入到 <head> 末尾的，
// 同为单类时它永远排在后面；加高优先级才盖得住。
const PAPER_RULES = `
body.${PAPER_CLASS} #editor { height: auto !important; overflow: visible !important; }
body.${PAPER_CLASS} #editor .cm-editor { height: auto !important; }
body.${PAPER_CLASS} #editor .cm-scroller { display: block !important; height: auto !important; overflow: visible !important; }
`

/** CodeMirror 内部那个「视口不受限」的开关。 */
type PrintableViewState = { printing?: boolean }

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

/**
 * 视口里渲染出来的范围是否已经盖住整篇。
 *
 * 不用「数 `.cm-line` 元素」判：表格、mermaid、属性区这些块是把好几行换成**一个**元素的，
 * 元素个数天然少于行数（实测 166 行的文档只有 164 个 `.cm-line`），拿它当判据会永远等不到。
 * `visibleRanges` 是 CodeMirror 自己的「已渲染区间」，它盖到文末才算真的渲染完了。
 */
function fullyRendered(): boolean {
  const view = getEditorView()
  if (!view) return true
  const ranges = view.visibleRanges
  if (ranges.length === 0) return false
  return ranges[0].from === 0 && ranges[ranges.length - 1].to >= view.state.doc.length
}

/** 打开/关闭「渲染整篇」。返回 false 表示拿不到内部开关。 */
function setFullRender(on: boolean): boolean {
  const view = getEditorView()
  if (!view) return false
  const viewState = (view as unknown as { viewState?: PrintableViewState }).viewState
  if (!viewState || typeof viewState.printing !== 'boolean') return false
  viewState.printing = on
  view.requestMeasure()
  return true
}

/**
 * 让编辑器把整篇渲染出来，并等它渲染完。
 *
 * 数分页、量页高、取快照、打印之前都要走这一步，否则量到的是「当前视口」而不是整篇。
 * 返回 false 表示当前没有编辑器（比如源模式），调用方照旧继续。
 */
export async function renderWholeDocument(): Promise<boolean> {
  const ok = setFullRender(true)
  await nextFrame()
  const deadline = Date.now() + RENDER_TIMEOUT_MS
  while (!fullyRendered() && Date.now() < deadline) await nextFrame()
  return ok
}

/** 还原成「只渲染视口」。 */
export function restoreViewport(): void {
  setFullRender(false)
}

/**
 * 摊平成纸并渲染整篇。主进程在打印前 await 它。
 *
 * 摊平是为了分页：CM6 的编辑器与滚动容器是 flex 加固定高度，强制分页在它们里面不生效。
 * 渲染整篇是为了内容：不这么做，纸上只有当前视口那一屏。
 */
export async function enterPaperLayout(): Promise<boolean> {
  if (styleEl) return true
  if (!getEditorView()) return false
  savedScrollTop = getEditorScroller()?.scrollTop ?? 0
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = PAPER_RULES
  document.head.appendChild(style)
  document.body.classList.add(PAPER_CLASS)
  styleEl = style
  await renderWholeDocument()
  return true
}

/** 收起纸，回到屏幕布局与原来的滚动位置。 */
export function exitPaperLayout(): void {
  restoreViewport()
  if (!styleEl) return
  styleEl.remove()
  styleEl = null
  document.body.classList.remove(PAPER_CLASS)
  const scroller = getEditorScroller()
  if (scroller) scroller.scrollTop = savedScrollTop
}
