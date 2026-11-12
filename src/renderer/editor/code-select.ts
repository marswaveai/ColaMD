// 代码块里的 ⌘A：先选中这一段代码，再按一次才是全文。
//
// 照 Typora：光标在代码块里时，要的几乎总是「这段代码」，全文反而少见。引用、列表里不这样，
// 那里 ⌘A 仍是全文。选中的是围栏之间的代码，不含 ``` 那两行，复制出来就是代码本身。

import { syntaxTree } from '@codemirror/language'
import { Prec, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'

function fenceAt(view: EditorView, pos: number): SyntaxNode | null {
  const tree = syntaxTree(view.state)
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name === 'FencedCode') return node
    }
  }
  return null
}

function selectCodeBlock(view: EditorView): boolean {
  const { state } = view
  const range = state.selection.main
  const fence = fenceAt(view, range.from)
  if (!fence || range.to > fence.to) return false
  const open = state.doc.lineAt(fence.from)
  const last = fence.lastChild
  const closed = !!last && last.name === 'CodeMark' && last.from > open.to
  const from = Math.min(open.to + 1, state.doc.length)
  const to = closed ? state.doc.lineAt(last.from).from - 1 : fence.to
  // 空代码块，或者已经选中了整段代码：交给默认的全选
  if (to <= from || (range.from === from && range.to === to)) return false
  view.dispatch({ selection: { anchor: from, head: to }, userEvent: 'select' })
  return true
}

export const codeBlockSelectAll: Extension = Prec.high(keymap.of([{ key: 'Mod-a', run: selectCodeBlock }]))
