# DSH Spaces

**Spaces for DeepSeek Harness — switch your DSH workspaces like Discord servers.**

> **This development branch is still under construction and acceptance. It is not a release.** Desktop isolation, safety, and license below still apply. The workbench is documented in [docs/workbench.md](docs/workbench.md). Fault policy: [docs/let-it-crash.md](docs/let-it-crash.md).

Plugin installation: [standard install guide](docs/plugin-standard-install.md). Run `pnpm run pack:plugin`, install the printed tarball with the official CLI, then open **工作台 → 初始化 Spaces** in ordinary DSH Web. Default CLI channel: official **`latest`**, pinned to the resolved exact version. The local plugin is not yet published to npm.

A desktop shell and a DSH-native workbench, sharing isolation, lifecycle management, and error reporting. The desktop rail embeds the official DSH Web UI. The workbench supervisor binds `127.0.0.1`, owns Home run rights, and embeds workspaces in iframes behind a 72px space rail. Community / open source. Desktop targets Windows / macOS / Linux.

DSH Spaces does **not** promise that arbitrary plugin combinations will run. Plugin errors, dependency conflicts, incompatible config, start failures, and process crashes are allowed outcomes. Spaces records the failure and reports the known cause, or says the cause is unknown. It does not recover a failed environment — not automatically, and not through a manual repair wizard.

