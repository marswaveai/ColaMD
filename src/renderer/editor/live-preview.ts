// Live preview 装饰层：把 markdown 源码画成所见即所得的样子。
//
// 硬规矩（见 docs/editor-architecture.md）：**装饰不许修改文档。**
// 这里只做两件事：
//   1. 给语法加样式（Decoration.mark / Decoration.line）——标记字符照旧在，只是被画得轻一些。
//   2. 把光标不在其内的标记字符藏起来（Decoration.replace）——只是「看不见」，
//      文本还在，保存时一个字节都不变。
//
// 「藏起来」的判据是光标位置：光标进入某个区间时，标记字符显形，用户可以就地编辑。
// Obsidian 的 Live Preview 就是这个行为。
//
// 一个反复出现的形状：**渲染失败宁可退回源码，绝不吞掉用户的字。**
// 公式渲不出来就显示 `$...$`，mermaid 画不出来就显示代码块。文件永远是安全的，
// 装饰层再错也只是难看。
//
// 装饰装在 StateField 里、用 `provide` 暴露，**不能用 `EditorView.decorations.compute()`**。
// 原因不是风格问题：CodeMirror 把「函数式提供的装饰」标记为动态，而动态装饰
// **不许跨行替换**，命中就抛 `RangeError: Decorations that replace line breaks may not
// be specified via plugins`（node_modules/@codemirror/view/dist/index.cjs:2780）。
// 块公式、属性区、mermaid、表格都是跨行替换，用 compute 提供会让整层装饰更新中途抛错，
// 表现为「整个界面错乱」。StateField + provide 提供的是装饰集本身，不是函数，
// 跨行替换与块级 widget 才被允许。

import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state'
import { forceParsing, syntaxTree } from '@codemirror/language'
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common'
import katex from 'katex'
import { scanMath, excludedRanges, frontmatterRange, type Excluded } from './math-scan'
import { renderMermaid } from './mermaid-bridge'
import { sanitizeHTML } from './html-sanitize'
import { footnoteDefinitions, footnoteNumbers, FOOTNOTE_REF_RE } from './footnotes'
import { isChinese } from '../ui-language'

/** 给区间加样式类，不隐藏任何字符。 */
const MARK = Decoration.mark.bind(Decoration)
/**
 * 块级元素用行装饰。
 *
 * 为什么不能用 `MARK`：`Decoration.mark` 只包住它范围内的文字，一个跨多行的区间
 * 会被拆成好几段文字盒子，而 CM6 里真正撑满正文宽度的是 `.cm-line`。
 * 用 mark 包表格，表格宽度就由文字长度决定（实测被压到 90px，应为 880px）。
 */
const BLOCK = (className: string) => Decoration.line({ class: className })
/** 把一个跳行区间展开成逐行的行装饰。 */
function pushBlockLines(
  state: EditorState,
  from: number,
  to: number,
  className: string,
  ranges: DecorationRange[],
): void {
  const first = state.doc.lineAt(from).number
  const last = state.doc.lineAt(to).number
  for (let n = first; n <= last; n++) {
    const lineFrom = state.doc.line(n).from
    ranges.push({ from: lineFrom, to: lineFrom, deco: BLOCK(className) })
  }
}
/**
 * 列表项：只给它**自己那一行**加类，不给它子列表里的行加。
 *
 * 一个 ListItem 的区间包含它下面的子列表，按区间铺类的话，嵌套项那一行会同时拿到
 * 外层和内层的类（实测一行上同时挂着 `cm-md-li-0` 和 `cm-md-li-1`），缩进只是靠 CSS
 * 里规则的前后顺序才侥幸对。所以每一行都要问一次语法树：包住这一行的**最内层**
 * ListItem 是不是我自己。
 */
function pushListItemLines(state: EditorState, node: SyntaxNode, ranges: DecorationRange[]): void {
  const className = `cm-md-li cm-md-li-${Math.min(listDepth(node), 6)}`
  const tree = syntaxTree(state)

  // 子列表之前的行一定是这一项自己的（包括项里的空行），不用问语法树。
  let ownEnd = node.to
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'BulletList' || child.name === 'OrderedList') {
      ownEnd = child.from
      break
    }
  }

  const first = state.doc.lineAt(node.from).number
  const last = state.doc.lineAt(node.to).number
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n)
    if (line.to > ownEnd) {
      // 子列表里的行：问语法树，包住这一行的**最内层** ListItem 得是我自己。
      // 位置取行内第一个非空白字符——嵌套项的行首是缩进，从行首问会问到外层那一项。
      const indent = /^[ \t]*/.exec(line.text)?.[0].length ?? 0
      const at = Math.min(line.from + indent, line.to)
      let owner: SyntaxNode | null = tree.resolveInner(at, 1)
      while (owner && owner.name !== 'ListItem') owner = owner.parent
      if (!owner || owner.from !== node.from) continue
    }
    ranges.push({ from: line.from, to: line.from, deco: BLOCK(className) })
  }
}

/** 把区间藏起来（只是看不见，文本还在）。 */
const hide = (from: number, to: number) => Decoration.replace({})

/**
 * 藏掉一个标记字符，**连同它后面那个空格**。
 *
 * markdown 的标记（`#`、`>`）与正文之间那个空格不属于标记节点，只藏标记的话，
 * 标题与引用的文字会比正文右移一个字：`# 标题` 藏掉 `#` 剩下 ` 标题`。
 * 这个偏移很小，但正是「前置对齐不对」的全部来源。
 */
function hideMarker(state: EditorState, from: number, to: number, ranges: DecorationRange[], visible = false): void {
  const next = to < state.doc.length ? state.doc.sliceString(to, to + 1) : ''
  // 空格不可能是换行，所以 to + 1 不会越到下一行
  const end = next === ' ' || next === '\t' ? to + 1 : to
  // 光标在这一行时标记要露出来（这是「当前行看源码」的手感），但它不属于正文。
  // 给它一个类名，复制和导出才认得出它并丢掉：2026-09-26 发现，在一行里选一段带加粗的
  // 文字，纯文本里带着 `**`，因为标记只在光标离开这一行时才从 DOM 里消失。
  ranges.push({ from, to: end, deco: visible ? MARK({ class: 'cm-md-marker' }) : hide(from, end) })
}

