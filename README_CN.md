# ColaMD

> 一款免费、优雅的 Markdown 编辑器，支持 AI Agent 改动实时同步。

**Language / 语言: [English](README.md) · [中文](README_CN.md)** · [官网](https://colamd.com/)

Markdown 已经成为 AI 时代写作、记录、文档和协作的事实标准。但很多人的电脑上依然没有一个免费、好看、好用的 Markdown 阅读器/编辑器。

为此我开发了 ColaMD，一款开源、免费、轻量、优雅的 Markdown 编辑器。

它首先是一款简单、专注、好用的 Markdown 编辑器：所见即所得、主题切换、富文本复制、智能换行、PDF 与 HTML 导出，并支持 macOS、Windows 和 Linux。

同时，ColaMD 也是一款对 AI Agent 友好的编辑器。当 Claude Code、Codex、Cola 或其他 Agent 修改正在打开的 `.md` 文件时，ColaMD 会实时同步改动。不需要关闭文件、重新打开，也不需要手动刷新。

昨天发布 v1.7.3 后，我们收到了社区的反馈。v1.7.4 把这些反馈变成了一组更顺手的 Markdown 工作流，v1.8.0 又修复了本地图片路径在显示和保存之间的边界问题。感谢大家提交 Issue、Pull Request，以及参与测试、反馈和讨论的每一位朋友。ColaMD 还在继续成长，欢迎下载体验，也欢迎告诉我们你希望它变成什么样。

我们的目标很明确：把 ColaMD 做成最好用的免费 Markdown 编辑器，也让它成为 AI 时代 Markdown 工作流的一块可靠基础设施。

如果 ColaMD 对你有帮助，欢迎给我们一个 ⭐ Star 支持。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub release](https://img.shields.io/github/release/marswaveai/colamd.svg)](https://github.com/marswaveai/colamd/releases)

[下载](#下载) | [功能](#功能) | [开发](#开发)

---

## 功能

- **实时 Agent 同步** — Claude Code、Cursor、Copilot 或其他 AI Agent 修改文件后，内容实时出现在编辑器中。
- **Agent 活动指示器** — 标题栏小圆点显示 Agent 正在写入或已经完成。
- **真正的所见即所得** — 输入 Markdown，直接看到富文本，无需分屏预览。
- **文件列表面板** — 浏览当前目录和子目录中的 Markdown 文件；首次启动默认展示内置示例，不会在你打开自己的文件前请求「文稿」目录权限，Agent 新建或删除文件后自动更新。
- **源码模式** — 需要查看或直接修改原始 Markdown 时，一键切换源码编辑。
- **待办列表** — 直接点击复选框完成任务，也支持快捷键。
- **高亮与 LaTeX** — 使用 `==高亮文本==`，并通过 KaTeX 渲染数学公式。
- **文档搜索** — 使用 ⌘/Ctrl+F 快速查找内容。
- **智能换行** — 单个换行直接渲染为换行，符合人类和 AI 工具写 Markdown 的习惯。
- **富文本复制** — 复制后粘贴到公众号、微信、邮件等富文本编辑器，格式完整保留。
- **主题** — 4 个内置主题、可下载主题，以及自定义 CSS 导入。
- **PDF 与 HTML 导出** — 在需要交付时，将 Markdown 文档导出为 PDF 或独立 HTML 文件。
- **图片路径可移植保存** — 本地图片显示使用安全的 `file://` URL，保存时恢复为相对路径。
- **VS Code 集成** — 在 VS Code 中将当前 Markdown 文件直接打开到 ColaMD。
- **极简设计** — 没有工具栏，没有永久侧边栏，专注于内容本身。
- **跨平台** — 支持 macOS、Windows 和 Linux。

## 截图

<p align="center">
  <img src="docs/images/markdown-cheatsheet.png" alt="ColaMD Markdown 语法速查与交互式待办列表" width="49%">
  <img src="docs/images/markdown-rendering.png" alt="ColaMD Markdown 渲染、代码块、引用、表格与智能换行" width="49%">
</p>

<p align="center"><em>内置语法速查、交互式待办列表、代码块、引用、表格与智能换行。</em></p>

## 与现有 Markdown 工作流配合

ColaMD 不要求你改变现有习惯，也适合与 Obsidian、Typora、VS Code 等 Markdown 软件配合使用。它们共享同一套 `.md` 文件，你可以用不同工具完成不同任务。

## 下载

> 查看 [Releases](https://github.com/marswaveai/colamd/releases) 获取最新构建。

| 平台 | 格式 |
|------|------|
| macOS | `.dmg` |
| Windows | `.exe` |
| Linux | `.AppImage` / `.deb` |

## ColaMD 不做的事

ColaMD 有意保持简单：

- 没有全量文件树或工作区（仅提供轻量目录浏览和 Markdown 文件列表）
- 没有云同步或协作编辑
- 没有内置 AI 功能 — 它是 AI 生成内容的**查看器/编辑器**
- 没有插件系统

一件事，做到极致。

## 自定义主题

ColaMD 支持自定义 CSS 主题。从 [`themes/`](themes/) 文件夹下载主题，或自己创建后通过 **Theme > Import Theme** 导入。

导入的主题会保存到 `~/.colamd/themes/`，重启后仍然可用。

## 开发

```bash
git clone https://github.com/marswaveai/colamd.git
cd colamd
npm install
npm run dev
```

### 构建

```bash
npm run dist:mac
npm run dist:win
npm run dist:linux
```

### 技术栈

- **Electron** — 跨平台桌面
- **Milkdown** — 所见即所得 Markdown（基于 ProseMirror）
- **TypeScript** — 严格模式
- **electron-vite** — 快速构建

## 路线图

ColaMD 将随 Agent 生态一起演进：

- v1.1 — 实时文件热更新、文件关联、拖拽打开、主题系统
- v1.2 — 新图标
- v1.3 — Agent 活动指示器、Cmd+点击链接、富文本复制、智能换行、PDF 导出、主题持久化
- v1.6 — 更稳的实时同步：原子保存（rename）检测、watcher 自愈、关闭拼写检查
- v1.6.1 — 可勾选的待办列表（点击 / ⌘+Enter）、`==高亮==` 语法、Markdown 语法速查
- v1.6.2 — 暂时移除 HTML 导出
- v1.7 — 同目录文件列表：就地切换文件，Agent 新建/删除文件实时更新；搜索（⌘F）+ LaTeX（⌘⇧E），来自社区 PR #14
- v1.7.1 — 待办点击修复、居中的 SVG 对勾、标题栏文件面板开关按钮
- v1.7.2 — 可玩演示页：Help → 新功能演示（⌘⇧D），用真实目录展示每个版本的新功能
- v1.7.3 — 演示页升级为累积式 changelog：resources/demo/changelog.md 记录每个版本，打开即见（当前版本）
- v1.7.4 — 根据社区反馈完善文件面板、源码模式、HTML 导出、Windows 图片路径，并提供 VS Code 集成 MVP
- v1.8.0 — 修复本地图片路径保存为绝对 `file://` URL 的边界问题，并完成剩余社区 Issue
- v1.8.1 — 重做 macOS 图标、优化启动速度，并提供中英文 Markdown 语法文档
- 未来 — 更多主题、编辑器集成与 Markdown 工作流优化

## 开源协议

[MIT](LICENSE) — 永久免费。

---

由 [marswave.ai](https://marswave.ai) 为更简单的 Markdown 未来而造。
