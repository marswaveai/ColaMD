# ColaMD

> A free, elegant Markdown editor for humans and AI agents — with real-time sync for AI-generated changes.

**Language / 语言: [English](README.md) · [中文](README_CN.md)** · [Website](https://colamd.com/)

ColaMD is an open-source, free, lightweight Markdown editor for writing, notes, and documentation.

It offers true WYSIWYG editing, themes, rich-text copy, smart line breaks, PDF and HTML export, and support for macOS, Windows, and Linux.

When Claude Code, Codex, Cola, or another agent edits an open `.md` file, ColaMD syncs the changes in real time.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub release](https://img.shields.io/github/release/marswaveai/colamd.svg)](https://github.com/marswaveai/colamd/releases)

[Download](#download) | [Features](#features)

---

## Screenshots

<p align="center">
  <img src="docs/images/markdown-cheatsheet.png" alt="ColaMD Markdown cheatsheet and interactive task list" width="49%">
  <img src="docs/images/markdown-rendering.png" alt="ColaMD Markdown rendering with code blocks, quotes, tables, and smart line breaks" width="49%">
</p>

<p align="center"><em>Built-in syntax reference, interactive task lists, code blocks, quotes, tables, and smart line breaks.</em></p>

## Themes

Twelve built-in themes — six light, six dark — inspired by Bear, Notion, iA Writer, Kindle, Solarized, Nord, Gruvbox, and Dracula.

<p align="center">
  <img src="docs/images/theme-swatches.svg" alt="ColaMD themes" width="92%">
</p>

## Features

- **Live Agent Sync** — Changes made by Claude Code, Cursor, Copilot, or other AI agents appear in the editor in real time.
- **Agent Activity Indicator** — A subtle titlebar dot shows when an agent is writing and when it has finished.
- **True WYSIWYG Editing** — Type Markdown and see rich text directly. No split-pane preview.
- **Files & Outline** — Browse Markdown files in the selected folder, or switch to a document outline for focused heading navigation.
- **Source Mode** — Switch to the raw Markdown source whenever you need to inspect or edit it directly.
- **Task Lists** — Click checkboxes to complete tasks, or use the keyboard shortcut.
- **Highlights & LaTeX** — Write `==highlighted text==` and render mathematical formulas with KaTeX.
- **Search** — Find anything in the current document with ⌘/Ctrl+F.
- **Smart Line Breaks** — Single newlines render as line breaks, matching how people and AI tools write Markdown.
- **Rich Text Copy** — Copy content with formatting preserved into WeChat, email, and other rich-text editors.
- **Themes** — Twelve built-in themes for focused writing in light or dark environments.
- **Version Changelog** — The first launch after an update opens the built-in changelog once, so you can see what changed without repeated prompts.
- **PDF, HTML & Word Export** — Turn your Markdown document into a themed PDF, self-contained HTML, or editable Word document.
- **Reading-Page Image Export** — Share Markdown as desktop or mobile PNG pages; longer documents continue as numbered pages.
- **Portable Image Paths** — Local images use safe `file://` URLs for display and return to relative paths when saved.
- **VS Code Integration** — Open the current Markdown file in ColaMD directly from VS Code.
- **Minimal by Design** — No toolbar, no permanent sidebar, no distractions.
- **Cross-Platform** — Available for macOS, Windows, and Linux.

## Works with your Markdown workflow

ColaMD does not ask you to change your habits. It works well alongside Obsidian, Typora, VS Code, and other Markdown apps — all sharing the same `.md` files, with each tool doing what it does best.

## Download

> Check [Releases](https://github.com/marswaveai/colamd/releases) for the latest builds.

| Platform | Format |
|----------|--------|
| macOS    | `.dmg` |
| Windows  | `.exe` |
| Linux    | `.AppImage` / `.deb` |

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
- v1.7.3 — Demo page becomes a cumulative changelog: resources/demo/changelog.md records every release and opens straight into it
- v1.7.4 — Community-feedback release: file panel improvements, source mode, HTML export, Windows image paths, and a VS Code integration MVP
- v1.8.0 — Portable image paths for Markdown and HTML images, plus editing fixes from community feedback
- v1.8.1 — Refined first-launch experience and macOS icon; removed Mermaid rendering so code blocks remain native and editable
- v1.9.0 — Word export, desktop and mobile reading-page image export, a document outline, themed PDF pages, and leaner startup loading
- Future — More themes, editor integrations, and smoother Markdown workflows

## License

[MIT](LICENSE) — Free forever.

---

Built by [marswave.ai](https://marswave.ai) for a simpler Markdown future.
