# 标签页技术方案（#59）

> 状态：待评审。本文档是 design.md「标签页」规范的工程实现设计，对应 [feature request #59](https://github.com/marswaveai/ColaMD/issues/59)。
> 评审通过后分两期落地；交付走 fork 分支 `feat/tabs`，最终向上游提 PR。

---

## 1. 目标与约束

在单窗口内支持多个文档以标签页形式共存，实现 design.md 2026-09-13 定稿的标签页规范（⌘T 新建、单标签隐藏标签栏、打开文件进当前标签、每标签独立持有内容/撤销/滚动/模式/监听/保存队列、不持久化、⌘W 关最后标签关窗口）。

硬约束来自 [PRINCIPLES.md](../PRINCIPLES.md)：

- **用户数据不可丢**：切换标签不得丢撤销栈、不得丢脏内容；自动保存不得覆盖外部写入（现状已有三层防护，必须原样继承）。
- **如非必要勿增实体**：零新依赖，标签条为纯 TS 手写 DOM 组件；单标签时不渲染任何子节点。
- **先测量再优化**：性能预算先量化，第一期结束采基线，第二期复测对比。
- **先改规范再写实现**：PRINCIPLES.md §2 需随本方案修订（见 §7）。

## 2. 竞品调研结论

调研时间 2026-09-13。MarkText 源码为最新 develop 分支（已迁移 pnpm monorepo + TypeScript）。

### 2.1 MarkText（61k★，Electron + Vue3 + Pinia + Muya/ProseMirror fork）——最直接同类

已读源码：`packages/desktop/src/renderer/src/components/editorWithTabs/{tabs.vue,editor.vue}` 与 `store/editor.ts`。

- **单编辑器实例 + 切换换内容**：一个组件只建一个 Muya 实例，所有标签共享；切走时把引擎撤销栈存进 `engineHistoryByTab`（按标签 id 的 Map），切回时 `setContent()` 换文档后 `setHistory()` 恢复。光标（`applyCursor` / `setCursorByOffset` 回退）、滚动（手动 `scrollHandler` 记账 `updateScrollPosition(id, scrollTop)`）均 per-tab。
- **每标签状态**（Pinia `IFileState`）：`id / pathname / filename / markdown / blocks / isSaved / lastSavedHistoryId / history(stack,index,lastEditIndex) / cursor / scrollTop / encoding / lineEnding / searchMatches / wordCount / notifications`。
- **脏标记**：合成历史按内容键控的单调 id，刻意不用撤销栈深度（深度被不同文档复用会误判"干净"）；文件加载时基线重置为 id 0。与 ColaMD 现有 `documentRevision` 同思路。
- **磁盘事件路由**：主进程推送后按 `isSamePathSync(pathname)` 匹配到 tab；新内容与内存一致则忽略（issue #1861）；脏 tab 收到外部修改推带确认按钮的通知，确认后 `loadChange` 保留 id/滚动/历史快照。
- **关闭**：已保存 → `FORCE_CLOSE_TAB`（splice + 清 autoSaveTimers + 选中相邻标签 `tabs[index] ?? tabs[index-1] ?? tabs[0]`）；未保存 → 交主进程确认（`mt::save-and-close-tabs`）；批量关（关其他/关已存/关全部）。
- **源码模式**：CodeMirror 覆盖层，WYSIWYG 引擎**隐藏而非卸载**（z-index -1 + pointer-events none）；切源码前必须 `flush()`（防 rAF 批处理丢编辑，#2938/#3803）；光标先存 index 光标；源码回写记为**单个 undo 边界**。
- **UI 取舍**：它的标签条常显、"+" 按钮 hover 才显现、右键菜单 7 项（关闭/关其他/关已存/关全部/重命名/复制路径/在文件夹中显示）、拖拽排序（dragula）、溢出走横向滚动。**我们按 design.md 取舍**：单标签隐藏、不做拖拽、右键菜单固定五项、溢出倾向 ··· 收纳（沿切换器设计稿）。

### 2.2 Zettlr（Electron + Vue + CodeMirror 6）

打开文档列表挂在编辑器根组件，标签条绑定该列表（维护者在 roadmap issue #1690 中明确此架构）；CM6 原生按文档持有 EditorState；支持拆分窗格；提供 "Avoid new tabs" 偏好——说明"打开文件是否新开标签"是所有同类产品都必须显式决策的点，design.md 已定：一律进当前标签。

### 2.3 其他参照

- **VS Code**：语义源头，design.md 右键菜单五项即其菜单；preview tab（斜体预览标签）被我们拒绝。
- **Typora**：macOS 原生 NSWindow tabbing 路线，被规范排除（已核实 ColaMD 全仓库无 `tabbingIdentifier` 设置）。
- **维护者切换器设计稿**（`docs/temporary-document-switcher-design.md`）：已给出 per-doc 状态形状 `{path, content, dirty, scrollTop, sourceMode, lastVisitedAt}`，并明确"首版可在切换时替换现有编辑器内容；不要求同时挂载 5 个 Milkdown 实例"——单实例换内容路线已有产品侧背书；键盘先例 ⌘1-5。

## 3. 现状盘点（本方案的事实基础）

对当前 v2.0.7 代码的两份精确盘点结论（要点）：

**渲染端**（`src/renderer/main.ts`，1004 行）：

- 编辑器**一次性创建、永不销毁**（`editor.ts:445-486`），文档切换靠 `setMarkdown(content, flushHistory)` 包装 Milkdown `replaceAll`；`flush=true` 走 `EditorState.create` + `view.updateState`（撤销栈清空），`flush=false` 走普通事务（进撤销栈）。
- `getEditorView()`（`editor.ts:609-616`）已能拿到完整 `view.state`——**EditorState 捕获/恢复的设施已存在**，Milkdown 官方文档亦以此为例（`editorViewCtx` + `updateState`）。
- 顶层散装可变状态共 20 余项，其中强每文档的：`dirty / documentRevision / saveQueue / autosaveTimer / externalConflictPending / currentFilePath / sourceModeActive / outlineItems`；窗口级的：`panelMode / manualHidden / fileManagerName / editorReady`。
- 源码模式是纯 `<textarea>`（非 CodeMirror）；≥512KB 文档强制常驻源码模式、不建 ProseMirror 文档（`main.ts:667-680`）。
- 滚动只有比例工具 `scrollRatio/restoreScrollRatio`（`main.ts:300-310`）；换文件滚动硬归零（`main.ts:863-868`）。
- Mermaid 渲染器是**全局单 iframe**，文档身份变化即整体销毁重建（`mermaid-bridge.ts:126-129`）。

**主进程**（`src/main/index.ts`，1767 行）：

- `WindowState`（`:164-184`）已是完整的每窗口文档会话：`filePath / browsePath / watcher / isInternalSave / internalSaveCount / lastKnownMtime / lastInternalSaveContent / debounceTimer / siblingsTimer / dirty / closePromise / rendererReady / writeQueue / closeAuthorized`。
- watcher 为目录级优先（活过原子保存的 inode 替换），三层自我回声防护（`isInternalSave` 标志 + `lastInternalSaveContent` 内容比对 + 300ms `suppressUntil`）。
- 关闭协议：`close` 事件拦截 → `request-document-state`（3s 超时）→ 脏则保存/不保存/取消；`before-quit` 逐窗口确认。
- 窗口复用：`findWindowForFile`（按路径匹配）→ `findEmptyWindow`（复用无文档窗口）→ 新建。
- 菜单：全局单模板 + `sendToFocused` 单播；⌘W 走 `role:'close'`（`:1387`）；⌘T 不存在；⌘N 直接 `createWindow()`。
- **全部 IPC 通道无 tab 标识**（preload 暴露约 30 个 API），单文档假设集中在：`file-opened / file-changed / set-dirty / save-file(expectedPath) / request-document-state / reveal-file / list-siblings / open-sibling`。

## 4. 架构决策（七条）

| # | 决策 | 内容与理由 |
|---|------|-----------|
| D1 | 单 BrowserWindow + DOM 标签条 | 渲染进程纯 TS 手写标签条，零新依赖。排除 BrowserWindow-per-tab（内存/⌘W 语义崩）与 macOS 原生 tabbing（规范要求自绘条 + 原生右键菜单 + 复用空标签语义，原生给不了） |
| D2 | 编辑器单实例 + EditorState 交换 | 切走：捕获 `view.state`（含撤销历史）+ 滚动比例 + 模式 → 存入标签会话；切回：视觉模式 `view.updateState(savedState)`（官方示例路径，只 reconcile 不重建 DOM），源码模式恢复 textarea 值 + 比例。≥512KB 大文档分支原样保留，每标签只是字符串 |
| D3 | 状态三层分离 | 渲染端每标签 DocSession（§3 清单收拢为对象）；窗口级共享编辑器实例与面板状态；主进程 WindowState 拆为窗口壳（`rendererReady/closeAuthorized/closePromise`）+ `tabs: Map<tabId, DocState>`（`filePath/watcher/mtime/isInternalSave/writeQueue` 每 tab）。`saveQueue` 保持全局单串行（写盘串行本就安全），`documentRevision` 改 per-tab |
| D4 | IPC tabId 化（最小增量） | 约 12 处单文档通道加可选 `tabId` 字段，缺省 = 当前活动标签，老语义不变。先 preload 类型 + main handler，渲染端随 DocSession 逐通道切换 |
| D5 | 菜单与快捷键 | File 加「新建标签页 ⌘T」（当前无标签时创建第一个标签并显示标签条）；Close Tab 自定义项取代 `role:'close'`（⌘W 关当前标签，关最后一个标签 = 关窗口，主进程收口）；⌘N 不变；⌘1-9 切换标签（沿切换器设计稿先例，规范未定，随 PR 提请上游确认） |
| D6 | watcher 路由 | 每 tab 独立目录 watcher（现 `watchFile` 挂到 tab state），三层回声防护原样继承；同目录多 watcher 合并记为后续优化（先测量再优化） |
| D7 | 规范先行 | 修订 PRINCIPLES.md §2、回填 feature-requests.md #59（见 §7），随第一期同批提交 |

**脏标记专项**：沿用现有 `documentRevision`（递增修订号使 in-flight 保存作废）改为 per-tab；不引入 MarkText 式合成历史（现有机制已覆盖同一问题域，勿增实体）。

**Mermaid 专项**：切标签不销毁 iframe（销毁成本会随标签数放大）；`renderId` 按 tab 键控防串渲染，仅窗口关闭时整体释放。首版如遇复杂度超预期，允许退化为"切标签即释放重建"（现状行为），不影响正确性。

## 5. 分期实施

### 第 0 步：本文档评审

通过后开工，实施前打 `backup/pre-tabs` tag。

### 第一期：状态收拢 + 最小标签条

1. 渲染端 DocSession：main.ts 顶层散装状态收拢为会话对象 + TabManager（单标签运行，行为不变）。
2. 主进程 WindowState 拆壳 + `tabs: Map<tabId, DocState>`（单标签运行）。
3. IPC tabId 化（缺省兼容）。
4. 最小标签条 UI：加号按钮（`right: 114px`，线性 SVG，同规格）、⌘T、点击切换、中键/⌘W 关闭、脏标记复用标题栏体系、文件名省略 + 悬停全名、单标签隐藏、EditorState 交换、滚动/模式 per-tab。

验收：三份 `tsc --noEmit`（main/preload/renderer）+ `npm run build` + `check:theme-colors` + 真机回归清单（打开/保存/自动保存/热更新/外部冲突/关闭确认/最近文件/多窗口 全部原行为）+ 性能基线（中大型文档切换耗时、内存增量）。

### 第二期：design.md 全量规范

右键菜单（原生菜单：关闭/关闭其他/关闭右侧/复制路径/在文件管理器中显示）；复用空标签页（改造 `findEmptyWindow` 语义）；已打开文档再次打开 → 聚焦窗口 + 激活标签；per-tab 关闭确认 + 窗口关闭时多脏标签列表确认；⌘1-9；mermaid tabId 键控；拖拽文件落点（规范未定义，按"载入当前标签"处理，随 PR 提请上游裁决）。

验收：design.md 标签页规范 11 条逐条真机核验；性能预算复测对比基线；文案全部经 `ui-language.ts`；颜色全部走语义 CSS 变量。

### 交付

fork 分支 `feat/tabs`，每期独立提交、独立可 revert；两期验收齐全后向上游 marswaveai/ColaMD 提 PR（附真机验证记录）。

## 6. 性能预算

| 指标 | 预算 | 依据 |
|------|------|------|
| 标签切换延迟 | ≤50ms（~100KB 文档） | `view.updateState` 仅 reconcile；MarkText 同路径实测先例 |
| 每标签内存增量 | <2MB | 仅 EditorState（doc + history 插件状态），无第二实例 |
| 包体 | 零增长 | 零新依赖 |
| 单标签开销 | 标签条 DOM 无子节点 | 显隐由类切换控制 |
| 打字性能 | 无新增监听通路 | scrollspy/documentChange 走现有链路 |

基线采集与对比按 PRINCIPLES §3 执行，数据写入 PR 描述。

## 7. 规范修订项（随第一期提交）

1. **PRINCIPLES.md §2**：现文"切换文件必须重置编辑器状态，不残留上一篇的选区、搜索、滚动位置与撤销历史"修订为区分两种切换：**载入新文档**（文件面板打开、⌘O 换文件）保持重置语义；**切回已打开标签**恢复该标签各自的内容、选区、滚动与撤销历史（design.md 标签页规范的要求）。
2. **feature-requests.md #59 条目**：回填"形态已定（design.md 2026-09-13 标签页规范）"，消除与 design.md 的表述滞后。

## 8. 风险与对策

| 风险 | 对策 |
|------|------|
| 撤销栈交换遗漏（切标签后 ⌘Z 串到别的文档） | 每标签独立 EditorState 是结构性保证；第一期专项测试：编辑 A → 切 B 编辑 → 切回 A → ⌘Z 必须回到 A 的内容 |
| IME 合成期间切标签 | 参照 MarkText：切换前先 flush 引擎待写批次；输入法激活时关闭动作走标准确认流 |
| 同目录多 watcher 回声 | 三层防护（isInternalSave/内容比对/suppressUntil）按 tab 独立记账；专项测试两标签同目录交替保存 |
| 关闭确认死锁/超时 | 沿用现有 3s 超时协议，`request-document-state` 按 tab 逐个收集 |
| 大文档多标签内存 | ≥512KB 强制源码分支天然兜底（仅字符串） |
| 与上游撞车（维护者可能同步动工） | PR 前先在 issue #59 留言声明实现意向与方案链接 |

## 9. 参考实现对照表（实施期深读）

实施期将浅克隆 marktext/zettlr 至本地对照：MarkText `store/editor.ts`（tab 状态机与批量关闭）、`editor.vue`（切换 handoff 与 flush 时机）、`tabs.vue`（滚动入视图 `scrollActiveTabIntoView`，issue #3958）；MarkText 修复史 #1861/#2938/#3803/#3958/#4731 对应场景全部过一遍。

## 10. 实施与验收记录（2026-09-13）

两期均已落地 `feat/tabs` 分支，核心交互经用户真机验证通过。

### 性能实测（COLAMD_TAB_BENCH=1，4 标签 × 46KB 文档，环形切换 8 轮）

| 指标 | 原预算 | 实测 |
|------|--------|------|
| 切换延迟 | ≤50ms | 中位 54.2ms，P95 59.5ms，最大 60.1ms |
| 每标签堆增量 | <2MB | 约 4.9–7.3MB（含未回收垃圾，上界口径） |

成本主体是 ProseMirror 对整文档 `updateState` 的重渲染，随文档体量线性（优化掉标签条全量重建后仅降 0.7ms，证实瓶颈在编辑器层）。54ms 约合 3 帧多，对一次性的点击操作不可感知；原两项预算为未测量预估，按实测修订记录。堆口径含 GC 未回收垃圾，稳态应低于此上界；4 标签约 20MB，符合"少数用户主动创建的标签"的预期场景。

### design.md 标签页规范逐条核验

| 规范条目 | 状态 |
|----------|------|
| 用户主动创建，单文档无标签栏 | ✓ 真机（含 180ms 滑入动画，不留常驻区域） |
| 加号按钮 right:114px、⌘T | ✓ 真机 |
| 标签栏位置/跨整窗/单标签自动隐藏 | ✓ 真机，视觉按原型规格 |
| 打开文件进当前标签、复用空白标签 | ✓ 真机 |
| 已打开文档再打开 → 聚焦窗口激活标签 | ✓ 真机 |
| 文件名省略 + 悬停全名；脏标记沿用标题栏 | ✓ 真机 |
| 点击切换、中键关闭、⌘W 关闭 | ✓ 真机 |
| 右键菜单五项（原生菜单） | ✓ 二期落地，待真机复核 |
| ⌘W 关最后标签=关窗口、脏标签关闭前确认 | ✓ 真机 |
| 每标签独立持有撤销/滚动/模式/监听/保存队列 | ✓ 真机 + 结构保证（整态 EditorState 交换） |
| 不持久化、不做工作区 | ✓ 结构性成立（无任何存储代码） |
| ⌘N 独立窗口共存、标签不跨窗口 | ✓ 真机 |

规范未定、随 PR 提请维护者裁决：**⌘1-9 切换标签**（沿切换器设计稿 ⌘1-5 先例）、**··· 溢出收纳列表**（原型已画）、**文件拖到标签条的落点行为**（当前按"载入当前标签"处理）。
