# Packaging Notes

本地打包的实测记录与规矩。结论来自 2026-09-12 的一次本地验证打包（macOS 26.6、arm64、electron-builder 26.16.1）。

## 包体积

按 PR #82 的配置（2026-09-13 合入），本地实测：

| 项 | 之前 | 之后 |
| --- | --- | --- |
| app bundle（未压缩） | 408 MB | 215 MB |
| `app.asar` | 169 MB | 10.7 MB |
| 每架构 zip（自动更新要下的量） | universal 207 MB | **arm64 85.3 MB / x64 90.1 MB** |

那 169MB 的 asar 里几乎全是被复制进包的生产依赖（光 mermaid 一个就 83.5MB），而 electron-vite 早已把这些库内联进 `dist`（dist 总共 10MB），所以那份拷贝是死重。asar 瘦身后只剩 `dist` 加 `package.json`，10.7MB，对得上。

**规矩**

- 主进程、preload、渲染层都由 electron-vite 打成完整 bundle，运行时不需要 `node_modules`，因此 `files` 里显式排除 `node_modules/**/*`
- **例外**：一旦引入运行期从 `node_modules` 加载的包（原生模块 `.node` 是典型），必须把它从排除名单里放出来，否则打包后运行会崩。判断方法：检查 `dist/main/index.js` 里除了 Node 内置模块和 `electron`，还有没有 `require('包名')`
- 语言包只保留 en / zh（`electronLanguages`），其余 Chromium 语言删掉可省几十 MB
- mac 默认用 `mac.target` 的 arch 列表打两份产物（`arm64` + `x64`），**不分 universal**：universal 会把两套 Chromium 运行时塞进同一个包，每个用户多下几十 MB。两个架构的 zip 会写进同一个 `latest-mac.yml`，自动更新会按架构自己选，用户无感

## 时间花在哪里

单架构 `--dir` 实测（arm64 主机、Electron 运行时已在本地缓存，`release/` 干净、无并发打包）：

| 步骤 | 实测耗时 | 说明 |
| --- | --- | --- |
| `npm run build`（electron-vite） | 4 到 6 秒 | 渲染层、主进程、preload 全量打包 |
| `electron-builder --mac --dir --arm64` | **约 12 秒** | 连续两次：11.0 秒、12.8 秒 |

**更正**：这个文件最初记录「打包 6 到 8 分钟为常态」，那个数字不可信。测出 6 到 8 分钟的那几次，同时有别的打包进程在写同一个 `release/` 目录，其中一个还是被中途杀掉、留下半成品 bundle，之后的打包要在那个目录上重做一遍拷贝与属性清理。干净状态下是十几秒级。要复核耗时，请在无并发打包、`release/` 干净的前提下测，并且用 `time` 记录实际值，不要凭印象。

CI 上的 mac job（universal 加签名、公证、dmg 压缩）实测 7 分 20 秒（v2.0.5），那部分成本主要在等 Apple 公证和压缩，和本地不同。

## 本地验证打包的规矩

- **验证功能不必打包**：`npm run build` 之后用 `npx electron . --remote-debugging-port=9222 --user-data-dir=/tmp/cola-test <文件>` 直接跑 `dist` 产物，几秒就能起来，和打包后的应用是同一份代码。只有要验签名、公证、包体积或真实安装包时才需要 `electron-builder`
- **只打单架构 `--dir`**：本地验证用 `npx electron-builder --mac --dir --arm64`。`universal` 要合并两套运行时，`dmg` 要压缩，这两件事只在发版时做，本地验证用不上
- **不要在软链 `node_modules` 的 worktree 里打包**：`git worktree` + 软链 `node_modules` 时，electron-builder 解析生产依赖会失败，日志里出现一串 `cannot find path for dependency dependencies=[katex@undefined, ...]`。产物可能缺失依赖，且依赖解析仍会走一遍。要在有真实 `node_modules` 的目录里打包
- **跳过签名**：本地用 `CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --dir`，避免钥匙串报错。本地包未签名未公证，只用于自己测试，不要发给用户
- **`files` 保持只装 `dist/**/*`**：渲染层与主进程已由 electron-vite 打包完整，不需要把 `node_modules` 装进 asar
- **`electron` 包自 Electron 42 起不在 `postinstall` 下载二进制**（`ELECTRON_SKIP_BINARY_DOWNLOAD` 也不再支持）。本地要跑起来先 `npx install-electron`，或者直接 `npx electron .`，它会按需下载。CI 不受影响：`npm run build` 不需要二进制，`electron-builder` 打包时自己去取
- **打包前先杀掉真机测试残留的应用实例**：曾经有一个测试实例（从 `release/mac-arm64/ColaMD.app` 启动、`--user-data-dir` 指向 `/tmp`）忘了关，`electron-builder` 卡在 `packaging platform=darwin` 不动，CPU 0%、日志无报错、八分钟不结束。原因是它要覆盖一个正在被使用的 app bundle。测试结束后用 `pgrep -fl 'user-data-dir=/tmp|/Applications/ColaMD'` 确认残留；只杀 `/tmp` 测试实例，不要动用户正在用的 `/Applications/ColaMD.app`
- **同一个位置卡住过两次**：另一次没有残留实例，日志停在 `downloaded label=electron progress=100%` 之后的 `packaging`，同样 0% CPU、无报错。原因未确认（当时机器上有网络抖动，`git push` 也超时过）。处理办法是杀掉重跑，或者按上一条改用 `npx electron .` 验证

## 不必要做的优化

这里曾经列了两条优化（`npmRebuild: false`、跳过扩展属性清理），前提是「打包要 6 到 8 分钟」。重新测量后本地打包是**十几秒级**，这个前提不成立，所以不做。先测量再优化，不要凭印象预防性地折腾构建配置。

## 参考

- 发版流程与资产核对清单：`PRINCIPLES.md` 第 9 节
- CI 配置：`.github/workflows/release.yml`
- 打包配置：`electron-builder.yml`
