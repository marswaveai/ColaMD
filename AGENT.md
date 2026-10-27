# ColaMD

## 产品定位

**Markdown as Database 的原生编辑器与模板渲染平台。**

### 解决的核心问题

HTML 难改——结构、样式、内容全混在一起，人改麻烦，Agent 改也要理解整个文件。

解法：把内容从 HTML 里剥离出来，放进 markdown。HTML 变成纯模板，markdown 变成数据库。改内容只改 markdown，完全不碰 HTML。

### 战略方向

- **内容层**：`.md` 文件，字段固定，人和 Agent 都能轻松编辑
- **模板层**：各种 HTML 模板（PPT、游戏化界面、博客、简历、产品落地页……）
- **ColaMD**：连接两者的工具，也是这个生态的入口

一份 markdown，多种渲染形态。未来第三方可以基于同一份 markdown 做自己的模板。

### 核心理念：Markdown as Database

Markdown 不只是文档，而是**结构化内容的数据源**。

- **Markdown = 数据**：用固定字段（frontmatter + 约定的 section 结构）承载内容，Agent 只需按字段改内容
- **HTML 模板 = 视图**：模板负责样式、动效、交互，不关心内容
- **解耦**：换模板就是换皮，换内容不影响模板
- **简单约定优先**：宁可让 markdown 字段固定一些，也不要让模板去猜语义

## 设计哲学

### 如非必要，勿增实体

这是 ColaMD 的第一原则。每增加一个 UI 元素、一个功能、一行代码，都要问：这是绝对必要的吗？默认答案是否。

- 不要工具栏（用户会用快捷键和 Markdown 语法）
- 不要常驻侧边栏（打开文件时显示所在目录；无文件时默认显示文稿目录，可 ⌘\ 隐藏）
- 不要状态栏
- 界面只有：标题栏（拖拽用）+ 编辑器 + 文件列表面板
- 追求极致的简单，一个功能做到极致

### 核心功能优先级

1. **文件热更新**（核心卖点）— 外部 Agent 修改 .md 时自动刷新，实时看到 Agent 的工作
2. **所见即所得** — 输入 Markdown 即刻渲染为富文本
3. **文件列表面板** — 打开文件时显示所在目录的 Markdown 文件；无文件时默认显示文稿目录；支持轻量目录浏览、点击切换，Agent 新建/删除文件实时刷新
4. **主题系统** — CSS 主题，可导入自定义主题
5. **导出** — PDF、HTML

### UI 视觉与交互规范

- **图标统一使用线性 SVG**：功能图标不使用 Unicode 字符、Emoji 或系统字体图标代替。
- **线条统一**：默认 `stroke-width: 1.3`，使用 `stroke-linecap="round"` 和 `stroke-linejoin="round"`；同一组图标的尺寸、视口和视觉重量保持一致。
- **同类控件统一**：文件、文件夹、返回上级等图标应使用同一套线性图标语言，不允许单独引入粗细或风格不同的符号。
- **图标必须可理解**：每个图标按钮都要有 hover 文字说明，同时设置 `title` 和 `aria-label`；说明文字使用简洁、自然的中文。
- **优先复用样式**：图标尺寸、间距、颜色和 hover 状态统一放在共享 CSS 中，避免在业务代码里写零散样式。
- **克制可见元素**：遵循“如非必要，勿增实体”，只在确有功能价值时增加图标、按钮或提示。

### 发布约定

- 更新是攒着发的，不每天发版：修好一段时间内的反馈后集中出一版。因此**写 changelog 前先看这一版攒了什么**：`git log <上一个 tag>..main --oneline`，别只看手上最后那几笔
- 每个大版本更新后：在 `resources/demo/changelog.md` **追加**本版更新内容，并更新对应的演示文件（Help 菜单 → 新功能演示，⌘⇧D）
- 演示目录是**可玩的 changelog**：changelog.md 记录更新历史，同目录的演示文件让用户上手玩，而不是只读文字
- 演示页已接入菜单，打包时随 extraResources 发布
- **文案不使用破折号**（`—`）：列表项用冒号分隔（`- **功能**: 说明`），正文改用逗号、冒号或括号
- 官网在 `gh-pages` 分支，`index.html` 是唯一入口（手写双语，`data-en` / `data-zh` 属性 + 语言切换脚本）
- 官网首页的功能卡片**固定 9 张**，主题区排在功能卡片之前；完整功能列表只写在 README 里
- 产品定位讲用户价值（免费、优雅、简单、文件永远是最新的），不以「AI Agent 原生」自我定义；Agent 只作为同步功能的一个举例

### 两种查看方式