中文说明见下方 [中文](#dsh-spaces-中文).

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
- **Backups before write.** Any write to `cordis.patch.yml` first copies `cordis.patch.yml.bak-<timestamp>`. That is a pre-commit safety copy, not a product restore flow.
- **Atomic writes.** `spaces.json` and patches use same-volume temp + rename (not `%TEMP%`). A failed prepare does not replace the previous file. That is not rollback of a committed result.
- **Start gate.** Workbenches run `dsh --profile <name> --dump-config` first. Missing/wrong row ids refuse to start (A8). Refusal explains; it does not auto-correct the patch.
- **Dev sandbox.** Unpackaged builds use `.sandbox/dsh-home`. Tests refuse the real `~/.dsh`.

The supervisor and doctor use the same production-home guard: disposable Homes do not pass `--allow-real-home`; a Home you actually use must be an explicit `--home` plus that flag. Same Home: desktop and Web share one write lease. Closing a workbench browser tab does not stop instances; an explicit shutdown does. The supervisor does not claim every DSH process on the machine. Unregistered manual instances are a known gap — [external discovery](tasks/workbench-external-discovery.md).

## Failures

See [docs/let-it-crash.md](docs/let-it-crash.md). Spaces reports what happened (space, stage, plugin or unknown, reason, exit code or signal) in still-available UI or local output. Error actions are **查看错误详情** and **复制脱敏日志**. User start / stop / restart / install / uninstall / config stay ordinary management actions. They are not recovery.

Runtime product paths follow [docs/let-it-crash.md](docs/let-it-crash.md). Public restore APIs fail explicitly. Remaining CLI/browser matrix gaps: [tasks/q-coverage.md](tasks/q-coverage.md).

App updates and DSH runtime upgrades remain separate operations. Explicit runtime upgrades may update official base plugins in `web`, while its isolation patch remains protected. Candidate install that never switches the current pointer is a failed prepare, not a restore. After a committed switch, a later fault is reported in place; Spaces does not switch back.

## Requirements

- Node 24 for contributing; the app also installs a managed Node, pnpm, and DSH CLI on first launch
- Package source is selectable: China (npmmirror) or official (npmjs / nodejs.org)
- Keep official base plugins matched to the selected CLI rather than independently following plugin dist-tags. First install uses `@deepseek-ai/dsh@latest` and pins the resolved exact version.
- Workbench write gate accepts any exact installed DSH CLI version. Tags such as `latest` / `next` are not a bound version. Plugin peers on SDK `0.1.5-rc.2` for this repo's build; that is not a CLI allowlist. Isolated candidate builds are in-repo verification, not a user bypass.

## Develop

Desktop development still uses the sandbox Home. Workbench supervisor, packing, and product-Home flags: [docs/workbench.md](docs/workbench.md). Plugin roles (manager vs guide-only): [packages/plugin/README.md](packages/plugin/README.md). Current remaining work: [tasks/todo.md](tasks/todo.md).

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

See the full command, including `--plugin-artifact`, `--view-bridge-artifact`, `--node`, `--snapshot-worker`, and `--control-tool-root`, in [docs/workbench.md](docs/workbench.md). Omitting those flags leaves the manager or iframe handshake incomplete. **Target policy / known implementation gap:** `--snapshot-worker` is still required by the current supervisor for runtime install and maintenance execution. It is not a documented restore product. Do not drop the flag from a working start command until R4 extracts the non-restore execution path.

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

> **本分支仍在施工和验收，不是一次发布。** 下面的桌面隔离、安全和许可证仍然有效。工作台（独立 `127.0.0.1` 监督进程、专用管理 profile、iframe 空间）见 [docs/workbench.md](docs/workbench.md)。故障政策见 [docs/let-it-crash.md](docs/let-it-crash.md)。不要把本地构建或 candidate 包当成已发布产品，或当成绕过官方 CLI 门禁的方法。

桌面壳与 DSH 原生工作台共用隔离规则、生命周期管理和错误报告。桌面版左侧是官方 profile 图标栏，右侧内嵌官方 Web UI。工作台监督进程只绑 `127.0.0.1`，持有 Home 运行权，用 72px 空间栏嵌入各工作空间。桌面版面向 Windows / macOS / Linux。

插件由用户自由选择和组合。Spaces **不承诺**任意插件组合都能正常运行，也不负责把失败的环境修复成可运行状态。出错时如实记录并说明已知原因或明确未知。不提供自动或手动恢复。

## 数据规则

- `web` 是唯一根 profile，使用官方默认 `$DSH_HOME/sessions/` 与 `$DSH_HOME/storages/`，**永不打 patch**。Hub 安装前的聊天都归它。
- 其它 profile 都是工作台：双 root 覆盖到 `$DSH_HOME/hub/<name>/sessions` 与 `.../storages`（默认树的**兄弟**目录，禁止嵌进 `sessions/`）。
- 已有非 web profile 首次确认后自动转换（备份 `cordis.patch.yml` 再写 dual-root）。插件栈不动。会话列表从空开始。
- 转换时固定提示：**「你的历史聊天统一由 web 维护，工作台从全新会话开始」**。
- 共享家目录身份：API Key、`settings.yaml`、Agent 预设。不做迁移、不做多套 `DSH_HOME`。
- 插件**发现**在 Hub 设置里（NanmiCoder 目录 schema，MIT）。安装仍是对勾选工作台跑 `dsh plugin --profile <name> add`，不是全局一份插件栈。
- 管理工作台是专用 profile `spaces-hub`（重名递增后缀），不是往普通 `coding` profile 里装完整 Spaces。普通空间只装轻量 view-bridge。误装完整插件只会看到「返回工作台」。流程见 [工作台说明](docs/workbench.md)。

## 安全

Spaces 不添加自己的遥测；上游 DSH 和插件遵循各自网络设置。`web` 不写工作台隔离 patch，但运行 DSH 会正常写入其配置和聊天。写工作台 patch 前保留备份（提交前安全副本，不是产品恢复流程）；启动前用真实 `dump-config` 校验，校验失败就拒绝并说明原因，不自动改 patch。工作台隔离聊天和存储，不是文件访问沙箱。开发测试默认使用 `.sandbox/dsh-home`，不要拿生产 `~/.dsh` 当试验 Home。

同一 Home 桌面和 Web 只有一个写控制者；关浏览器标签不停实例，设置里的「预览关闭」才停监督进程。监督进程不会接管本机所有未登记的手工 DSH。[外部发现缺口](tasks/workbench-external-discovery.md)。

故障政策见 [docs/let-it-crash.md](docs/let-it-crash.md)。错误页只提供错误详情和脱敏日志；不提供救援入口、检查并恢复、恢复中断任务、配置恢复或整 Home 恢复。

产品路径已按 [docs/let-it-crash.md](docs/let-it-crash.md) 报告失败、不恢复。未在本机跑完的 CLI/浏览器项见 [tasks/q-coverage.md](tasks/q-coverage.md)。

本分支已在隔离 Home 验证过基础 iframe / 稳定入口、部分主题、空间栏操作、桌面与 Web 运行权、插件安装。默认跟随官方 `latest` 并钉住所选精确版本；未知版本号本身不再导致只读。最终运行时升级、管理插件自升级和新视频仍在验收，不能当成已经完成。历史上曾作为产品能力验收的整 Home 快照恢复、kill 故障恢复、配置恢复，自 2026-09-15 起不再是施工与发布门槛。

## 开发

```bash
npm install
node scripts/setup-sandbox.mjs
npm test
npm run typecheck
npm run validate:isolation
npm run dev
```

`npm run dev` 使用 `.sandbox/dsh-home`。工作台监督进程的完整启动参数（plugin / view-bridge / node / snapshot-worker / control-tool-root，缺一不可）见 [docs/workbench.md](docs/workbench.md)。当前启动仍需要 `--snapshot-worker`，因为它同时承担运行时安装等非恢复执行；在 R4 抽出该能力之前不要从可运行教程里删掉。不要在应用占用同一套 sandbox profile 时跑隔离/生命周期脚本。

活动任务账本：[tasks/todo.md](tasks/todo.md)。

## 构建

```bash
npm run build
npx electron-builder --win   # 或 --mac / --linux
```

安装包在 `release/`。本地 `win-unpacked` 只是构建产物，不是发布。

## 许可证

MIT。见 `LICENSE`。
