// 编辑器状态层：文本优先核心中不依赖 DOM 的那一半。
//
// 为什么要把这一半单独拿出来：验收脚本（scripts/verify-markdown.mjs）要在纯 Node 里
// 证明「打开一份文件、不做修改、保存，字节不变」。要证的是**字节**，而字节的真相在
// EditorState 里，不在 EditorView 里——view 管的是排版、光标、滚动，全都要真实布局
// 测量，在 Node 里既造不出来、也与保真无关。
//
// 所以状态层的边界是：**能进 harness 的都必须无 DOM**。
// 装饰层（live-preview）不在这里，它是画的事；它只画不写，装不装都不影响字节。

import { EditorState, Compartment, type Extension } from '@codemirror/state'
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { indentOnInput, bracketMatching, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches } from '@codemirror/search'
import { keymap } from '@codemirror/view'
import { markdownHighlightStyle } from './source-theme'

/** 可编辑性放在一个 compartment 里，方便运行时切换而不重建编辑器。 */
export const editableCompartment = new Compartment()

/**
 * 状态层的扩展集合：语言解析、语法高亮、撤销栈、缩进、快捷键。
 *
 * 这里的解析「只用于决定怎么画」，不参与决定写什么——文件写回去的是缓冲区里的原始
 * 字节，跟解析结果无关。这就是为什么解析器可以随便换、解析错了也不会伤到文件。
 */
export function stateExtensions(): Extension {
  return [
    history(),
    indentOnInput(),
    bracketMatching(),
    highlightSelectionMatches(),
    // markdown 语言支持 + 语法高亮（颜色走 CSS 变量，深浅主题自动跟随）
    markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false }),
    syntaxHighlighting(markdownHighlightStyle),
    // 这里**不装** `searchKeymap`：它会绑 Cmd+F 打开 CodeMirror 自带的那块检索面板，
    // 那块面板只有英文、也不跟主题走，和我们自己的检索面板（有中英文、按主题上色）撞在
    // 一起。查找是应用级功能，入口在菜单的「查找」上（Cmd+F 由菜单的快捷键发
    // `editor:search`），面板在 editor/search-panel.ts。
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
  ]
}

/** 用一份文本建一个编辑器状态。换文件（flush）时用它，撤销栈随之清空。 */
export function createState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: stateExtensions() })
}
