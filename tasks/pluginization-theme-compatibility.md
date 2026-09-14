# Catppuccin × Spaces peer 冲突（审计）

日期：2026-09-12。本叶未改 `scripts/verify-spaces-themes.mjs` / distribution、未改已有 theme profile、未启动 Host/浏览器。

后续状态：本文件保留 Grok 当时的安装试验，下面的“现场”和“当前脚本”属于试验时快照；主验收 Home 后来已经重建，不应再用其中旧锁文件行号定位。Codex 已实测 Spaces-first：Host 正常，Catppuccin 客户端仍因模块接口不兼容失败；备用竹青主题实际通过。最新结论见 [裸 Web 多主题验收](pluginization-themes-acceptance.md)。

## 结论

实测失败成立，且可复现原因：

1. `dsh plugin add dsh-catppuccin@0.2.3 --config.auto-install-peers=true` **先于** Spaces。
2. Catppuccin peers 写的是 `^0.1.0-rc.6`。针对本次比较的预发布版本，该范围允许 **0.1.0-rc.8**，**不匹配** `0.1.5-rc.2`；它并非只允许预发布版本。resolver 选中 `@deepseek-ai/dsh-client-ui-theme@0.1.0-rc.8`，其 peers 再拉 `@deepseek-ai/dsh-client-connection@^0.1.0-rc.8` 和同线的 `dsh-typert-protocol@0.1.0-rc.8`。
3. profile `pnpm-workspace.yaml` 是 `nodeLinker: hoisted` + `autoInstallPeers: false`，但 add 命令的 `--config.auto-install-peers=true` 把 lock `settings.autoInstallPeers` 改成 true。
4. 随后 Spaces（peers `^0.1.5-rc.2`）被 hoist 到已有的 **0.1.0-rc.8**。lock 里 Spaces snapshot 明确绑着 `dsh-typert-protocol@0.1.0-rc.8` / `dsh-client-connection@0.1.0-rc.8`，尽管 packages 段仍写着 `^0.1.5-rc.2`。pnpm 默认不 strict-peer，不会为 Spaces 再装一份 0.1.5-rc.2。
5. `0.1.0-rc.8` **没有** `RemoteError` export；`0.1.5-rc.2` 有。Host 加载 `@dsh-spaces/plugin` 即炸。

对照：EternalNight / XP 几乎不声明 `^0.1.0-rc.6` 的 client peers，Spaces-first 或 Spaces-second 都能落到 `typert 0.1.5-rc.2`。

**不要**额外 pin `@deepseek-ai/dsh-client-ui-theme@0.1.5-rc.2` 并假装自然兼容：该版本 **不满足** Catppuccin 的有效 peer 范围（`^0.1.0-rc.6` 不含 0.1.5 预发布）。

## 失败现场（只读）

- 日志：`.sandbox/spaces-themes-acceptance/catppuccin-dsh.log`
- profile：`.sandbox/spaces-themes-acceptance/home/profiles/theme-catppuccin/`
- lock importer 把 Spaces 绑到 `dsh-typert-protocol@0.1.0-rc.8`（`pnpm-lock.yaml` 约 L13、L1287–1295）
- `createRequire(plugin/lib/index.js)` → typert **0.1.0-rc.8**，`RemoteError` 不是 function

## 独立 Home 安装试验（未启动 Host）

目录：`.sandbox/spaces-themes-discovery/compatibility/`（`results.json`、`require-evidence.json`、各 trial log）

| 试验 | 命令顺序 | 盘上 typert | RemoteError | ui-theme |
| --- | --- | --- | --- | --- |
| Spaces → catppuccin + auto-peers | 先 tgz `--config.auto-install-peers=true`，再 `dsh-catppuccin@0.2.3 --config.auto-install-peers=true` | 0.1.5-rc.2 | 有 | 残留 0.1.0-rc.8 |
| Spaces → catppuccin 官方 | 先 tgz auto-peers，再 `dsh-catppuccin@0.2.3`（无 extra flags） | 0.1.5-rc.2 | 有 | 无（走 Host web-app） |
| Spaces → zhongguo | 先 tgz auto-peers，再 `dsh-theme-plugin@0.3.3 --ignore-scripts` | 0.1.5-rc.2 | 有 | 无；`lib/client.js` 648051 bytes |

**顺序是关键。** 先装 Spaces 后再装 Catppuccin，即使第二次仍带 auto-peers，Spaces 的 typert 也保住 0.1.5-rc.2。更干净的是第二次 **不要** auto-peers（与 workspace 默认 `autoInstallPeers: false` 和 Catppuccin README 一致）。

## 建议主 Agent 实测命令（重建 catppuccin profile，不要改第三方/放宽 Spaces 门禁）

```
dsh plugin --profile theme-catppuccin add <shell-safe-spaces-tgz> --config.auto-install-peers=true
dsh plugin --profile theme-catppuccin add dsh-catppuccin@0.2.3
```

读回应为：

- `node_modules/@deepseek-ai/dsh-typert-protocol` = `0.1.5-rc.2`
- `node_modules/@deepseek-ai/dsh-client-connection` = `0.1.5-rc.2`
- lock 里 Spaces snapshot 含 `dsh-typert-protocol@0.1.5-rc.2`
- 不要出现 `0.1.0-rc.8` 的 typert/connection

激活仍按官方：Playwright Settings → Mocha。不要手写 token。

## 备用（仅当不想再试 Catppuccin）

已下载且本叶装上：`dsh-theme-plugin@0.3.3`。`prepare` 可被 `--ignore-scripts` 跳过，包内已有 `lib/client.js`。peers 是 `*` 且 optional，不会把 0.1.0-rc.8 抬上来。

```
dsh plugin --profile theme-zhongguo add <spaces-tgz> --config.auto-install-peers=true
dsh plugin --profile theme-zhongguo add dsh-theme-plugin@0.3.3 --ignore-scripts
```

激活（README）：启动 URL 后设 hash `#theme=zhuqing-light`（浅色绢纸，和 Mocha 暗粉彩、EternalNight 壁纸、XP 桌面都不同）。

`dsh-appearance-gallery` 仍带 `^0.1.0-rc.6`，**先装 + auto-peers 会重复 Catppuccin 坑**；本叶未再扩研究。

## 未验证

- 本叶未重启裸 Web / Playwright。Spaces-first 的 Catppuccin Mocha 是否在浏览器里真正上色，要主 Agent 跑。
- 未验证「无 `--ignore-scripts` 时 zhongguo prepare 是否失败」。
- 未改验收脚本；当前脚本仍是 **先 theme 后 Spaces**。
