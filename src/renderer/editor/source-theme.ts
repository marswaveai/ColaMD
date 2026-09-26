// 编辑器自己的外观与语法着色。
//
// 这里只负责「怎么画」，不碰文档内容。
//
// 一条纪律：**字号、行高、颜色都写在 themes/editor-preview.css 的行类与 mark 类上，
// 这里只管字重、斜体、删除线。** 两个理由：
//   1. HighlightStyle 作用在行内的 span 上，若在这里也设 fontSize，行类与 span 会各放大
//      一次（标题一度变成 1.75em × 1.75em，大得离谱）。
//   2. 颜色写在这里就等于把主题色从主题 CSS 里搬走一半，改主题要改两个地方。

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

export const markdownHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, fontWeight: '700' },
  { tag: t.heading2, fontWeight: '700' },
  { tag: t.heading3, fontWeight: '600' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '600' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--link-color)' },
  { tag: [t.processingInstruction, t.contentSeparator, t.list], color: 'var(--text-muted)' },

  /* 代码块里的语法着色。解析器在 state.ts 里通过 `codeLanguages` 接进来（装了哪些
     语言就认哪些），这里只决定怎么画。
     颜色是变量，不是字面值：--code-* 由主题按代码块底色的明暗给两套（见 base.css），
     深浅主题和自定义主题都自动跟着走。
     运算符、标点、括号**不给颜色**，让它们跟着代码块正文色走，否则整块代码会花。 */
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword, t.self, t.modifier], color: 'var(--code-keyword)' },
  { tag: [t.string, t.special(t.string), t.escape], color: 'var(--code-string)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--code-comment)' },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.unit, t.constant(t.variableName)], color: 'var(--code-number)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.labelName], color: 'var(--code-function)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--code-type)' },
  { tag: [t.propertyName, t.attributeName, t.definition(t.propertyName), t.definition(t.variableName), t.tagName], color: 'var(--code-property)' },
  { tag: [t.meta, t.annotation, t.documentMeta, t.regexp], color: 'var(--code-meta)' },
])

// 编辑器自己的外观。背景透明，让外面的 #editor 容器和主题控制底色。
export const editorTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--text-color)' },
  '.cm-scroller': {
    fontFamily: 'var(--font-body, inherit)',
    lineHeight: '1.75',
    overflow: 'auto',
  },
  /* `.cm-content` 的宽度、居中与内边距全在 themes/editor-preview.css 里（那里用
     `#editor .cm-content` 提高优先级，因为 baseTheme 的样式是运行时注入的，同优先级时它总在后面）。
     这里不再给 `.cm-content` 写任何东西，免得出现第二条真相。 */
  '&.cm-focused': { outline: 'none' },
  /* 这里**不能**给 `.cm-line` 设内边距。
     CodeMirror 自己的 baseTheme 给每行钉了 `padding: 0 2px 0 6px`，而主题选择器
     （`.ͼX .cm-line`，两个类）比 themes/editor-preview.css 里的行类（一个类）优先，
     一旦在这里写 padding，引用块、列表、代码块的内边距会被整片吃掉（实测全为 0px）。
     归零与块级内边距都写在 editor-preview.css 里，用同样两个类的选择器，靠文件顺序决胜。 */
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text-color)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--selection-bg, color-mix(in srgb, var(--text-color) 18%, transparent))',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-selectionMatch': { backgroundColor: 'var(--chrome-bg-hover, color-mix(in srgb, var(--text-color) 14%, transparent))' },
  '.cm-searchMatch': { backgroundColor: 'var(--search-match-bg, color-mix(in srgb, var(--text-color) 16%, transparent))' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--search-current-bg, color-mix(in srgb, var(--text-color) 26%, transparent))' },
})
