# ColaMD

> A free, elegant Markdown editor anyone can pick up. No toolbars, no clutter, and the file on disk is always what you see.

**Language / 语言: [English](README.md) · [中文](README_CN.md)** · [Website](https://colamd.com/)

ColaMD is an open-source, free, elegant Markdown editor for writing, notes, and documentation. It is built for people who just want to write: no toolbars, no status bar, nothing to configure: the window holds a title bar, your text, and a file list.

It offers true WYSIWYG editing, 12 built-in themes, rich-text copy, smart line breaks, search and replace, a document outline, PDF / HTML / Word export, and support for macOS, Windows, and Linux.

Whatever writes the file (an AI agent such as Claude Code or Codex, a script, or another editor), ColaMD shows the new content right away. No reopening, no manual refresh.

Our goal is clear: make ColaMD the best free Markdown editor anyone can pick up.

If ColaMD is useful to you, please give the project a ⭐ Star.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub release](https://img.shields.io/github/release/marswaveai/colamd.svg)](https://github.com/marswaveai/colamd/releases)

[Download](#download) | [Features](#features) | [Development](#development)

---

## Features

- **Always in Sync**: Whenever the file changes on disk (an AI agent, a script, another editor), the editor updates immediately.
- **True WYSIWYG Editing**: Type Markdown and see rich text directly. No split-pane preview.
- **File List Panel**: Browse Markdown files in the current folder and its subdirectories. A fresh launch starts with bundled examples, so it never asks for Documents-folder permission before you open your own file; files created or removed by your agent appear automatically.
- **Source Mode**: Switch to the raw Markdown source whenever you need to inspect or edit it directly.
- **Task Lists**: Click checkboxes to complete tasks, or use the keyboard shortcut.
- **Highlights & LaTeX**: Write `==highlighted text==` and render mathematical formulas with KaTeX.
- **Search**: Find anything in the current document with ⌘/Ctrl+F.
- **Smart Line Breaks**: Single newlines render as line breaks, matching how people and AI tools write Markdown.
- **Rich Text Copy**: Copy content with formatting preserved into WeChat, email, and other rich-text editors.
- **Themes**: Twelve built-in themes, downloadable themes, and custom CSS imports.
- **PDF & HTML Export**: Turn your Markdown document into a PDF or a self-contained HTML file when you need a finished copy.
- **Portable Image Paths**: Local images use safe `file://` URLs for display and return to relative paths when saved.
- **VS Code Integration**: Open the current Markdown file in ColaMD directly from VS Code.
- **Minimal by Design**: No toolbar, no permanent sidebar, no distractions.
- **Cross-Platform**: Available for macOS, Windows, and Linux.

## Screenshots

<p align="center">
  <img src="docs/images/markdown-cheatsheet.png" alt="ColaMD Markdown cheatsheet and interactive task list" width="49%">
  <img src="docs/images/markdown-rendering.png" alt="ColaMD Markdown rendering with code blocks, quotes, tables, and smart line breaks" width="49%">
</p>

<p align="center"><em>Built-in syntax reference, interactive task lists, code blocks, quotes, tables, and smart line breaks.</em></p>

## Works with your Markdown workflow

ColaMD does not ask you to change your habits. It works well alongside Obsidian, Typora, VS Code, and other Markdown apps, all sharing the same `.md` files, with each tool doing what it does best.

## Download

> Check [Releases](https://github.com/marswaveai/colamd/releases) for the latest builds.

| Platform | Format |
|----------|--------|
| macOS    | `.dmg` |
| Windows  | `.exe` |
| Linux    | `.AppImage` / `.deb` |

## What ColaMD Does NOT Do

ColaMD is intentionally simple:

- No full file tree or workspace (only a lightweight directory browser and Markdown file list)
- No cloud sync or collaboration
- No AI features built in: it's a **viewer/editor** for AI-generated content
- No plugin system

One thing, done well.

## Custom Themes

ColaMD supports custom CSS themes. Download themes from the [`themes/`](themes/) folder, or create your own and import via **Theme > Import Theme**.

Imported themes are saved to `~/.colamd/themes/` and persist across sessions.

## Development

```bash
git clone https://github.com/marswaveai/colamd.git
cd colamd
npm install
npm run dev
```

### Build

```bash
npm run dist:mac
npm run dist:win
npm run dist:linux
```

### Tech Stack

- **Electron**: Cross-platform desktop
- **Milkdown**: WYSIWYG Markdown (ProseMirror-based)
- **TypeScript**: Strict mode
- **electron-vite**: Fast builds

## Roadmap

ColaMD will keep growing as a focused, free Markdown editor:

- v1.1: Live file reload, file associations, drag & drop, themes
- v1.2: New icon
- v1.3: Agent activity indicator, Cmd+click links, rich text copy, smart line breaks, PDF export, theme persistence
- v1.6: Robust live sync: atomic-save (rename) detection, watcher self-recovery, spellcheck off
- v1.6.1: Editable task lists (click / ⌘+Enter), ==highlight== syntax, Markdown cheatsheet
- v1.6.2: Temporarily remove HTML export
- v1.7: Same-directory file list: switch files in place, live updates when agents create/remove files; search (⌘F) + LaTeX (⌘⇧E) from community PR #14
- v1.7.1: Task checkbox click fix, centered SVG checkmark, titlebar file-panel toggle button
- v1.7.2: Playable demo page: Help → 新功能演示 (⌘⇧D), a real directory showcasing each release's features
- v1.7.3: Demo page becomes a cumulative changelog: resources/demo/changelog.md records every release, opening straight into it (current)
- v1.7.4: Community-feedback release: file panel improvements, source mode, HTML export, Windows image paths, and a VS Code integration MVP
- v1.8.0: Preserve portable local image paths when saving, and close out the remaining community Issues
- v1.8.1: Refresh the macOS icon, improve startup speed, and add Chinese / English Markdown references
- Future: More themes, editor integrations, and smoother Markdown workflows

## License

[MIT](LICENSE), Free forever.

---

ColaMD is built by [Cola.app](https://cola.app) and maintained by [orange2ai](https://github.com/orange2ai). Issues, ideas and pull requests are welcome.
