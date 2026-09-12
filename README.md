# DSH Spaces

**Spaces for DeepSeek Harness — switch your DSH workspaces like Discord servers.**

A desktop shell and a DSH-native Spaces control plugin, sharing the same isolation and recovery core. The desktop rail embeds the official DSH Web UI; the plugin adds a Spaces management panel inside DSH Web. Community / open source. Desktop targets Windows / macOS / Linux.

中文说明见下方 [中文](#dsh-spaces-中文)。

## Why

Official DSH profiles isolate the plugin stack, not sessions or workspace groups. Running two profiles at once can race the same JSONL files. DSH Spaces keeps **one shared identity** (API keys, `settings.yaml`) and gives every workbench its own session/storage roots under `$DSH_HOME/hub/<name>/`. Plugin discovery is in Hub settings (NanmiCoder catalog schema, MIT); installs still run `dsh plugin --profile <name> add` into the spaces you select.

`web` is the unique home profile. Spaces never writes its isolation patch. Pre-Hub chats stay there; explicitly requested plugin operations may update its plugin installation.

## vs other launchers

| | DSH Spaces | [DSH-Launcher V3](https://github.com/MarcoG-h/DSH-Launcher) |
|---|---|---|
| UI | Space rail + embedded official Web UI | Embedded official Web UI and instance management |
| Data model | Shared identity; separate workbench session/storage roots | Shared or independent DSH_HOME per instance |
| Parallelism | One process and port per space | Multiple concurrent instances |

Comparison checked against published documentation on 2026-09-08, not a performance benchmark. Spaces focuses on one person's separate working environments. Session isolation does not restrict file access or prevent two agents from editing the same source directory.

## Safety design

- **No Spaces telemetry.** Model calls and installed plugins use their own network configuration.
- **`web` isolation protection.** Spaces never applies storage-root overrides to `web` or migrates its existing chats.
- **Backups.** Any write to `cordis.patch.yml` first copies `cordis.patch.yml.bak-<timestamp>`.
- **Atomic writes.** `spaces.json` and patches use same-volume temp + rename (not `%TEMP%`).
- **Start gate.** Workbenches run `dsh --profile <name> --dump-config` first. Missing/wrong row ids refuse to start (A8).
- **Dev sandbox.** Unpackaged builds use `.sandbox/dsh-home`. Tests refuse the real `~/.dsh`.

## Runtime upgrades and recovery

Version 0.2.0 includes process lifecycle controls, tray behavior, diagnostics, and coordinated DSH upgrades with recoverable snapshots. App updates and DSH runtime upgrades are separate operations. Explicit runtime upgrades may update official base plugins in `web`, while its isolation patch remains protected. See the [acceptance record](tasks/fix-acceptance-2026-09-11.md) for tested scenarios and platform limits.

Recovery normally saves a complete backup before replacing data. If the current runtime is missing or damaged, recovery requires explicit confirmation to preserve the current data without that runtime. Such backups are marked as data-only and cannot be applied as complete runtime snapshots. Recovery must finish before spaces can start or modify data.

## Requirements

- Node 24 for contributing; the app also installs a managed Node, pnpm, and DSH CLI on first launch
- Package source is selectable: China (npmmirror) or official (npmjs / nodejs.org)
- Keep official base plugins matched to the selected CLI rather than independently following plugin dist-tags. First install uses `@deepseek-ai/dsh@0.1.5-rc.1`.

## Develop

The pluginization branch implements the Phase 0 + Phase 1 preview described in [the implementation plan](tasks/pluginization-plan.md). See [plugin installation and boundaries](packages/plugin/README.md). The desktop keeps its existing features; Web lifecycle control, plugin changes and snapshot restore are later phases.

The plugin provides Chinese and English UI and declares a native DSH bundle for activation through the official plugin manager. `npm run validate:distribution` checks installation, replacement and removal with a disposable profile; `npm run validate:plugin` checks the real browser flow. `npm run validate:desktop` accepts `DSH_TEST_PACKAGED_EXE` for an isolated packaged-app check. Fixture requirements and remaining limits are recorded in the [acceptance report](tasks/pluginization-acceptance.md).

```bash
npm install
node scripts/setup-sandbox.mjs
npm test
npm run typecheck
npm run validate:isolation
npm run dev
```

Do not run the isolation/lifecycle scripts while the app is using the same sandbox profiles.

## Build

```bash
npm run build
npx electron-builder --win   # or --mac / --linux
```

Installers land in `release/`.

## License

MIT. See `LICENSE`.

---

# DSH Spaces (中文)

**Spaces for DeepSeek Harness — 像切 Discord 服务器一样切换你的 DSH 工作空间。**

桌面壳与 DSH 原生 Spaces 管理插件，共用隔离规则和恢复核心。桌面版左侧是官方 profile 图标栏，右侧内嵌官方 Web UI；插件版在 DSH Web 内增加独立管理面板。桌面版面向 Windows / macOS / Linux。

当前插件预览按 Phase 0 + Phase 1 实施：查看空间、能力限制和诊断，并在宿主验证通过时创建、验证非宿主空间。桌面原有功能保留。安装方法与范围见[插件说明](packages/plugin/README.md)，施工与验收要求见[任务计划](tasks/pluginization-plan.md)。

## 数据规则

- `web` 是唯一根 profile，使用官方默认 `$DSH_HOME/sessions/` 与 `$DSH_HOME/storages/`，**永不打 patch**。Hub 安装前的聊天都归它。
- 其它 profile 都是工作台：双 root 覆盖到 `$DSH_HOME/hub/<name>/sessions` 与 `.../storages`（默认树的**兄弟**目录，禁止嵌进 `sessions/`）。
- 已有非 web profile 首次确认后自动转换（备份 `cordis.patch.yml` 再写 dual-root）。插件栈不动。会话列表从空开始。
- 转换时固定提示：**「你的历史聊天统一由 web 维护，工作台从全新会话开始」**。
- 共享家目录身份：API Key、`settings.yaml`、Agent 预设。不做迁移、不做多套 `DSH_HOME`。
- 插件**发现**在 Hub 设置里（NanmiCoder 目录 schema，MIT）。安装仍是对勾选工作台跑 `dsh plugin --profile <name> add`，不是全局一份插件栈。

## 安全

Spaces 不添加自己的遥测；上游 DSH 和插件遵循各自网络设置。`web` 不写工作台隔离 patch，但运行 DSH 会正常写入其配置和聊天。写工作台 patch 前保留备份；启动前用真实 `dump-config` 校验。工作台隔离聊天和存储，不是文件访问沙箱。开发测试默认使用 `.sandbox/dsh-home`，本轮验收使用全新临时 Home。

恢复快照前通常会完整备份当前状态。当前运行时损坏或丢失时，需要明确确认后，才能先保存当前数据再恢复；该备份会标为“仅数据备份”，不能作为完整运行环境直接恢复。恢复流程完成前，空间不能启动或修改数据。

## 开发

```bash
npm install
node scripts/setup-sandbox.mjs
npm test
npm run typecheck
npm run validate:isolation
npm run dev
```
