import { StateEffect, StateField, type EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { livePreviewField } from './live-preview'

/** 这个位置所在的行是不是代码块。复用 live-preview 已经给行加上的 `cm-md-codeblock`，不另起一套。 */
function inCodeBlock(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos)
  let code = false
  state.field(livePreviewField).between(line.from, line.from, (_from, _to, decoration) => {
    if (decoration.spec.class?.split(' ').includes('cm-md-codeblock')) code = true
  })
  return code
}

// 拖放时那条插入竖线（dropCursor）的落点。CodeMirror 自己记落点的状态不导出，
// 这里用同样的 posAtCoords 算一遍，只记「是不是落在代码块里」。
const setDropInCode = StateEffect.define<boolean>()
const dropInCode = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => tr.effects.reduce((next, effect) => (effect.is(setDropInCode) ? effect.value : next), value),
})

function setDrop(view: EditorView, code: boolean): void {
  if (view.state.field(dropInCode) !== code) view.dispatch({ effects: setDropInCode.of(code) })
}

/**
 * 光标在代码块里时换成代码块的文字色（见 source-theme）。
 *
 * 光标画在单独的一层上，不在行里，继承不到所在行的颜色。雅致、熊红这类主题的代码块是深底，
 * 正文色的光标落进去几乎看不见。输入光标只看主光标：编辑器没有开多选，不会出现第二个。
 * 拖放的插入竖线同理：落点在代码块里时挂 `cm-drop-in-code`。
 */
export const cursorColors = [
  dropInCode,
  EditorView.domEventObservers({
    dragover(event, view) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      setDrop(view, pos !== null && inCodeBlock(view.state, pos))
    },
    // 判据与 CodeMirror 的 dropCursor 一致：真的离开了编辑区才算
    dragleave(event, view) {
      if (event.target === view.contentDOM || !view.contentDOM.contains(event.relatedTarget as Node | null)) setDrop(view, false)
    },
    dragend: (_event, view) => setDrop(view, false),
    drop: (_event, view) => setDrop(view, false),
  }),
  EditorView.editorAttributes.compute(['selection', livePreviewField, dropInCode], (state): Record<string, string> => {
    const classes = [
      inCodeBlock(state, state.selection.main.head) ? 'cm-cursor-in-code' : '',
      state.field(dropInCode) ? 'cm-drop-in-code' : '',
    ].filter(Boolean)
    return classes.length ? { class: classes.join(' ') } : {}
  }),
]
