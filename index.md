# ColaMD

> A free, elegant Markdown editor for humans and AI agents — with real-time sync for AI-generated changes.

**Language / 语言: [English](README.md) · [中文](README_CN.md)** · [Website](https://colamd.com/)

Markdown has become the de facto standard for writing, note-taking, documentation, and collaboration in the age of AI. Yet many computers still don't have a free, beautiful, capable Markdown reader/editor.

That's why I built ColaMD — an open-source, free, lightweight, and elegant Markdown editor.

First and foremost, it is a simple, focused, capable Markdown editor: true WYSIWYG editing, themes, rich-text copy, smart line breaks, PDF and HTML export, and support for macOS, Windows, and Linux.

At the same time, ColaMD is friendly to AI agents. When Claude Code, Codex, Cola, or another agent edits an open `.md` file, ColaMD syncs the changes in real time. No closing the file, reopening it, or manual refresh.

After yesterday's v1.7.3 release, we received feedback from the community. v1.7.4 turned that feedback into a smoother Markdown workflow, and v1.8.0 fixes the edge case where local image paths could be saved back as absolute `file://` URLs. Thank you to everyone who has submitted Issues and Pull Requests, tested ColaMD, shared feedback, or joined the discussions. ColaMD is still growing — download it, try it, and tell us what you want it to become.

Our goal is clear: make ColaMD the best free Markdown editor, and make it a reliable foundation for Markdown workflows in the age of AI.

If ColaMD is useful to you, please give the project a ⭐ Star.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub release](https://img.shields.io/github/release/marswaveai/colamd.svg)](https://github.com/marswaveai/colamd/releases)

[Download](#download) | [Features](#features) | [Development](#development)

---

## Features

- **Live Agent Sync** — Changes made by Claude Code, Cursor, Copilot, or other AI agents appear in the editor in real time.
- **Agent Activity Indicator** — A subtle titlebar dot shows when an agent is writing and when it has finished.
- **True WYSIWYG Editing** — Type Markdown and see rich text directly. No split-pane preview.
- **File List Panel** — Browse Markdown files in the current folder and its subdirectories. A fresh launch starts with bundled examples, so it never asks for Documents-folder permission before you open your own file; files created or removed by your agent appear automatically.
- **Source Mode** — Switch to the raw Markdown source whenever you need to inspect or edit it directly.
- **Task Lists** — Click checkboxes to complete tasks, or use the keyboard shortcut.
- **Highlights & LaTeX** — Write `==highlighted text==` and render mathematical formulas with KaTeX.
- **Search** — Find anything in the current document with ⌘/Ctrl+F.
- **Smart Line Breaks** — Single newlines render as line breaks, matching how people and AI tools write Markdown.
- **Rich Text Copy** — Copy content with formatting preserved into WeChat, email, and other rich-text editors.
- **Themes** — Four built-in themes, downloadable themes, and custom CSS imports.
- **PDF & HTML Export** — Turn your Markdown document into a PDF or a self-contained HTML file when you need a finished copy.
- **Portable Image Paths** — Local images use safe `file://` URLs for display and return to relative paths when saved.
- **VS Code Integration** — Open the current Markdown file in ColaMD directly from VS Code.
- **Minimal by Design** — No toolbar, no permanent sidebar, no distractions.
- **Cross-Platform** — Available for macOS, Windows, and Linux.

## Screenshots

<p align="center">
  <img src="docs/images/markdown-cheatsheet.png" alt="ColaMD Markdown cheatsheet and interactive task list" width="49%">
  <img src="docs/images/markdown-rendering.png" alt="ColaMD Markdown rendering with code blocks, quotes, tables, and smart line breaks" width="49%">
</p>

<p align="center"><em>Built-in syntax reference, interactive task lists, code blocks, quotes, tables, and smart line breaks.</em></p>

## Works with your Markdown workflow

ColaMD does not ask you to change your habits. It works well alongside Obsidian, Typora, VS Code, and other Markdown apps — all sharing the same `.md` files, with each tool doing what it does best.

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
- No AI features built in — it's a **viewer/editor** for AI-generated content
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

- **Electron** — Cross-platform desktop
- **Milkdown** — WYSIWYG Markdown (ProseMirror-based)
- **TypeScript** — Strict mode
- **electron-vite** — Fast builds

## Roadmap

ColaMD will evolve alongside the agent ecosystem:

- v1.1 — Live file reload, file associations, drag & drop, themes
- v1.2 — New icon
- v1.3 — Agent activity indicator, Cmd+click links, rich text copy, smart line breaks, PDF export, theme persistence
- v1.6 — Robust live sync: atomic-save (rename) detection, watcher self-recovery, spellcheck off
- v1.6.1 — Editable task lists (click / ⌘+Enter), ==highlight== syntax, Markdown cheatsheet
- v1.6.2 — Temporarily remove HTML export
- v1.7 — Same-directory file list: switch files in place, live updates when agents create/remove files; search (⌘F) + LaTeX (⌘⇧E) from community PR #14
- v1.7.1 — Task checkbox click fix, centered SVG checkmark, titlebar file-panel toggle button
- v1.7.2 — Playable demo page: Help → 新功能演示 (⌘⇧D), a real directory showcasing each release's features
- v1.7.3 — Demo page becomes a cumulative changelog: resources/demo/changelog.md records every release, opening straight into it (current)
- v1.7.4 — Community-feedback release: file panel improvements, source mode, HTML export, Windows image paths, and a VS Code integration MVP
- v1.8.0 — Preserve portable local image paths when saving, and close out the remaining community Issues
- v1.8.1 — Refresh the macOS icon, improve startup speed, and add Chinese / English Markdown references
- Future — More themes, editor integrations, and smoother Markdown workflows

## License

[MIT](LICENSE) — Free forever.

---

Built by [marswave.ai](https://marswave.ai) for a simpler Markdown future.
