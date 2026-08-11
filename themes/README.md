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

ColaMD custom themes are plain CSS files. You can style the editor by targeting CSS custom properties or writing direct selectors.

### CSS Variables

```css
body {
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

For more control, target elements directly:

```css
#editor .ProseMirror { font-family: Georgia, serif; }
#editor .ProseMirror strong { color: #c44b2b; }
#editor .ProseMirror pre { background: #2c2c2c; color: #e0dcd7; }
```

### Tips

- Theme files should be self-contained (no external imports)
- Test that all variables are defined to avoid invisible text
- Name the file descriptively: `dark-ocean.css`, `solarized-light.css`, etc.
