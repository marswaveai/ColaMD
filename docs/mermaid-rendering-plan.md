# Mermaid 图表渲染重做方案

## Context

v1.7.4 引入的 Mermaid 渲染因 CPU 飙升、卡顿和内存问题在 v1.8.1 被移除。根因调研结论（已与用户确认）：

1. 静态 `import mermaid`（~1MB）打进主 bundle，拖慢所有用户启动
2. NodeView `update()` 每次按键触发一次全量 `mermaid.render()`，无 debounce → CPU 风暴
3. 渲染在编辑器主线程同步执行 → 大图冻结输入
4. Mermaid 已知泄漏（gantt OOM 等）被每键渲染放大

用户确认的方案：**懒加载 + debounce + 隐藏 iframe 隔离渲染**；不做图规模限制；核心约束是**不用 Mermaid 的用户零影响**（启动、内存、主 bundle 体积均不变）。

## 架构

三个独立部分：

```
mermaid-view.ts (NodeView)  ──debounce 400ms──▶  mermaid-bridge.ts (iframe 管理器)
                                                        │ postMessage
                                                        ▼
                                          mermaid-sandbox.html + sandbox 入口
                                          (独立构建入口，静态 import mermaid，
                                           主应用永不加载这个 chunk)
```

**零影响保证**：mermaid 只被 sandbox 入口引用，构建为独立 chunk；主应用只含 ~100 行 bridge 代码。iframe 和 mermaid chunk 仅在文档首次出现 mermaid 代码块时才加载。

## 文件变更

### 新建 `src/renderer/mermaid-sandbox.html` + `src/renderer/sandbox/mermaid-sandbox.ts`

- 极小 HTML 页面，`<script type="module" src="../sandbox/mermaid-sandbox.ts">`（vite 相对路径）
- 入口脚本：静态 `import mermaid from 'mermaid'`（独立入口 → mermaid 只进这个 chunk 图）
- 监听 `message`：收到 `{ type:'render', id, code, theme }` → `mermaid.initialize({ startOnLoad:false, securityLevel:'strict', theme })` → `mermaid.render(id, code)` → 回帖 `{ type:'result', id, ok, svg?, error? }`
- 初始化完成后向 parent 发 `{ type:'ready' }`
- 不加 `sandbox` 属性（本地自有页面，避免 opaque origin 下 localStorage 报错一类问题；安全由 `securityLevel:'strict'` 保证，与旧版一致）

### 新建 `src/renderer/editor/mermaid-bridge.ts`（~120 行）

- 单例管理隐藏 iframe：`position:fixed; left:-9999px; width:1024px; height:768px; visibility:hidden`（**不能 display:none**，否则文本测量失效、SVG 尺寸为 0）
- `renderMermaid(code): Promise<string>`：懒创建 iframe（`src` 用相对路径 `./mermaid-sandbox.html`，dev 与打包后均在 dist/renderer 下，天然兼容）、请求排队直到 ready、自增 id 映射 resolver
- **15s 超时**：超时 reject 并销毁重建 iframe（防 gantt OOM 挂死污染后续渲染——这是崩溃保护，不是规模限制）
- 暗色主题检测：body class ∈ {theme-dark, theme-solarized-dark, theme-nord, theme-gruvbox, theme-dracula, theme-midnight} → `theme:'dark'`，否则 `'default'`（渲染时读取，主题切换后下次渲染生效）

### 新建 `src/renderer/editor/mermaid-view.ts`（~130 行）

基于旧版（`git show 8986334^:src/renderer/editor/mermaid-view.ts`）改造，保留其 render token 防竞态结构，改动：

- **删除静态 import**，改调 bridge
- **debounce 400ms**：`update()` 只重置定时器；渲染期间保留旧 SVG（首次渲染前显示源码，不用占位文案，避免布局跳动）
- **selectNode/deselectNode 编辑模式**：光标进入代码块 → 显示源码可编辑；光标离开 → debounce 后渲染并显示 SVG（修复旧版"渲染后无法编辑源码"的缺陷）
- `stopEvent: () => false`、`ignoreMutation`（仅 diagram 区属性变更）照旧
- 语法错误 → 显示源码 + 错误条（旧版行为）

### 修改 `electron.vite.config.ts`

renderer `rollupOptions.input` 增加第二个入口 `resolve(__dirname, 'src/renderer/mermaid-sandbox.html')`（Vite 标准 MPA 配置，dev 与 build 均支持）。

### 修改 `src/renderer/themes/base.css`

恢复旧版样式（`git show 8986334^:src/renderer/themes/base.css` 443-463 行）：`.mermaid-diagram`（overflow-x、居中、`var(--code-block-bg)` 背景）与 `.mermaid-error`，svg `max-width:100%`。

### 修改 `package.json`

重新加入 `"mermaid": "^11.16.1"`。

### 文档

- `docs/feature-requests.md`：Diagram rendering 条目从 Candidates 移除（已实现），可注明回归方案要点
- `README.md` / `README_CN.md`：features 列表恢复 Mermaid 行（v1.8.1 移除处）

## 验证

1. `npm run dev`，打开含 mermaid 块的文档 → 图表 ~400ms 后渲染
2. 在 mermaid 块内连续输入 → 无卡顿（debounce 生效，渲染期间可继续打字）
3. 点击图表 → 进入源码编辑；点击块外 → 重新渲染
4. 语法错误 → 显示源码 + 错误条；修正后恢复渲染
5. 打开**不含** mermaid 的文档 → devtools Sources/Network 确认 mermaid chunk 与 iframe 未加载；构建后确认 `dist/renderer` 主 chunk 不含 mermaid
6. 切换暗色主题（如 midnight）→ 下次渲染为 dark 配色
7. 大图（~200 节点）渲染期间主界面输入不冻结（iframe 隔离生效）
8. 故意构造挂死图（gantt OOM 用例）→ 15s 超时后报错，后续渲染正常
9. 切换文件、热更新（外部 agent 改文件）场景下图表正常