interface DecorationRange {
  from: number
  to: number
  deco: Decoration
}

/** 一个区间（属性区）。 */
interface Range {
  from: number
  to: number
}

/** 位置是否落在某个区间内。区间为 null 时永远不命中。 */
function inRange(range: Range | null, pos: number): boolean {
  return !!range && pos >= range.from && pos < range.to
}

/**
 * 遍历语法树，跳过属性区。
 *
 * 属性区里是 YAML，不是 markdown：`- `、`---`、`**`、`#` 在那里都只是普通字符。
 * 解析器不认 YAML，会把它们解析成列表项、分隔线、加粗，所以在这里统一挡掉，
 * 而不是让每个收集器各写一遍判断。
 *
 * `Document` 不能跳过：它的起点就是属性区的起点，跳过它整棵树都不用看了。
 */
function iterateContent(
  state: EditorState,
  front: Range | null,
  enter: (node: SyntaxNodeRef) => boolean | void,
): void {
  syntaxTree(state).iterate({
    enter: (node) => {
      if (front && node.name !== 'Document' && inRange(front, node.from)) return false
      return enter(node)
    },
  })
}

/**
 * 编辑器当前是否有焦点。
 *
 * 「光标所在行显示源码」是给**正在编辑**的那一行用的。但打开文件时 CodeMirror 的默认光标
 * 就在第 0 位，于是第一行会一直显示 `# **标题**` 这样的源码：用户没点过它，看起来就是个
 * bug（2026-09-26 报的）。所以判据里加上焦点：没有焦点，就没有「正在编辑」的那一行。
 */
export const setEditorFocus = StateEffect.define<boolean>()

export const editorFocusField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setEditorFocus)) return effect.value
    }
    return value
  },
})

function editorFocused(state: EditorState): boolean {
  return state.field(editorFocusField, false) ?? false
}

/**
 * 导出时的「干净」开关。
 *
 * 导出的是一篇文档，不是编辑器此刻的样子：正在编辑的那一行显形的源码、
 * 光标、选区都不该跟着进 PDF。导出前把它打开，导出后关掉。
 */
/**
 * 文档自己的 `file://` URL。
 *
 * 文件里写的是 `![](img/a.png)` 这样的**相对**路径——那是用户文件里真实存在的一串字，
 * 不许改（改了就等于保存时动用户的文件）。但浏览器要的是一个能加载的绝对地址，
 * 所以解析放在画图这一刻做，用文档自己的 URL 当基准。
 *
 * 值同时留在模块变量里：换文件会重建整个 EditorState，field 会被 create 重置，
 * 只有模块变量能跨过去。
 */
let documentFileUrl: string | null = null

/** 编辑器还没建起来时也要能先记下基准，否则第一张图会按空基准解析。 */
export function primeDocumentFileUrl(url: string | null): void {
  documentFileUrl = url
}

export const setDocumentFileUrlEffect = StateEffect.define<string | null>()

export const documentFileUrlField = StateField.define<string | null>({
  create: () => documentFileUrl,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDocumentFileUrlEffect)) {
        documentFileUrl = effect.value
        return effect.value
      }
    }
    return value
  },
})

/** 把文件里的图片地址解析成浏览器能加载的地址。 */
function resolveImageSrc(raw: string, base: string | null): string {
  const value = raw.trim().replace(/^<|>$/g, '')
  if (/^(?:https?:|file:|data:|blob:)/i.test(value)) return value
  if (!base) return value
  try {
    return new URL(value.replaceAll('\\', '/'), base).href
  } catch {
    return value
  }
}

/** `![alt](src)` / `![alt](<src> "title")`。解析不了就返回 null，退回源码。 */
function parseImage(source: string): { alt: string; src: string } | null {
  const match = /^!\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)$/.exec(source.trim())
  if (!match) return null
  return { alt: match[1], src: match[2] }
}

/**
 * 图片。
 *
 * 加载不出来就把源码原样放回去——和公式、mermaid 一样的规矩：宁可难看，不吞用户的字。
 * 点击图片不需要额外处理：光标落进这一行，这一行就退回源码，路径可以直接改。
 */
class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly source: string,
  ) {
    super()
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-md-image'
    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    img.addEventListener('error', () => {
      wrap.classList.add('cm-md-image-failed')
      wrap.textContent = this.source
    })
    wrap.appendChild(img)
    return wrap
  }
}

export const setCleanExport = StateEffect.define<boolean>()

export const cleanExportField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setCleanExport)) return effect.value
    }
    return value
  },
})

function exportingCleanly(state: EditorState): boolean {
  return state.field(cleanExportField, false) ?? false
}

/**
 * 判断某个位置是否落在光标/选区所在的行上。
 * 判断粒度是「行」而不是「精确区间」：光标所在的这一行，标记全部显形，
 * 这样用户点一下就能看到并修改原始语法，不需要精确点到标记上。
 */
/**
 * 光标所在的那一行算「激活」，这一行会露出源码。
 *
 * 只看**空选区**：一旦拉出选区就保持渲染。Typora 与 Obsidian 都是这个规矩
 * （2026-09-26 定的）。按选区露源码的话，全选会让整屏变成 markdown。
 */
function isActiveLine(state: EditorState, pos: number): boolean {
  if (exportingCleanly(state)) return false
  if (!editorFocused(state)) return false
  const line = state.doc.lineAt(pos).number
  for (const range of state.selection.ranges) {
    if (!range.empty) continue
    if (state.doc.lineAt(range.head).number === line) return true
  }
  return false
}

