# Markdown Syntax Reference

ColaMD supports the Markdown syntax you use every day, plus highlights, task lists, and formulas.

## Headings

# Heading 1

## Heading 2

### Heading 3

Source: add `#` and a space before the heading text. Use up to six `#` characters.

## Emphasis

**Bold**, *italic*, ~~strikethrough~~, `inline code`, and ==highlight==

Source: `**bold**`, `*italic*`, `~~strikethrough~~`, and `==highlight==`.

## Links and images

[ColaMD](https://github.com/marswaveai/ColaMD)

Hold Cmd / Ctrl while clicking a link to open it in your browser.

Source: `[label](https://example.com)`. Images use `![alt text](image-path)` and support local relative paths.

## Lists

- Unordered item
- Another item

1. Ordered item
2. Another item

Source: `- item` or `* item`; ordered lists use `1. item`.

## Task lists

- [ ] An unfinished task
- [x] A completed task

Click the checkbox to toggle it. You can also place the cursor on a task and press Cmd / Ctrl + Enter.

Source: `- [ ] unfinished` and `- [x] completed`.

## Code

Inline code: `const answer = 42`

```js
function hello() {
  return 'world'
}
```

Source: wrap inline code in one backtick; use three backticks for a fenced code block. Add a language name for syntax highlighting.

## Quotes and rules

> A quoted paragraph.

---

Source: add `>` at the beginning of a quote. Put `---` on a line by itself for a horizontal rule. When playing the slideshow, `---` is also a page break (View → Play Slideshow, ⌘⇧P).

## Tables

| Name | Description |
| --- | --- |
| ColaMD | Agent Native Markdown editor |

Source: separate columns with `|` and use `---` in the second row.

## Formulas

Press Cmd+Shift+E (Ctrl+Shift+E on Windows / Linux) to insert a formula. KaTeX renders both block formulas and inline formulas:

$$
E = mc^2
$$

Inline: $a^2 + b^2 = c^2$.

## Smart line breaks

A single newline in Markdown is rendered as a line break. This matches the way people and AI agents commonly write Markdown.
