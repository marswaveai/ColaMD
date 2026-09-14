// The sample document for the web playground. It is written to show what a theme
// actually changes (headings, body weight, lists, quote, code, table), not to
// teach Markdown, and it stays free of diagrams and formulas on purpose: the
// playground is about looks, not about the full feature set.

export const SAMPLES: Record<'zh' | 'en', string> = {
  zh: `# 主题样张

> 换一个主题，这一页的颜色、字号和留白都会跟着变。下面这些元素是最能看出差别的地方。

## 一段正文

ColaMD 把你写的 Markdown 直接显示成排版后的样子，不用分屏预览。这里有**加粗**、*斜体*、\`行内代码\`，还有一个[链接](https://colamd.com/)。

## 列表

- 无序列表的一项
- 带 **加粗** 的一项
  - 嵌套进来的一项

1. 有序列表的第一条
2. 第二条

## 任务与引用

- [x] 已经写完的事
- [ ] 还没写完的事

> 引用块：写完之后可以直接发出去。

## 代码

\`\`\`js
const editor = createEditor('editor')
editor.focus()
\`\`\`

## 表格

| 主题 | 底色 | 适合 |
| --- | --- | --- |
| 浅色 | 白 | 白天写作 |
| 深色 | 深灰 | 夜里看稿 |
| 羊皮纸 | 米黄 | 长文阅读 |

---

正文到底了。换上面的主题试试，也可以直接在这里改字。`,
  en: `# Theme sample

> Switch a theme and this whole page changes: colors, type scale and spacing. These elements show the difference best.

## Body text

ColaMD shows your Markdown as finished text while you type, with no split preview. Here is **bold**, *italic*, \`inline code\`, and a [link](https://colamd.com/).

## Lists

- A bullet
- One with **bold** inside
  - A nested bullet

1. First ordered item
2. Second one

## Tasks and quotes

- [x] Done already
- [ ] Not done yet

> A quote block: write it, then send it as it looks.

## Code

\`\`\`js
const editor = createEditor('editor')
editor.focus()
\`\`\`

## Table

| Theme | Background | Made for |
| --- | --- | --- |
| Light | White | Writing in the daytime |
| Dark | Near black | Reading at night |
| Sepia | Warm paper | Long reads |

---

That is the end of the sample. Switch themes above, or just start editing here.`
}