/** 跨行的块（表格、公式、属性区）同理：只有光标落在块里才露出源码。 */
function isActiveRange(state: EditorState, from: number, to: number): boolean {
  if (exportingCleanly(state)) return false
  if (!editorFocused(state)) return false
  const first = state.doc.lineAt(from).number
  const last = state.doc.lineAt(to).number
  for (const range of state.selection.ranges) {
    if (!range.empty) continue
    const at = state.doc.lineAt(range.head).number
    if (at >= first && at <= last) return true
  }
  return false
}

// ─── 公式 ────────────────────────────────────────────────────────────────────

/**
 * 公式渲染。判定交给 math-scan.ts（照 Obsidian 的保守规则），这里只负责画。
 *
 * 行内公式用 Widget 覆盖原文，而不是把 `$x$` 藏起来再插一段渲染结果：
 * 两者视觉相同，覆盖的写法不必分别处理两个定界符的位置。
 *
 * 光标所在行照旧退回原文，用户可以就地改。渲染失败时显示 `$...$` 源码。
 *
 * widget 上带着源码区间（`data-math-from` / `data-math-to`）：点它要能就地编辑，
 * 而 DOM 里除了这里没有别的地方知道这段公式在缓冲区里的位置。
 */
class MathWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly block: boolean,
    readonly from: number,
    readonly to: number,
  ) {
    super()
  }

  eq(other: MathWidget): boolean {
    return other.code === this.code && other.block === this.block
  }

  toDOM(): HTMLElement {
    const span = document.createElement(this.block ? 'div' : 'span')
    span.className = this.block ? 'cm-md-math cm-md-math-block' : 'cm-md-math cm-md-math-inline'
    span.setAttribute('data-math-from', String(this.from))
    span.setAttribute('data-math-to', String(this.to))
    try {
      span.innerHTML = katex.renderToString(this.code, {
        displayMode: this.block,
        throwOnError: true,
        // 公式里可能带用户写的 HTML，KaTeX 的 trust 默认关闭，保持关闭
        trust: false,
      })
    } catch {
      // 渲染不了就把源码原样放回去，宁可难看也不丢字
      span.textContent = (this.block ? '$$' : '$') + this.code + (this.block ? '$$' : '$')
      span.classList.add('cm-md-math-error')
    }
    return span
  }
}

/**
 * 无序列表的圆点。
 *
 * CM6 里没有 `ul`/`li` 元素，`-` 只是一段普通文字，圆点得自己画。
 * 有序列表不动：`1.` 本身就是用户写的序号，换掉反而看不出层级。
 */
class ListBulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-md-li-bullet'
    span.textContent = '•'
    return span
  }
}

/** 数一个列表项的嵌套深度（往上数几层 ListItem）。 */
function listDepth(node: SyntaxNode): number {
  let depth = 0
  let cur: SyntaxNode | null = node.parent
  while (cur) {
    if (cur.name === 'ListItem') depth++
    cur = cur.parent
  }
  return depth
}

/** 扫描公式并压入装饰。 */
function collectMath(state: EditorState, ranges: DecorationRange[]): void {
  const text = state.doc.toString()

  // 排除区：属性区、代码块、行内代码、行内 HTML。
  // 这些地方里的 `$x$` 不该渲染成公式——代码就是代码，Obsidian 也是这么处理的。
  const excluded: Excluded[] = excludedRanges(text, syntaxTree(state))

  for (const range of scanMath(text, excluded)) {
    // 光标所在行不画，退回源码，方便编辑；但定界符不属于正文，标出来让复制丢掉它
    if (isActiveLine(state, range.from)) {
      const delim = range.block ? 2 : 1
      ranges.push({ from: range.from, to: range.from + delim, deco: MARK({ class: 'cm-md-marker' }) })
      ranges.push({ from: range.to - delim, to: range.to, deco: MARK({ class: 'cm-md-marker' }) })
      continue
    }
    ranges.push({
      from: range.from,
      to: range.to,
      deco: Decoration.replace({ widget: new MathWidget(range.code, range.block, range.from, range.to) }),
    })
  }
}

// ─── 高亮 `==文字==` ─────────────────────────────────────────────────────────
//
// 这是本站自己的语法（milkdown 时代由 highlight.ts 定义）。文本优先之后它只需要
// 一条装饰：把 `==` 藏起来、给中间加个底色。没有节点要建，也没有规则要注册。

/** `==高亮==` 的匹配。不吃跨行，也不吃空的 `====`。 */
const HIGHLIGHT_RE = /(?<![=])==(?!=)([^=\n]+?)==(?!=)/g

function collectHighlight(state: EditorState, ranges: DecorationRange[], excluded: Excluded[]): void {
  const text = state.doc.toString()
  const inExcluded = (pos: number) => excluded.some((e) => pos >= e.from && pos < e.to)

  HIGHLIGHT_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = HIGHLIGHT_RE.exec(text)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (inExcluded(start)) continue
    const active = isActiveLine(state, start)
    // 藏定界符，给中间那段加底色；光标在这一行时定界符露出来，但仍要能认出来
    const delimiter = (from: number, to: number) =>
      active ? MARK({ class: 'cm-md-marker' }) : hide(from, to)
    ranges.push({ from: start, to: start + 2, deco: delimiter(start, start + 2) })
    ranges.push({ from: end - 2, to: end, deco: delimiter(end - 2, end) })
    ranges.push({ from: start + 2, to: end - 2, deco: MARK({ class: 'cm-md-highlight' }) })
  }
}

// ─── 任务列表的复选框 ────────────────────────────────────────────────────────

/**
 * `- [ ]` / `- [x]` 的方括号画成真的复选框。
 *
 * 这里只是「画」：点击行为在 editor.ts 里，它改写源码里的那一个字符。
 * 也就是说勾选是**一次真的文本编辑**，可撤销、可保存，不是藏在某棵树里的状态。
 */
class TaskCheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }

  eq(other: TaskCheckboxWidget): boolean {
    return other.checked === this.checked
  }

  toDOM(): HTMLElement {
    const box = document.createElement('span')
    box.className = this.checked ? 'cm-md-task cm-md-task-checked' : 'cm-md-task'
    box.textContent = this.checked ? '☑' : '☐'
    return box
  }
}