- **渲染**（默认）：一篇干净的排版，**普通行内标记不露源码**，但照旧能编辑。行内公式是例外：光标或完整选区进入公式节点内部时临时显示源码，离开后重新渲染。
  曾经有过「光标所在的那一行露源码」的编辑模式。2026-10-06 取消：屏幕上不该为「偶尔改个标记」留一半噪音，要改标记就去源码模式。
- **源码**（`⌘/`，顶栏那个 `<>` 按钮）：整篇都是源码。改标记、修表格这类事情在这里做。
- 渲染模式下每个渲染块仍然可以点进去把光标放进它的源码（表格、公式、HTML 等），打字会照常反映到渲染上。

### 不做的事情

- 不做持久化工作区和全量文件树（只提供当前目录与默认文稿目录的轻量浏览）
- 不做知识库管理
- 不做云同步、协作编辑
- 不做笔记组织和标签系统
- 不加不必要的 UI 元素（工具栏、状态栏等）

## 技术栈

- Electron（桌面跨平台）
- CodeMirror 6（文本优先的编辑器内核：文件里存的是字节，渲染只是叠在字节上的一层装饰。纪律与坑见 [docs/editor-architecture.md](docs/editor-architecture.md)）
- TypeScript 严格模式
- electron-vite（构建）
- electron-builder（打包）

## 项目结构

```
src/
├── main/           # Electron 主进程
│   └── index.ts    # 窗口管理、文件 I/O、菜单、文件监听
├── preload/        # 安全 IPC 桥接
│   └── index.ts
└── renderer/       # 渲染进程
    ├── index.html
    ├── main.ts     # 入口，连接编辑器和 IPC
    ├── editor/     # CodeMirror 6 编辑器核心（文本优先）
    ├── themes/     # CSS 主题 + 主题管理器
    └── env.d.ts
```

## 开发规范

- TypeScript 严格模式
- 编辑器核心与 UI 解耦
- 主题 CSS 与编辑器逻辑完全分离
- 代码简洁，不过度设计
- 每个新功能先问：这是必要的吗？
- UI、图标、间距和交互规范详见 [design.md](design.md)，所有参与者提交界面改动前都应检查贡献清单。
- 产品与工程的判断标准汇总在 [PRINCIPLES.md](PRINCIPLES.md)：稳定性优先、用户数据不可丢、先测量再优化、决策留痕等。
- 本地打包验证的实测数据与规矩见 [docs/packaging.md](docs/packaging.md)：本地只打单架构 `--dir`，不在软链 `node_modules` 的 worktree 里打包。
- 验收脚本凡是会开 Electron 的，一律用 `scripts/offscreen-window.cjs` 启动，不要直接 `electron .`。窗口必须在用户的屏幕上看不见、也不许抢焦点：用户是在自己机器上干活的。`--window-position` 对 Electron 不生效（实测被忽略），别再用它冒充“离屏”。
- 跑验收脚本前先 `npm run build`。忘了构建会拿旧产物去验，红的是假的；脚本里有 `assertBuildFresh()` 会拦住这种情况。
- 这一版攒下的验收脚本，改动碰到哪儿就跑哪条（拿不准就都跑）：
  - `npm run verify:markdown`：打开再保存，字节不许变（`save(open(x)) === x`）
  - `npm run verify:features`：界面功能逐条断言，正文里能看见的东西最多的一条网
  - `npm run verify:scroll-render`：滚到没解析过的地方，那几行也必须渲染过
  - `npm run verify:source-mode`：渲染与源码双向切换，检查选区方向、光标可见性和视口位置
  - `npm run verify:themes`：主题 CSS 的每条规则都要命中真实元素并改变计算样式
  - `npm run check:theme-colors`：12 套内置主题与独立主题文件的变量契约
  - `npm run verify:links`、`npm run verify:image-export`、`npm run verify:export-pdf`：链接跳转与两种导出的真机验证
  - 四份类型检查：`npx tsc -p tsconfig.main.json --noEmit`，`preload` / `renderer` / `web` 同理
- 已知缺口（2026-10-06）：块级渲染块（表格 / 图片 / 公式）的「点一下把光标放进源码」只断言了「排版不被翻成源码」，没断言光标真的落进那块源码里。要补就得读文档源码找落点（比如表格那行结尾必须变成 `|Z`），不能只断言「文档变了」。mermaid 没进这一批：它在 `verify:features` 的夹具里走到这一步就查不到了（等 15 秒也不回来），单独开窗实测导出前后都正常，是测试自身的问题，未查明。同一批还欠：`verify:image-export` 的 long/mobile 两档、`verify:export-pdf` 从未跑通。
