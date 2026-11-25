# ColaMD Themes

ColaMD ships with 12 built-in themes. Every theme below is available as a standalone `.css` file — download it and place it in `~/.colamd/themes/`, or use **Theme > Import Theme** in ColaMD to import directly.

See the [theme swatches](https://raw.githubusercontent.com/marswaveai/ColaMD/main/docs/images/theme-swatches.svg) for a visual preview.

## Light Themes

| Theme | File | Description |
|-------|------|-------------|
| 浅色 Light | [light.css](light.css) | GitHub-inspired clean white. The default look. |
| 雅致 Elegant | [elegant.css](elegant.css) | Warm serif with terracotta accents, inspired by classic writing apps. |
| 简白 Notion | [notion.css](notion.css) | Clean minimal workspace, warm off-black text on white. |
| 作家 Writer | [writer.css](writer.css) | iA Writer homage: monospace body, zero decoration. |
| 熊红 Bear | [bear.css](bear.css) | Crisp white with confident red accent, Bear style. |
| 羊皮纸 Sepia | [sepia.css](sepia.css) | Kindle / Apple Books warm paper, serif body for long-form reading. |

## Dark Themes

| Theme | File | Description |
|-------|------|-------------|
| 深色 Dark | [dark.css](dark.css) | GitHub dark: soft black with blue links. |
| 暖木 Gruvbox | [gruvbox.css](gruvbox.css) | Warm walnut dark, cream text, orange ember accents. |
| 午夜 Midnight | [midnight.css](midnight.css) | Pure OLED black, Apple-style blue links, maximum contrast. |
| 夜航 Solarized Dark | [solarized-dark.css](solarized-dark.css) | Deep teal-black sea, muted cyan text, orange and blue stars. |
| 极地 Nord | [nord.css](nord.css) | Arctic night: cool blue-grays, frost-cyan links. |
| 德古拉 Dracula | [dracula.css](dracula.css) | Gothic neon: pink, purple, and cyan candlelight. |

## Creating Your Own Theme

ColaMD custom themes are plain CSS files. Start from [template.css](template.css): it is a working theme with every variable and a few selectors commented, and the same check that guards the built-in themes runs over it, so it can not teach you a selector that does nothing.

### CSS Variables

```css
:root {
  --bg-color: #ffffff;
  --text-color: #24292f;
  --text-secondary: #656d76;
  --text-muted: #656d76;
  --border-color: #d0d7de;
  --link-color: #0969da;
  --code-bg: rgba(0,0,0,0.05);
  --code-block-bg: #f6f8fa;
  --code-block-text: #24292f;
  --blockquote-border: #d0d7de;
  --blockquote-bg: transparent;
  --table-header-bg: #f6f8fa;
  --selection-bg: rgba(0,0,0,0.1);
}
```

`--text-secondary` is for readable labels and secondary copy. `--text-muted`
is reserved for subdued icons and disabled states. Search highlights derive
from `--link-color` automatically and can be overridden with
`--search-match-bg` and `--search-match-current-bg` when needed.

### Direct Selectors

For more control, target the editor's own class names. The editor keeps the file's
text as text and draws the formatting on top of it, so there are no `<h1>` or
`<blockquote>` elements to select. A heading is a *line* with a class, a quote is one
`div` per line, and bold text is a span:

```css
#editor .cm-content { font-family: Georgia, serif; }
#editor .cm-content .cm-md-inlinecode { color: #c44b2b; }
#editor .cm-content .cm-md-atxheading1 { letter-spacing: -0.01em; }
#editor .cm-content .cm-md-codeblock { background: #2c2c2c; color: #e0dcd7; }
```

The hooks available are:

| Selector | What it is |
|----------|------------|
| `#editor .cm-content` | The text column itself: font, size, line height, width |
| `.cm-md-atxheading1` ... `.cm-md-atxheading6` | Heading lines |
| `.cm-md-strong`, `.cm-md-em`, `.cm-md-strike`, `.cm-md-inlinecode`, `.cm-md-highlight` | Inline spans |
| `.cm-md-link`, `.cm-md-url` | Link text and the address behind it |
| `.cm-md-blockquote` | Quote lines |
| `.cm-md-codeblock` | Code block lines (the first and last also carry `-first` / `-last`, which is where the rounding goes) |
| `.cm-md-table-header .cm-md-table-cell`, `.cm-md-table-row:not(.cm-md-table-header) .cm-md-table-cell` | Table cells |
| `.cm-md-hr` | Horizontal rule |
| `.cm-md-li-0` ... `.cm-md-li-6` | List indentation by depth |

Because a quote or a code block is one `div` per line rather than one box around the
whole thing, keep vertical padding off them: it would be added once for every line.
Use `padding-left` / `padding-right` for breathing room instead.

A selector that matches nothing is a silent no-op, which is how the built-in themes
once shipped rules for an editor they no longer ran on. `npm run verify:themes` in the
repository fails on exactly that: every rule has to hit a real element and change at
least one computed style.

### Tips

- Theme files should be self-contained (no external imports)
- Omitted variables inherit ColaMD's Light defaults, so override only the tokens your theme needs
- Name the file descriptively: `dark-ocean.css`, `solarized-light.css`, etc.