function collectTaskItems(state: EditorState, ranges: DecorationRange[], front: Range | null): void {
  iterateContent(state, front, (node) => {
      if (node.name !== 'TaskMarker') return
      if (isActiveLine(state, node.from)) return
      const raw = state.doc.sliceString(node.from, node.to)
      const checked = /x/i.test(raw)
      ranges.push({
        from: node.from,
        to: node.to,
        deco: Decoration.replace({ widget: new TaskCheckboxWidget(checked) }),
      })
  })
}

// ─── Mermaid 图 ──────────────────────────────────────────────────────────────

/**
 * ```mermaid 代码块画成图。
 *
 * 渲染是异步的（mermaid 要在隐藏沙箱里跑），所以先放一个占位，画好了再原地替换。
 * 失败就把代码块原样留着——图是锦上添花，代码是用户写的东西。
 */
class MermaidWidget extends WidgetType {
  constructor(readonly code: string, readonly key: string) {
    super()
  }

  eq(other: MermaidWidget): boolean {
    return other.key === this.key
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-md-mermaid'
    wrap.textContent = isChinese() ? '图表渲染中…' : 'Rendering diagram…'

    // **不指定**配色：交给 mermaid-bridge 按代码块底色的明暗挑（和它自己的注释一致）。
    // 这里曾经按应用主题挑（`theme-dark` 才用深色），可 elegant 和 bear 是浅色主题
    // 配深色代码块，于是深底上画出了浅色主题的图：连线 #333 落在 #2c2c2c 上，
    // 边缘文字也几乎看不见（2026-09-26 用户报的「线条和背景色太接近」）。
    void renderMermaid(this.code)
      .then((svg) => {
        wrap.innerHTML = svg
        wrap.classList.add('cm-md-mermaid-ready')
      })
      .catch(() => {
        // 画不出来就退回代码块，绝不吞掉用户的图
        wrap.textContent = '```mermaid\n' + this.code + '\n```'
        wrap.classList.add('cm-md-mermaid-failed')
      })
    return wrap
  }
}

