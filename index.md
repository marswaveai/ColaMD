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

*(Nine highlights. The full feature list lives in the [README](https://github.com/marswaveai/ColaMD#features).)*

- **True WYSIWYG**: Type Markdown and see rich text directly. No split-pane preview, nothing to learn.
- **Clean by Design**: No toolbar, no status bar, nothing to configure. Just a title bar, your text and a file list.
- **Always in Sync**: When the file changes on disk (an AI agent, a script, another editor), the editor updates right away. No reopening, no manual refresh.
- **Same-Directory Files**: Browse and switch between the Markdown files in the current folder, and drag the panel to the width you like. Files created by an agent appear automatically.
- **Outline & Progress**: Jump between headings, see the current section highlighted as you read, and get a brief flash at the landing point.
- **Find & Replace**: Search the current document with ⌘/Ctrl+F, then replace a single match or all of them.
- **Export**: Turn a document into PDF, Word or a self-contained HTML file, with your theme colors kept.
- **Rich Text Copy**: Copy content with formatting preserved into WeChat, email and other rich-text editors.
- **Cross-Platform**: Available for macOS, Windows and Linux, with English and Chinese interfaces. Free and open source.

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
- v1.7: Same-directory file list, search (⌘F), LaTeX (⌘⇧E)
- v1.7.4: Community-feedback release: file panel improvements, source mode, HTML export, Windows image paths, and a VS Code integration MVP
- v1.8.0: Portable local image paths for Markdown and HTML images
- v1.8.1: Refined first-launch experience and macOS icon; removed Mermaid rendering
- v1.9.0: Word export, desktop and mobile reading-page image export, a document outline, themed PDF pages, and leaner startup loading
- v2.0.0: 1000-star release: Mermaid diagrams return, recent files & session restore, editor font settings, heading anchors, multiple windows, and a save status hint
- v2.0.1: Universal macOS build for Apple silicon and Intel Macs
- v2.0.2: Resizable file panel and an outline progress view with jump feedback
- v2.0.3: Find & replace, UI language switch, large-document source-mode fallback, and differential (blockmap) updates
- Future: More themes, editor integrations, and smoother Markdown workflows


## License

[MIT](LICENSE), Free forever.

---

ColaMD is built by [Cola.app](https://cola.app) and maintained by [orange2ai](https://github.com/orange2ai). Issues, ideas and pull requests are welcome.
