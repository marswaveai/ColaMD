# Packaging Notes

本地打包的实测记录与规矩。结论来自 2026-09-12 的一次本地验证打包（macOS 26.6、arm64、electron-builder 26.16.1）。

## 时间花在哪里

单架构 `--dir` 实测（arm64 主机、Electron 运行时已在本地缓存，`release/` 干净、无并发打包）：

| 步骤 | 实测耗时 | 说明 |
| --- | --- | --- |
| `npm run build`（electron-vite） | 4 到 6 秒 | 渲染层、主进程、preload 全量打包 |
| `electron-builder --mac --dir --arm64` | **约 12 秒** | 连续两次：11.0 秒、12.8 秒 |

**更正**：这个文件最初记录「打包 6 到 8 分钟为常态」，那个数字不可信。测出 6 到 8 分钟的那几次，同时有别的打包进程在写同一个 `release/` 目录，其中一个还是被中途杀掉、留下半成品 bundle，之后的打包要在那个目录上重做一遍拷贝与属性清理。干净状态下是十几秒级。要复核耗时，请在无并发打包、`release/` 干净的前提下测，并且用 `time` 记录实际值，不要凭印象。

CI 上的 mac job（universal 加签名、公证、dmg 压缩）实测 7 分 20 秒（v2.0.5），那部分成本主要在等 Apple 公证和压缩，和本地不同。

## 本地验证打包的规矩

- **只打单架构 `--dir`**：本地验证用 `npx electron-builder --mac --dir --arm64`。`universal` 要合并两套运行时，`dmg` 要压缩，这两件事只在发版时做，本地验证用不上
- **不要在软链 `node_modules` 的 worktree 里打包**：`git worktree` + 软链 `node_modules` 时，electron-builder 解析生产依赖会失败，日志里出现一串 `cannot find path for dependency dependencies=[katex@undefined, ...]`。产物可能缺失依赖，且依赖解析仍会走一遍。要在有真实 `node_modules` 的目录里打包
- **跳过签名**：本地用 `CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --dir`，避免钥匙串报错。本地包未签名未公证，只用于自己测试，不要发给用户
- **`files` 保持只装 `dist/**/*`**：渲染层与主进程已由 electron-vite 打包完整，不需要把 `node_modules` 装进 asar

## 不必要做的优化

这里曾经列了两条优化（`npmRebuild: false`、跳过扩展属性清理），前提是「打包要 6 到 8 分钟」。重新测量后本地打包是**十几秒级**，这个前提不成立，所以不做。先测量再优化，不要凭印象预防性地折腾构建配置。

## 参考

- 发版流程与资产核对清单：`PRINCIPLES.md` 第 9 节
- CI 配置：`.github/workflows/release.yml`
- 打包配置：`electron-builder.yml`