function collectMermaid(state: EditorState, ranges: DecorationRange[], front: Range | null): void {
  const text = state.doc.toString()
  iterateContent(state, front, (node) => {
      if (node.name !== 'FencedCode') return
      // 第一行是 ```mermaid 才画
      const firstLineEnd = text.indexOf('\n', node.from)
      if (firstLineEnd === -1) return
      const opening = text.slice(node.from, firstLineEnd).trim()
      if (!/^(`{3,}|~{3,})\s*mermaid\s*$/.test(opening)) return
      if (isActiveRange(state, node.from, node.to)) return
      // 去掉开头的 ```mermaid 行与结尾的 ```
      const bodyStart = firstLineEnd + 1
      const lastLineStart = text.lastIndexOf('\n', node.to - 1)
      const code = text.slice(bodyStart, lastLineStart === -1 ? node.to : lastLineStart)
      if (!code.trim()) return
      ranges.push({
        from: node.from,
        to: node.to,
        deco: Decoration.replace({ widget: new MermaidWidget(code, `${node.from}:${code.length}`) }),
      })
  })
}

// ─── 属性区（YAML frontmatter）─────────────────────────────────────────────────
//
// 属性区是笔记开头的 metadata。它**必须留在缓冲区里**（见 #109：拆出去单独保管、
// 保存时再拼回来的做法曾经把用户的 YAML 改写成非法内容），但它不该在写作时占地方。
//
// 展示上只做一件事：**压淡**。不折叠、不画成卡片、不换成一个「属性区」按钮。
// 用一个胶囊按钮把几行 YAML 收起来看着像设计，实际是拿一个凭空造出来的控件
// 替掉用户文件里真实存在的内容（2026-09-26 报的）。文件里有什么就显示什么，
// 只是画得轻一点；里面的 `- `、`---`、`**` 都是 YAML 字符，不参与 markdown 排版。
function collectFrontmatter(state: EditorState, ranges: DecorationRange[], front: Range | null): void {
  if (!front) return
  pushBlockLines(state, front.from, front.to, 'cm-md-frontmatter', ranges)
}

// ─── 表格 ────────────────────────────────────────────────────────────────────

/**
 * 表格画成真的 `<table>`。
 *
 * 为什么这里不像别的块一样「只加样式」：markdown 表格的单元格在源码里只是被 `|`
 * 隔开的文字，行是一个个独立的 div，**没有任何办法给单元格画边框、做对齐**。
 * 只加底色的结果是几条彩色横条，不是表格。Obsidian 与 Typora 都是把表格渲染成真表格，
 * 光标进去才回到源码，这里照做。
 *
 * 光标落在表格的任意一行里时退回源码，所以改表格仍然是改文字。
 */
class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super()
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source
  }

  toDOM(): HTMLElement {
    const rows = parseTable(this.source)
    const table = document.createElement('table')
    table.className = 'cm-md-table-widget'
    if (rows.length === 0) {
      table.textContent = this.source
      return table
    }
    const [head, , ...body] = rows
    const thead = document.createElement('thead')
    const headRow = document.createElement('tr')
    head.forEach((cell, index) => {
      const th = document.createElement('th')
      th.style.textAlign = alignOf(rows[1]?.[index] ?? '')
      appendInline(th, cell)
      headRow.appendChild(th)
    })
    thead.appendChild(headRow)
    table.appendChild(thead)
    const tbody = document.createElement('tbody')
    for (const row of body) {
      const tr = document.createElement('tr')
      for (let i = 0; i < head.length; i++) {
        const td = document.createElement('td')
        td.style.textAlign = alignOf(rows[1]?.[i] ?? '')
        appendInline(td, row[i] ?? '')
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    return table
  }
}

/** 按行拆表格源码，行内按未转义的 `|` 拆单元格。 */
function parseTable(source: string): string[][] {
  return source
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
      const cells: string[] = []
      let current = ''
      for (let i = 0; i < trimmed.length; i++) {
        const char = trimmed[i]
        if (char === '\\' && trimmed[i + 1] === '|') {
          current += '|'
          i++
          continue
        }
        if (char === '|') {
          cells.push(current.trim())
          current = ''
          continue
        }
        current += char
      }
      cells.push(current.trim())
      return cells
    })
}

/** 分隔行里的对齐标记：`:---` 左、`:---:` 居中、`---:` 右。 */
function alignOf(delimiter: string): string {
  const cell = delimiter.trim()
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  return 'left'
}

/**
 * 单元格里的行内格式。
 *
 * 用 DOM 拼，不拼 innerHTML：单元格内容来自用户的文件，拼字符串等于把文件里的
 * `<img onerror=...>` 直接执行掉。这里只认粗体、斜体、行内代码、删除线、链接，
 * 认不出来的就当普通文字。
 */
const INLINE_RE = /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3|`([^`]+)`|~~(.+?)~~|\[([^\]]*)\]\(([^)]*)\)/g

function appendInline(parent: HTMLElement, text: string): void {
  INLINE_RE.lastIndex = 0
  let last = 0
  let match: RegExpExecArray | null
  while ((match = INLINE_RE.exec(text)) !== null) {
    if (match.index > last) parent.appendChild(document.createTextNode(text.slice(last, match.index)))
    if (match[2] !== undefined) {
      const el = document.createElement('strong')
      el.textContent = match[2]
      parent.appendChild(el)
    } else if (match[4] !== undefined) {
      const el = document.createElement('em')
      el.textContent = match[4]
      parent.appendChild(el)
    } else if (match[5] !== undefined) {
      const el = document.createElement('code')
      el.textContent = match[5]
      parent.appendChild(el)
    } else if (match[6] !== undefined) {
      const el = document.createElement('s')
      el.textContent = match[6]
      parent.appendChild(el)
    } else if (match[7] !== undefined) {
      const el = document.createElement('a')
      el.textContent = match[7] || match[8] || ''
      const href = (match[8] ?? '').trim()
      if (/^https?:\/\//i.test(href)) el.setAttribute('href', href)
      parent.appendChild(el)
    }
    last = match.index + match[0].length
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)))
}

function collectTables(state: EditorState, ranges: DecorationRange[], front: Range | null): void {
  iterateContent(state, front, (node) => {
      if (node.name !== 'Table') return
      // 光标在表格里就退回源码：改表格就是改文字
      if (isActiveRange(state, node.from, node.to)) {
        pushBlockLines(state, node.from, node.to, 'cm-md-table', ranges)
        return false
      }
      ranges.push({
        from: node.from,
        to: node.to,
        deco: Decoration.replace({ widget: new TableWidget(state.doc.sliceString(node.from, node.to)) }),
      })
      return false
  })
}

// ─── 链接 ────────────────────────────────────────────────────────────────────

/**
 * 链接画成链接。
 *
 * `[文字](地址)` 里，地址在非编辑行藏起来：正文里只该看到链接文字（Obsidian 就是这样）。
 * 要改地址，把光标点进这一行，源码就回来了。
 *
 * 文字上带 `data-href`，而不是把整段换成 `<a>` widget：换成 widget 的话，链接文字里的
 * 加粗、行内代码就全没了。点击行为在 editor.ts 里，它认 `data-href`。
 */
function collectLinks(state: EditorState, ranges: DecorationRange[], front: Range | null): void {
  iterateContent(state, front, (node) => {
    if (node.name !== 'Link') return
    // 引用式链接 `[文字][引用]` 和脚注 `[^note]` 都没有 URL 子节点：
    // 前者保持原样，后者交给脚注那一节画。
    const url = node.node.getChild('URL')
    if (!url) return false
    if (isActiveRange(state, node.from, node.to)) return false
    const head = state.doc.sliceString(node.from, url.from)
    const cut = head.lastIndexOf('](')
    if (cut < 1) return false
    const textTo = node.from + cut
    if (textTo <= node.from + 1) return false
    const href = state.doc.sliceString(url.from, url.to)
    ranges.push({ from: node.from, to: node.from + 1, deco: hide(node.from, node.from + 1) })
    ranges.push({ from: textTo, to: node.to, deco: hide(textTo, node.to) })
    ranges.push({
      from: node.from + 1,
      to: textTo,
      deco: MARK({ class: 'cm-md-link', attributes: { 'data-href': href } }),
    })
    return false
  })
}

// ─── 脚注 ────────────────────────────────────────────────────────────────────
//
// 引用画成上标数字，定义行压淡。悬停预览的卡片在 editor.ts 里（那是交互，不是装饰）。

class FootnoteRefWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly index: number,
  ) {
    super()
  }

  eq(other: FootnoteRefWidget): boolean {
    return other.label === this.label && other.index === this.index
  }

  toDOM(): HTMLElement {
    const sup = document.createElement('sup')
    sup.className = 'cm-md-footnote-ref'
    sup.setAttribute('data-footnote', this.label)
    sup.textContent = String(this.index)
    return sup
  }
}

function collectFootnotes(state: EditorState, ranges: DecorationRange[], front: Range | null): void {
  const text = state.doc.toString()
  const numbers = footnoteNumbers(text)
  const definitions = footnoteDefinitions(text)

  // 引用：整段 `[^note]` 换成上标数字
  FOOTNOTE_REF_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FOOTNOTE_REF_RE.exec(text)) !== null) {
    const from = match.index
    const to = from + match[0].length
    if (front && inRange(front, from)) continue
    if (definitions.has(match[1]) === false && numbers.has(match[1]) === false) continue
    if (isActiveLine(state, from)) continue
    ranges.push({
      from,
      to,
      deco: Decoration.replace({ widget: new FootnoteRefWidget(match[1], numbers.get(match[1]) ?? 1) }),
    })
  }

  // 定义行：压淡，不隐藏（隐藏了用户就看不到自己写了什么）
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n)
    if (!/^ {0,3}\[\^[^\]\s]+\]:/.test(line.text)) continue
    if (front && inRange(front, line.from)) continue
    ranges.push({ from: line.from, to: line.from, deco: BLOCK('cm-md-footnote-def') })
  }
}

