# Packaging Notes

本地打包的实测记录与规矩。结论来自 2026-09-12 的一次本地验证打包（macOS 26.6、arm64、electron-builder 26.16.1）。

## 时间花在哪里

| 步骤 | 实测耗时 | 说明 |
| --- | --- | --- |
| `npm run build`（electron-vite） | 约 6 秒 | 渲染层、主进程、preload 全量打包，其中 vite 自身报告 3.9 秒 |
| `electron-builder --mac --dir` | **6 到 8 分钟** | 与代码改动量无关，几乎是固定成本 |
| 总计 | 6 到 8 分钟 | 单架构、未压缩、未签名 |

打包耗时长的原因，按日志顺序：

1. **复制 Electron 运行时**：每个架构约 231MB、几万个文件，这一步是主因
2. **清理扩展属性**：日志里的 `Cleaning extended attributes and resource forks`，逐文件处理，很慢
3. 签名与压缩：本地验证时用 `CSC_IDENTITY_AUTO_DISCOVERY=false` 跳过签名，`--dir` 不做压缩，所以这两步省掉了

作为对比，CI 上打 universal 包要下载并合并两套运行时，再加签名与公证，mac job 在 7 分钟左右属于正常水位。

## 本地验证打包的规矩

- **只打单架构 `--dir`**：本地验证用 `npx electron-builder --mac --dir --arm64`，不要打 `universal`、不要打 `dmg`，压缩与合并是最贵的部分
- **不要在软链 `node_modules` 的 worktree 里打包**：`git worktree` + 软链 `node_modules` 时，electron-builder 解析生产依赖会失败，日志里出现一串 `cannot find path for dependency dependencies=[katex@undefined, ...]`。产物可能缺失依赖，且依赖解析仍会走一遍。要在有真实 `node_modules` 的目录里打包
- **跳过签名**：本地用 `CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --dir`，避免钥匙串报错。本地包未签名未公证，只用于自己测试，不要发给用户
- **`files` 保持只装 `dist/**/*`**：渲染层与主进程已由 electron-vite 打包完整，不需要把 `node_modules` 装进 asar

## 待验证的优化

以下都还没实测，做之前先量一次，避免「想当然的优化」：

- `npmRebuild: false`：`@electron/rebuild` 每次都会跑。当前生产依赖里没有需要重建的原生模块（`.node` 文件只有 `fsevents` 与 rollup 的产物，均为构建期或 dev 依赖），确认后可以跳过
- 交叉验证一次「跳过 xattr 清理」是否可行，若可行能省掉可观时间

## 参考

- 发版流程与资产核对清单：`PRINCIPLES.md` 第 9 节
- CI 配置：`.github/workflows/release.yml`
- 打包配置：`electron-builder.yml`
