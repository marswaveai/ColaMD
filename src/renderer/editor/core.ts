// 编辑器核心：源码缓冲区是唯一真相。
//
// 这个文件取代了原来的 milkdown/ProseMirror 核心。设计原则见
// docs/editor-architecture.md，一句话：**缓冲区里存的就是文件的字节，渲染是叠在
// 它上面的一层装饰。** 保存时把缓冲区原样写回，不做任何序列化。
//
// 由此得到一条可以在 CI 里断言的纪律：用户没改过的字节，保存时不变。
//
// 这一层需要 DOM（EditorView 要做布局测量）。不依赖 DOM 的那一半在 state.ts 里，
// 验收脚本直接消费那一半，所以保真的证明不需要真实浏览器。

import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, dropCursor, highlightSpecialChars, rectangularSelection, crosshairCursor } from '@codemirror/view'
import { undo, redo } from '@codemirror/commands'
import { livePreview, setEditorFocus } from './live-preview'
import { listInput } from './list-input'
import { searchHighlightField } from './search-highlight'
import { stateExtensions, editableCompartment } from './state'
import { editorTheme } from './source-theme'

export interface EditorOptions {
  /** 初始文本。就是文件的字节。 */
  doc?: string
  /** 文档变化时回调，参数是当前完整文本。 */
  onChange?: (markdown: string) => void
  /** 是否可编辑（放映幻灯片时会锁住）。 */
  editable?: boolean
}

/** 编辑器对外句柄。外壳只认这个，不认 CodeMirror。 */
export interface EditorHandle {
  /** 当前缓冲区内容，即文件应有的字节。 */
  getText(): string
  /** 用新文本替换整个文档（换文件、外部改动）。会清空撤销栈。 */
  setText(text: string, clearHistory?: boolean): void
  /** 把光标放到文档末尾的下一行（追加内容用）。 */
  appendText(text: string): void
  /** 聚焦。 */
  focus(): void
  /** 设置是否可编辑。 */
  setEditable(editable: boolean): void
  /** 撤销 / 重做。 */
  undo(): void
  redo(): void
  /** 拿到底层 view（装饰层、搜索面板需要）。 */
  getView(): EditorView
  /** 销毁。 */
  destroy(): void
}

let handle: EditorHandle | null = null

export function getEditorHandle(): EditorHandle | null {
  return handle
}

export function createEditorCore(parent: HTMLElement, options: EditorOptions = {}): EditorHandle {
  const changeListener = options.onChange

  const extension = [
    // 状态层：语言、高亮、撤销栈、缩进、快捷键（无 DOM，可进 harness）
    stateExtensions(),
    // 以下是 view 层：选区绘制、拖放光标、特殊字符、主题
    drawSelection(),
    // 自动换行。CodeMirror 默认**不换行**，长行会横向滚动；markdown 正文必须换行。
    EditorView.lineWrapping,
    dropCursor(),
    highlightSpecialChars(),
    rectangularSelection(),
    crosshairCursor(),
    editorTheme,
    // 装饰层：把源码画成所见即所得。它只画不写，所以装在这里不会影响
    // 「没改过的字节不许变」这条纪律。
    livePreview,
    // 焦点变化要重算装饰：只有**正在编辑**的那一行才显示源码（见 live-preview 的 setEditorFocus）。
    // 用 DOM 事件而不是 EditorView.focusChangeEffect，是因为后者在创建时就已带焦点的编辑器上
    // 不会触发；下面创建完 view 之后补了一次初始值。
    EditorView.domEventHandlers({
      focus: (_event, view) => {
        if (view.dom.isConnected) view.dispatch({ effects: setEditorFocus.of(true) })
        return false
      },
      blur: (_event, view) => {
        if (view.dom.isConnected) view.dispatch({ effects: setEditorFocus.of(false) })
        return false
      },
    }),
    // 回车续列表。这是编辑器的输入手感，与渲染无关，所以单独一个模块。
    listInput,
    // 检索高亮。面板靠 effect 改它，而 effect 得有 StateField 接住；
    // 不装这一条，检索面板会以为高亮画上了，实际什么也没发生。
    searchHighlightField,
    editableCompartment.of(EditorView.editable.of(options.editable ?? true)),
    // 文档变化的唯一出口：把新文本交给外壳
    EditorView.updateListener.of((update) => {
      if (update.docChanged && changeListener) {
        changeListener(update.state.doc.toString())
      }
    }),
  ]

  const view = new EditorView({
    state: EditorState.create({ doc: options.doc ?? '', extensions: extension }),
    parent,
  })

  // 创建时就已经带焦点的编辑器不会触发 focus 事件（它一直是焦点），这里补一次初始值。
  // 不做这一步，用户一打开文件就打字，标记却不会显形。
  if (view.hasFocus) view.dispatch({ effects: setEditorFocus.of(true) })

  const api: EditorHandle = {
    getText: () => view.state.doc.toString(),

    setText(text: string, clearHistory = false): void {
      if (view.state.doc.toString() === text) return
      // 换文件时必须把撤销栈清掉，否则撤销会跨文档串味。
      const next = clearHistory
        ? EditorState.create({ doc: text, extensions: extension })
        : view.state.update({ changes: { from: 0, to: view.state.doc.length, insert: text } }).state
      view.setState(next)
    },

    appendText(text: string): void {
      const end = view.state.doc.length
      const needsBreak = end > 0 && !view.state.doc.toString().endsWith('\n')
      view.dispatch({
        changes: { from: end, insert: (needsBreak ? '\n' : '') + text },
        selection: { anchor: end + (needsBreak ? 1 : 0) + text.length },
      })
      view.focus()
    },

    focus: () => view.focus(),
    setEditable(editable: boolean): void {
      view.dispatch({ effects: editableCompartment.reconfigure(EditorView.editable.of(editable)) })
    },
    undo: () => { undo(view) },
    redo: () => { redo(view) },
    getView: () => view,
    destroy(): void {
      view.destroy()
      handle = null
    },
  }

  handle = api
  return api
}

export { createState } from './state'