// ─── HTML ────────────────────────────────────────────────────────────────────
//
// 文件里的 HTML 照原样画出来，但先过一遍消毒（见 html-sanitize.ts）。
// 画不出来就退回源码：和公式、mermaid 一样的规矩。

class HTMLWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly block: boolean,
  ) {
    super()
  }

  eq(other: HTMLWidget): boolean {
    return other.source === this.source && other.block === this.block
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement(this.block ? 'div' : 'span')
    wrap.className = this.block ? 'cm-md-html cm-md-html-block' : 'cm-md-html cm-md-html-inline'
    wrap.appendChild(sanitizeHTML(this.source))
    return wrap
  }
}

function collectHTML(state: EditorState, ranges: DecorationRange[], front: Range | null): void {
  iterateContent(state, front, (node) => {
    const block = node.name === 'HTMLBlock'
    if (!block && node.name !== 'HTMLTag') return
    if (block ? isActiveRange(state, node.from, node.to) : isActiveLine(state, node.from)) return false
    ranges.push({
      from: node.from,
      to: node.to,
      deco: Decoration.replace({ widget: new HTMLWidget(state.doc.sliceString(node.from, node.to), block) }),
    })
    return false
  })
}

// ─── 代码块的复制按钮 ────────────────────────────────────────────────────────

/**
 * 代码块右上角的「复制」。
 *
 * 做成 widget 而不是事后往 DOM 里插一个按钮：CM6 会按自己的状态重建 DOM，
 * 手工插进去的节点随时会被抹掉（旧核心为此专门把按钮放在编辑器 DOM 之外，
 * 还得跟着滚动重新定位）。widget 由 CM6 自己管，位置、滚动、重建都不用操心。
 */
class CodeCopyWidget extends WidgetType {
  constructor(readonly code: string) {
    super()
  }

  eq(other: CodeCopyWidget): boolean {
    return other.code === this.code
  }

  toDOM(): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'code-copy-btn'
    button.textContent = isChinese() ? '复制' : 'Copy'
    button.setAttribute('data-code', this.code)
    button.contentEditable = 'false'
    return button
  }

  ignoreEvent(): boolean {
    // 让点击落到按钮自己身上，而不是被编辑器当成「放置光标」
    return false
  }
}

/** 围栏里的代码：去掉开头那一行（` ```lang `）与收尾那一行。 */
function codeInsideFence(state: EditorState, node: SyntaxNodeRef): string {
  const startLine = state.doc.lineAt(node.from).number
  const endLine = state.doc.lineAt(Math.max(node.from, node.to - 1)).number
  if (endLine - startLine < 2) return ''
  const lines: string[] = []
  for (let n = startLine + 1; n < endLine; n++) lines.push(state.doc.line(n).text)
  return lines.join('\n')
}

// ─── 图片 ────────────────────────────────────────────────────────────────────

function collectImages(state: EditorState, ranges: DecorationRange[], front: Range | null): void {
  const base = state.field(documentFileUrlField, false) ?? documentFileUrl
  iterateContent(state, front, (node) => {
    if (node.name !== 'Image') return
    // 光标在图片这一行就退回源码：改路径就是改文字
    if (isActiveRange(state, node.from, node.to)) return false
    const source = state.doc.sliceString(node.from, node.to)
    const parsed = parseImage(source)
    if (!parsed) return false
    ranges.push({
      from: node.from,
      to: node.to,
      deco: Decoration.replace({ widget: new ImageWidget(resolveImageSrc(parsed.src, base), parsed.alt, source) }),
    })
    return false
  })
}

// ─── 引用块与分隔线 ──────────────────────────────────────────────────────────

function collectBlocks(state: EditorState, ranges: DecorationRange[], front: Range | null): void {
  iterateContent(state, front, (node) => {
    switch (node.name) {
      case 'Blockquote': {
        pushBlockLines(state, node.from, node.to, 'cm-md-blockquote', ranges)
        break
      }
      case 'HorizontalRule': {
        // 行装饰：`---` 本身要藏起来，横线靠行的上边框画。
        // （属性区里的 `---` 是 YAML 的分隔符，已被 iterateContent 挡在外面）
        const lineFrom = state.doc.lineAt(node.from).from
        ranges.push({ from: lineFrom, to: lineFrom, deco: BLOCK('cm-md-hr') })
        if (!isActiveLine(state, node.from)) {
          ranges.push({ from: node.from, to: node.to, deco: hide(node.from, node.to) })
        }
        break
      }
      case 'ListMark': {
        const raw = state.doc.sliceString(node.from, node.to).trim()
        // 待办项的圆点要去掉：它已经有复选框了，两个标记并排就是「• ☐ 文案」。
        const after = state.doc.sliceString(node.to, node.to + 4)
        if (/^\s+\[[ xX]\]/.test(after)) {
          hideMarker(state, node.from, node.to, ranges, isActiveLine(state, node.from))
          break
        }
        // `-` / `*` / `+` 画成真的圆点；`1.` 这种保留原文，序号就是用户写的
        if (/^[-*+]$/.test(raw) && !isActiveLine(state, node.from)) {
          ranges.push({
            from: node.from,
            to: node.to,
            deco: Decoration.replace({ widget: new ListBulletWidget() }),
          })
        } else {
          ranges.push({ from: node.from, to: node.to, deco: MARK({ class: 'cm-md-listmark' }) })
        }
        break
      }
      // 列表项：整行加类，类名里带上嵌套层级，CSS 据此缩进。
      // CM6 没有 ul/ol/li 元素，缩进只能自己算；层级来自语法的嵌套深度。
      case 'ListItem': {
        pushListItemLines(state, node.node, ranges)
        break
      }
      case 'FencedCode': {
        // 右上角的复制按钮挂在第一行（围栏那一行）末尾，鼠标悬停代码块时才显形。
        // 导出态不加：导出的是一篇文档，不是编辑器此刻的样子。
        const code = exportingCleanly(state) ? '' : codeInsideFence(state, node)
        if (code !== '') {
          ranges.push({
            from: state.doc.lineAt(node.from).to,
            to: state.doc.lineAt(node.from).to,
            deco: Decoration.widget({ widget: new CodeCopyWidget(code), side: 1 }),
          })
        }
        const startLine = state.doc.lineAt(node.from)
        const endLine = state.doc.lineAt(Math.max(node.from, node.to - 1))
        // 每一行都加底色，首行与末行额外加圆角，拼出一个代码块的外形
        for (let n = startLine.number; n <= endLine.number; n++) {
          const lineFrom = state.doc.line(n).from
          const cls = [
            'cm-md-codeblock',
            n === startLine.number ? 'cm-md-codeblock-first' : '',
            n === endLine.number ? 'cm-md-codeblock-last' : '',
          ].filter(Boolean).join(' ')
          ranges.push({ from: lineFrom, to: lineFrom, deco: BLOCK(cls) })
        }
        break
      }
      case 'QuoteMark': {
        // `>` 在光标不在这一行时藏起来（连它后面的空格），引用就该只看到竖线与文字
        if (isActiveLine(state, node.from)) {
          ranges.push({ from: node.from, to: node.to, deco: MARK({ class: 'cm-md-quotemark' }) })
        } else {
          hideMarker(state, node.from, node.to, ranges)
        }
        break
      }
      default:
        break
    }
  })
}

