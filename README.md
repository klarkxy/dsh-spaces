# DSH Spaces

**Spaces for DeepSeek Harness — switch your DSH workspaces like Discord servers.**

> **This development branch is still under construction and acceptance. It is not a release.** Desktop isolation, safety, and license below still apply. The workbench is documented in [docs/workbench.md](docs/workbench.md).

Plugin installation: [standard install guide](docs/plugin-standard-install.md). Run `pnpm run pack:plugin`, install the printed tarball with the official CLI, then open **工作台 → 初始化 Spaces** in ordinary DSH Web. Supported CLI: **0.1.5-rc.1 and 0.1.5-rc.2**. The local plugin is not yet published to npm.

A desktop shell and a DSH-native workbench, sharing the same isolation and recovery core. The desktop rail embeds the official DSH Web UI. The workbench supervisor binds `127.0.0.1`, owns Home run rights, and embeds workspaces in iframes behind a 72px space rail. Community / open source. Desktop targets Windows / macOS / Linux.

中文说明见下方 [中文](#dsh-spaces-中文)。

## Why

Official DSH profiles isolate the plugin stack, not sessions or workspace groups. Running two profiles at once can race the same JSONL files. DSH Spaces keeps **one shared identity** (API keys, `settings.yaml`) and gives every workbench its own session/storage roots under `$DSH_HOME/hub/<name>/`. Plugin discovery is in Hub settings (NanmiCoder catalog schema, MIT); installs still run `dsh plugin --profile <name> add` into the spaces you select.

`web` is the unique home profile. Spaces never writes its isolation patch. Pre-Hub chats stay there; explicitly requested plugin operations may update its plugin installation.

The workbench does **not** install the full Spaces manager into an ordinary coding profile. A dedicated `spaces-hub` profile (suffix if that name is taken) holds management. Ordinary spaces get a lightweight view bridge. Putting `@dsh-spaces/plugin` on an ordinary space is a misinstall: that space only offers “Return to workbench.” See [the workbench guide](docs/workbench.md).

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

The supervisor and doctor use the same production-home guard: disposable Homes do not pass `--allow-real-home`; a Home you actually use must be an explicit `--home` plus that flag. Same Home: desktop and Web share one write lease. Closing a workbench browser tab does not stop instances; an explicit shutdown does. The supervisor does not claim every DSH process on the machine. Unregistered manual instances are a known gap — [external discovery](tasks/workbench-external-discovery.md).

## Runtime upgrades and recovery

Version 0.2.0 includes process lifecycle controls, tray behavior, diagnostics, and coordinated DSH upgrades with recoverable snapshots. App updates and DSH runtime upgrades are separate operations. Explicit runtime upgrades may update official base plugins in `web`, while its isolation patch remains protected. See the [acceptance record](tasks/fix-acceptance-2026-09-11.md) for tested desktop scenarios and platform limits.

The workbench reuses whole-Home snapshots, plugin install/remove, and config restore through the supervisor. Final runtime upgrade, kill-fault recovery, CLI `0.1.5-rc.2` support, manager-plugin self-upgrade, and a new intro video are **still in acceptance** on this branch. Do not read this README as those items being done.

Recovery normally saves a complete backup before replacing data. If the current runtime is missing or damaged, recovery requires explicit confirmation to preserve the current data without that runtime. Such backups are marked as data-only and cannot be applied as complete runtime snapshots. Recovery must finish before spaces can start or modify data. When the plugin cannot load, use standalone [doctor](packages/doctor/README.md).

## Requirements

- Node 24 for contributing; the app also installs a managed Node, pnpm, and DSH CLI on first launch
- Package source is selectable: China (npmmirror) or official (npmjs / nodejs.org)
- Keep official base plugins matched to the selected CLI rather than independently following plugin dist-tags. First install uses `@deepseek-ai/dsh@0.1.5-rc.2`.
- Workbench write gate is CLI **`0.1.5-rc.1` only**. Plugin peers on SDK `0.1.5-rc.2`; that is not CLI 2. Isolated candidate builds are in-repo verification, not a user bypass.

## Develop

Desktop development still uses the sandbox Home. Workbench supervisor, packing, and product-Home flags: [docs/workbench.md](docs/workbench.md). Plugin roles (manager vs guide-only): [packages/plugin/README.md](packages/plugin/README.md).

Do not install the full plugin into an ordinary profile as the way to get management. `npm run validate:distribution` / `validate:plugin` remain isolated checks; they are not the new architecture install path.

```bash
npm install
node scripts/setup-sandbox.mjs
npm test
npm run typecheck
npm run validate:isolation
npm run dev
```

`npm run dev` uses `.sandbox/dsh-home`, not `~/.dsh`. Do not run the isolation/lifecycle scripts while the app is using the same sandbox profiles.

Local supervisor (disposable Home, after `npm run build:spaces` and packing plugin + view-bridge tarballs to an absolute directory **outside** the packages):

See the full command, including `--plugin-artifact`, `--view-bridge-artifact`, `--node`, `--snapshot-worker`, and `--control-tool-root`, in [docs/workbench.md](docs/workbench.md). Omitting those flags leaves the manager or iframe handshake incomplete.

## Build

```bash
npm run build
npx electron-builder --win   # or --mac / --linux
```

Installers land in `release/`. A local `win-unpacked` tree is a build artifact, not a GitHub release.

## License

MIT. See `LICENSE`.

---

# DSH Spaces (中文)

**Spaces for DeepSeek Harness — 像切 Discord 服务器一样切换你的 DSH 工作空间。**

> **本分支仍在施工和验收，不是一次发布。** 下面的桌面隔离、安全和许可证仍然有效。工作台（独立 `127.0.0.1` 监督进程、专用管理 profile、iframe 空间）见 [docs/workbench.md](docs/workbench.md)。不要把本地构建或 candidate 包当成已发布产品，或当成绕过官方 CLI 门禁的方法。

桌面壳与 DSH 原生工作台共用隔离规则和恢复核心。桌面版左侧是官方 profile 图标栏，右侧内嵌官方 Web UI。工作台监督进程只绑 `127.0.0.1`，持有 Home 运行权，用 72px 空间栏嵌入各工作空间。桌面版面向 Windows / macOS / Linux。

## 数据规则

- `web` 是唯一根 profile，使用官方默认 `$DSH_HOME/sessions/` 与 `$DSH_HOME/storages/`，**永不打 patch**。Hub 安装前的聊天都归它。
- 其它 profile 都是工作台：双 root 覆盖到 `$DSH_HOME/hub/<name>/sessions` 与 `.../storages`（默认树的**兄弟**目录，禁止嵌进 `sessions/`）。
- 已有非 web profile 首次确认后自动转换（备份 `cordis.patch.yml` 再写 dual-root）。插件栈不动。会话列表从空开始。
- 转换时固定提示：**「你的历史聊天统一由 web 维护，工作台从全新会话开始」**。
- 共享家目录身份：API Key、`settings.yaml`、Agent 预设。不做迁移、不做多套 `DSH_HOME`。
- 插件**发现**在 Hub 设置里（NanmiCoder 目录 schema，MIT）。安装仍是对勾选工作台跑 `dsh plugin --profile <name> add`，不是全局一份插件栈。
- 管理工作台是专用 profile `spaces-hub`（重名递增后缀），不是往普通 `coding` profile 里装完整 Spaces。普通空间只装轻量 view-bridge。误装完整插件只会看到「返回工作台」。流程见 [工作台说明](docs/workbench.md)。

## 安全

Spaces 不添加自己的遥测；上游 DSH 和插件遵循各自网络设置。`web` 不写工作台隔离 patch，但运行 DSH 会正常写入其配置和聊天。写工作台 patch 前保留备份；启动前用真实 `dump-config` 校验。工作台隔离聊天和存储，不是文件访问沙箱。开发测试默认使用 `.sandbox/dsh-home`，不要拿生产 `~/.dsh` 当试验 Home。

同一 Home 桌面和 Web 只有一个写控制者；关浏览器标签不停实例，设置里的「预览关闭」才停监督进程。监督进程不会接管本机所有未登记的手工 DSH。[外部发现缺口](tasks/workbench-external-discovery.md)。

恢复快照前通常会完整备份当前状态。当前运行时损坏或丢失时，需要明确确认后，才能先保存当前数据再恢复；该备份会标为“仅数据备份”，不能作为完整运行环境直接恢复。恢复流程完成前，空间不能启动或修改数据。插件加载不了时用独立 [doctor](packages/doctor/README.md)。

本分支已在隔离 Home 验证过基础 iframe / 稳定入口、部分主题、空间栏操作、桌面与 Web 运行权、插件与一次整 Home 快照恢复。最终运行时升级、kill 故障恢复、CLI `0.1.5-rc.2`、管理插件自升级和新视频仍在验收，不能当成已经完成。

## 开发

```bash
npm install
node scripts/setup-sandbox.mjs
npm test
npm run typecheck
npm run validate:isolation
npm run dev
```

`npm run dev` 使用 `.sandbox/dsh-home`。工作台监督进程的完整启动参数（plugin / view-bridge / node / snapshot-worker / control-tool-root，缺一不可）见 [docs/workbench.md](docs/workbench.md)。不要在应用占用同一套 sandbox profile 时跑隔离/生命周期脚本。

## 构建

```bash
npm run build
npx electron-builder --win   # 或 --mac / --linux
```

安装包在 `release/`。本地 `win-unpacked` 只是构建产物，不是发布。

## 许可证

MIT。见 `LICENSE`。
