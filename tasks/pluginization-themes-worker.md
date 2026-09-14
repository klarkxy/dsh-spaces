# 裸 Web 主题验收（叶子交接）

日期：2026-09-12。分支：`codex/spaces-pluginization`。本叶未跑 Host/浏览器/最终 `plugin add`。

后续状态：这是 Grok 首次交接的历史记录。Codex 已实际安装、运行浏览器并补充第四个候选竹青主题；脚本也已按运行证据修正。下文“未跑”和原候选风险只描述本叶交接时状态，最终结果见 [裸 Web 多主题验收](pluginization-themes-acceptance.md)。

## 结论

找到 **3** 个视觉/布局明显不同、npm 可钉版本、带官方 `dsh.bundle.patch` 的主题包，兼容审查针对 CLI `0.1.5-rc.1`。已写完整串行裸 Web 脚本。脚本 PASS **不是**用户视觉验收。

| id | 包 | 激活 | 预期观感 |
| --- | --- | --- | --- |
| catppuccin | `dsh-catppuccin@0.2.3` | 官方 Settings → Mocha 卡片 | 暗色粉彩 token，`--dsw-alias-bg-base #1e1e2e`，无壁纸 |
| eternalnight | `@eternalnight/dsh-theme@0.5.1` | bundle 默认 `mode:image` + `default.png`，无需手写配置 | 官方资源路径壁纸层 `.dt-bg`，chrome 仍在 |
| xp | `dsh-client-ui-theme-xp@0.1.1` | `immediately` 桌面化 | `#dsh-xp-taskbar` / `[data-xp-desktop]`，布局级 |

## 产物

- `D:\0 code\dsh-spaces\scripts\verify-spaces-themes.mjs`
- `D:\0 code\dsh-spaces\scripts\verify-spaces-distribution.mjs`（仅 helper `export` + `import.meta.main` 护栏；原 main 逻辑未改）
- `D:\0 code\dsh-spaces\tasks\pluginization-themes-worker.md`
- `D:\0 code\dsh-spaces\.sandbox\spaces-themes-discovery\`（candidates.json、catalog-notes.md、packs/*.tgz、extracted/、pack-sha256.json）

## 主 Agent 运行

工作区应干净。不要改根 package 清单。建议：

```
node scripts/verify-spaces-themes.mjs
```

默认：

- CLI：`C:/Users/admin/AppData/Local/Temp/spaces-runtime-install-fIEaas/versions/0.1.5-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js`
- Spaces：`.sandbox/pluginization-delivery/dsh-spaces-plugin-0.2.0.tgz`（复制到无空格 staging 再 `dsh plugin add`）
- Playwright：与 plugin 验收相同的 module 路径
- Home：`.sandbox/spaces-themes-acceptance/home`（独立；`HOME`/`USERPROFILE` 也指这里，避免 Catppuccin 触碰真实 `~/.dsh-tui`）
- 截图：`.sandbox/spaces-themes-acceptance/{catppuccin,eternalnight,xp}/{chat,spaces}.png`

覆盖：`DSH_TEST_BIN`、`DSH_TEST_PLUGIN_TGZ`、`DSH_TEST_PLAYWRIGHT_MODULE`、`DSH_TEST_PNPM_CJS`。

每个 profile 只装自己的主题 + Spaces；`web` 基线不装主题；`notes` 作 Spaces 列表对照。结束后停 Host、确认端口关，保留 Home 与截图。

## 未跑 / 风险

- 本叶未执行安装、启动、Playwright。
- XP 可能把会话放进 iframe 窗口；若官方「空间」进不去，脚本应 FAIL，不要改 CSS 补救。
- Catppuccin 打开设置时会请求 npm registry 做更新检查（非模型）。
- `dsh-theme-plugin@0.3.3` 因 `prepare` 依赖 tsdown/esbuild 未入选。
- 未改生产代码；若正式 `plugin add` 暴露 Host 缺陷，把失败栈交回主 Agent 再决定是否修。