// ─── 标题与行内格式 ──────────────────────────────────────────────────────────
//
// 节点名以实际语法树为准（用 node_modules/.cache/domcheck 验过，见 scripts/tmp-domcheck.mjs）：
//   ATXHeading1..6   标题
//   EmphasisMark     `*` 与 `**` 都用这个名字，没有单独的 StrongEmphasisMark
//   StrikethroughMark `~~`
//   CodeMark         行内代码的反引号
//   InlineCode       行内代码本体
//   URL              链接地址
function collectInline(state: EditorState, ranges: DecorationRange[], front: Range | null): void {
  iterateContent(state, front, (node) => {
      const from = node.from
      const to = node.to
      const active = isActiveLine(state, from)

      switch (node.name) {
        case 'ATXHeading1':
        case 'ATXHeading2':
        case 'ATXHeading3':
        case 'ATXHeading4':
        case 'ATXHeading5':
        case 'ATXHeading6': {
          // 行装饰：标题的字号属于整行，加在行上才撑得住行高
          pushBlockLines(state, from, to, `cm-md-${node.name.toLowerCase()}`, ranges)
          break
        }
        case 'EmphasisMark':
        case 'StrikethroughMark':
        case 'CodeMark': {
          ranges.push({ from, to, deco: active ? MARK({ class: 'cm-md-marker' }) : hide(from, to) })
          break
        }
        case 'CodeInfo': {
          // 围栏上的语言名（```js 里的 js）。压淡，让它读起来是标注而不是代码。
          ranges.push({ from, to, deco: MARK({ class: 'cm-md-codeinfo' }) })
          break
        }
        case 'HeaderMark': {
          // 标题的 `#` 连同后面那个空格一起藏，否则标题会比正文右移一个字
          hideMarker(state, from, to, ranges, active)
          break
        }
        case 'InlineCode': {
          ranges.push({ from, to, deco: MARK({ class: 'cm-md-inlinecode' }) })
          break
        }
        case 'StrongEmphasis': {
          ranges.push({ from, to, deco: MARK({ class: 'cm-md-strong' }) })
          break
        }
        case 'Emphasis': {
          ranges.push({ from, to, deco: MARK({ class: 'cm-md-em' }) })
          break
        }
        case 'Strikethrough': {
          ranges.push({ from, to, deco: MARK({ class: 'cm-md-strike' }) })
          break
        }
        case 'URL': {
          ranges.push({ from, to, deco: MARK({ class: 'cm-md-url' }) })
          break
        }
        default:
          break
    }
  })
}

// ─── 分页 ────────────────────────────────────────────────────────────────────
//
// 一个 `---` 就是一页，这是放映与导出幻灯片 PDF 共用的切法（2026-09-26 定）。
//
// 页码写成行装饰的类名（`cm-md-page-N`），而不是让放映层去数 DOM 的第几个孩子：
// CM6 会往正文里插 gap 元素，序号对不上；而 `---` 在代码块里不是 HorizontalRule，
// 用语法树判断也就不会把代码块里的分隔线当成分页。
// 每页的第一行额外带 `cm-md-page-start`，导出时靠它插分页符。
export const PAGE_CLASS_PREFIX = 'cm-md-page-'
export const PAGE_START_CLASS = 'cm-md-page-start'

function collectPages(state: EditorState, ranges: DecorationRange[], front: Range | null): void {
  const breaks: number[] = []
  iterateContent(state, front, (node) => {
    if (node.name !== 'HorizontalRule') return
    breaks.push(state.doc.lineAt(node.from).number)
  })

  let page = 0
  let nextBreak = 0
  let startsPage = true
  for (let n = 1; n <= state.doc.lines; n++) {
    const lineFrom = state.doc.line(n).from
    const classes = [`${PAGE_CLASS_PREFIX}${page}`]
    if (startsPage) classes.push(PAGE_START_CLASS)
    ranges.push({ from: lineFrom, to: lineFrom, deco: BLOCK(classes.join(' ')) })
    startsPage = false
    // 分隔线归它结束的那一页，下一行开新的一页
    if (nextBreak < breaks.length && breaks[nextBreak] === n) {
      page++
      nextBreak++
      startsPage = true
    }
  }
}

// ─── 大纲跳转的落点高亮 ──────────────────────────────────────────────────────
//
// 用一个 effect 驱动，不再靠「派发一个空选区事务」去逼装饰重算：
// 装饰现在住在 StateField 里，只在文档或选区真的变了时才重算，空事务不会触发它。

