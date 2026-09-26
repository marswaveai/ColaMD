// 检索高亮的装饰。
//
// 单独成一个文件是为了打断一个循环依赖：装饰要装进编辑器扩展（core.ts），而检索面板
// （search-panel.ts）要用同一个 effect 去改它。两边都从这里取，谁也不用 import 谁。
//
// 关键一条：装饰必须真的装进编辑器。这里定义了 StateField 但没人 `provide` 它，
// 面板派发的 effect 就没有任何 StateField 接住，高亮会静默地什么也不做
// （面板自己以为画上了）。core.ts 的扩展表里有它。

import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { StateEffect, StateField } from '@codemirror/state'

/** 换掉当前的高亮集合。传 `Decoration.none` 就是清空。 */
export const setSearchHighlight = StateEffect.define<DecorationSet>()

export const searchHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSearchHighlight)) return effect.value
    }
    return value.map(tr.changes)
  },
  provide: (field) => EditorView.decorations.from(field),
})
