// 文本层面的格式命令：加粗、斜体、行内代码、删除线、链接、列表。
//
// 这里是「文本优先」架构最能体现差别的地方。旧实现在操作文档树里的 mark：
// 给一段文字加上 bold 标记，至于文件里该写 `**` 还是 `__`，由序列化器事后决定。
// 新实现直接在缓冲区里改字符：加粗就是在这段文字两端插入 `**`。
//
// 好处是可预测、可撤销，而且**只动用户选中的那段字节**，其余部分不受影响。

import type { EditorView } from '@codemirror/view'

export type FormatCommandId =
  | 'bold'
  | 'italic'
  | 'inlineCode'
  | 'strikethrough'
  | 'link'
  | 'bulletList'
  | 'orderedList'

interface MarkerSpec {
  /** 包裹式标记，如加粗的 `**`。 */
  wrap: string
}

const WRAP_COMMANDS: Record<string, MarkerSpec> = {
  bold: { wrap: '**' },
  italic: { wrap: '*' },
  inlineCode: { wrap: '`' },
  strikethrough: { wrap: '~~' },
}

/** 选区是否已经被这对标记包裹（含标记自身被选中一半的情况）。 */
function isWrapped(view: EditorView, from: number, to: number, wrap: string): boolean {
  const text = view.state.doc.toString()
  const len = wrap.length
  const before = text.slice(Math.max(0, from - len), from)
  const after = text.slice(to, to + len)
  return before === wrap && after === wrap
}

/** 在选区两端加上标记；已加则移除（toggle）。 */
function toggleWrap(view: EditorView, wrap: string): void {
  const { from, to } = view.state.selection.main
  if (from === to) return

  if (isWrapped(view, from, to, wrap)) {
    // 移除两端标记
    view.dispatch({
      changes: [
        { from: from - wrap.length, to: from, insert: '' },
        { from: to, to: to + wrap.length, insert: '' },
      ],
      selection: { anchor: from - wrap.length, head: to - wrap.length },
    })
    return
  }

  // 选区内侧若已有标记（用户把标记也选进来了），先剥掉再统一加，避免叠成 `****`
  const text = view.state.doc.sliceString(from, to)
  const trimmed = text.startsWith(wrap) && text.endsWith(wrap) && text.length > wrap.length * 2
    ? text.slice(wrap.length, -wrap.length)
    : text

  view.dispatch({
    changes: { from, to, insert: `${wrap}${trimmed}${wrap}` },
    selection: { anchor: from + wrap.length, head: from + wrap.length + trimmed.length },
  })
  view.focus()
}

/** 取选区覆盖的整行范围。 */
function selectedLines(view: EditorView): { from: number; to: number; lines: string[] } {
  const { from, to } = view.state.selection.main
  const startLine = view.state.doc.lineAt(from)
  const endLine = view.state.doc.lineAt(to)
  const lines: string[] = []
  for (let n = startLine.number; n <= endLine.number; n++) {
    lines.push(view.state.doc.line(n).text)
  }
  return { from: startLine.from, to: endLine.to, lines }
}

/** 在选中行的行首加/去列表前缀（toggle）。 */
function toggleList(view: EditorView, ordered: boolean): void {
  const { from, to, lines } = selectedLines(view)
  // 已经是同类列表就整体去掉，否则换成目标列表
  const bulletRe = /^(\s*)([-*+])\s+/
  const orderedRe = /^(\s*)(\d+)\.\s+/
  const isSameKind = lines.every((l) => (ordered ? orderedRe.test(l) : bulletRe.test(l)))
  const next = lines
    .map((line, i) => {
      if (isSameKind) return line.replace(ordered ? orderedRe : bulletRe, '$1')
      const stripped = line.replace(bulletRe, '$1').replace(orderedRe, '$1')
      return ordered ? stripped.replace(/^(\s*)/, `$1${i + 1}. `) : stripped.replace(/^(\s*)/, '$1- ')
    })
    .join('\n')

  view.dispatch({ changes: { from, to, insert: next } })
  view.focus()
}

/** 给选区包一条链接。URL 由调用方从主进程剪贴板取到后传入。 */
export function wrapLink(view: EditorView, url: string): void {
  const { from, to } = view.state.selection.main
  if (from === to) return
  const text = view.state.doc.sliceString(from, to)
  view.dispatch({
    changes: { from, to, insert: `[${text}](${url})` },
    selection: { anchor: from + 1, head: from + 1 + text.length },
  })
  view.focus()
}

/** 选区是否已经是链接，是则返回其外沿区间，用于「再按一次取消」。 */
export function linkRangeAt(view: EditorView, from: number, to: number): { from: number; to: number } | null {
  const text = view.state.doc.toString()
  const re = /\[([^\]]*)\]\((\S+?)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const start = m.index
    const end = m.index + m[0].length
    if (start <= from && end >= to) return { from: start, to: end }
    if (start > to) break
  }
  return null
}

/** 执行一条格式命令。 */
export function runFormatCommand(view: EditorView, id: FormatCommandId): void {
  if (!view.hasFocus) return
  const wrapSpec = WRAP_COMMANDS[id]
  if (wrapSpec) {
    toggleWrap(view, wrapSpec.wrap)
    return
  }
  if (id === 'bulletList') {
    toggleList(view, false)
    return
  }
  if (id === 'orderedList') {
    toggleList(view, true)
    return
  }
  if (id === 'link') {
    const { from, to } = view.state.selection.main
    if (from === to) return
    // 已是链接则取消
    const existing = linkRangeAt(view, from, to)
    if (existing) {
      const raw = view.state.doc.sliceString(existing.from, existing.to)
      const m = /^\[([^\]]*)\]\((\S+?)\)$/.exec(raw)
      if (m) {
        view.dispatch({
          changes: { from: existing.from, to: existing.to, insert: m[1] },
          selection: { anchor: existing.from, head: existing.from + m[1].length },
        })
        view.focus()
        return
      }
    }
    void window.electronAPI.readClipboardText().then((text) => {
      const url = text.trim()
      if (!/^https?:\/\/\S+$/i.test(url)) return
      wrapLink(view, url)
    })
  }
}