export const headingFlashEffect = StateEffect.define<{ from: number; to: number } | null>()

/** 当前的落点高亮区间。effect 与重算共享这一份真相。 */
let currentFlash: { from: number; to: number } | null = null

// ─── 组装 ────────────────────────────────────────────────────────────────────

function buildDecorations(state: EditorState, flash: { from: number; to: number } | null): DecorationSet {
  const ranges: DecorationRange[] = []
  const text = state.doc.toString()
  const excluded = excludedRanges(text, syntaxTree(state))
  // 属性区的区间要算一次、多处用：压淡它、把它里面的 YAML 排出 markdown 排版、
  // 不让它的 `---` 被当成分页。
  const front = frontmatterRange(text)

  if (flash && flash.to <= state.doc.length) {
    ranges.push({ from: flash.from, to: flash.to, deco: MARK({ class: 'cm-md-jump-flash' }) })
  }

  collectBlocks(state, ranges, front)
  collectLinks(state, ranges, front)
  collectFootnotes(state, ranges, front)
  collectHTML(state, ranges, front)
  collectImages(state, ranges, front)
  collectPages(state, ranges, front)
  collectInline(state, ranges, front)
  collectFrontmatter(state, ranges, front)
  collectTables(state, ranges, front)
  collectTaskItems(state, ranges, front)
  collectMermaid(state, ranges, front)
  collectHighlight(state, ranges, excluded)
  // 公式放最后：它覆盖区间，其它装饰不该插进它里面
  collectMath(state, ranges)

  ranges.sort((a, b) => a.from - b.from || a.to - b.to)
  const builder = new RangeSetBuilder<Decoration>()
  for (const r of ranges) builder.add(r.from, r.to, r.deco)
  return builder.finish()
}

/**
 * 装饰层。
 *
 * 重算是「文档变了或选区变了」才做：选区决定哪些标记显形，所以点一下也要重算。
 * 其余事务（比如落点高亮的开关）由 effect 单独驱动，靠 flash 值判断。
 */
export const livePreviewField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state, null),
  update(deco, tr) {
    const flash = tr.effects.find((effect) => effect.is(headingFlashEffect))
    const flashValue = flash ? (flash.value as { from: number; to: number } | null) : currentFlash
    if (flash) currentFlash = flashValue
    const parsed = tr.effects.some((effect) => effect.is(decorationsRefreshEffect))
    // 文档换了个文件，图片的相对路径要按新的基准重新解析
    const rebased = tr.effects.some((effect) => effect.is(setDocumentFileUrlEffect))
    // 焦点变化与导出开关都要重算：前者决定「正在编辑」那一行的源码显不显形，
    // 后者在导出时把这一层整个关掉。
    const focused = tr.state.field(editorFocusField, false) ?? false
    const wasFocused = tr.startState.field(editorFocusField, false) ?? false
    const clean = tr.state.field(cleanExportField, false) ?? false
    const wasClean = tr.startState.field(cleanExportField, false) ?? false
    if (!tr.docChanged && !tr.selection && !flash && !parsed && !rebased && focused === wasFocused && clean === wasClean) return deco
    return buildDecorations(tr.state, flashValue)
  },
  provide: (field) => EditorView.decorations.from(field),
})

/** 解析往前推进之后，请重算一次装饰。 */
export const decorationsRefreshEffect = StateEffect.define<null>()

/**
 * 装饰是从语法树上读出来的，而语法树是**按视口惰性解析**的：长文档刚打开时，
 * 树只覆盖开头一段。用户滚到没解析过的地方，CM6 会照常把那几行渲染出来，但那时
 * 装饰里根本没有它们，于是屏幕上显示的是原始源码（`- **加粗**` 这种），
 * 要等下一次重算（点一下、敲一下）才恢复正常。
 *
 * 所以这里盯着视口：树没铺到视口末尾就推一把解析，解析推进了就请装饰重算一次。
 * `forceParsing` 自己会在树变了之后派发一次空事务，于是这个插件会被再叫一次，
 * 那时再重算，滚动到哪儿就渲染到哪儿。
 *
 * 两件事都推到 `setTimeout` 里做：**update 进行中不允许 dispatch**，就地派发会让
 * 插件直接崩掉（`Calls to EditorView.update are not allowed while an update is in progress`）。
 */
const parseRefresh = ViewPlugin.fromClass(class {
  private parsed = 0
  private pending = false
  private attempts = 0
  update(update: ViewUpdate) {
    const tree = syntaxTree(update.state)
    const grew = tree.length > this.parsed
    this.parsed = tree.length
    const viewportEnd = update.view.viewport.to
    if (tree.length >= viewportEnd) {
      this.attempts = 0
      if (grew) this.later(update.view, null)
      return
    }
    this.later(update.view, viewportEnd)
  }
  private later(view: EditorView, parseTo: number | null) {
    if (this.pending) return
    this.pending = true
    setTimeout(() => {
      this.pending = false
      if (!view.dom.isConnected) return
      if (parseTo !== null) forceParsing(view, parseTo)
      view.dispatch({ effects: decorationsRefreshEffect.of(null) })
      // `forceParsing` 是有时间预算的：机器忙的时候一次推不到视口末尾，
      // 而装饰是照着语法树算的，树没铺到的地方就会露出原始 markdown。
      // 所以要一直补到铺满为止（次数封顶，避免文档本身有问题时空转）。
      if (syntaxTree(view.state).length < view.viewport.to && this.attempts < 40) {
        this.attempts += 1
        this.later(view, view.viewport.to)
      }
    }, 0)
  }
})

// 这几个必须一起装进编辑器：`livePreviewField` 要读前两个 field，
// 读不到就当成「没有焦点、不在导出」，那一行源码就永远不会显形；
// `parseRefresh` 负责在解析推进后叫它重算。
export const livePreview: Extension = [
  editorFocusField,
  cleanExportField,
  documentFileUrlField,
  livePreviewField,
  parseRefresh,
]

export { WidgetType }
