# DSH Spaces

**Spaces for DeepSeek Harness — switch your DSH workspaces like Discord servers.**

> **This development branch is still under construction and acceptance. It is not a release.** Isolation, safety, and license below still apply. Current workbench contract: [docs/workbench.md](docs/workbench.md), [tasks/workbench-contract.md](tasks/workbench-contract.md), [tasks/merge-contract-v2.md](tasks/merge-contract-v2.md). Fault policy: [docs/let-it-crash.md](docs/let-it-crash.md). Merge plan: [docs/plans/spaces-merge-convergence.md](docs/plans/spaces-merge-convergence.md). Historical recovery docs stay historical — start at [tasks/history-recovery.md](tasks/history-recovery.md), do not treat them as the current gate.

Plugin install: [standard install guide](docs/plugin-standard-install.md). Run `pnpm run pack:plugin`, install the printed tarball with the official CLI, then **工作台 → 初始化 Spaces** in ordinary DSH Web. Default CLI channel: official **`latest`**, pinned to the resolved exact version. The local plugin is not on npm.

One Supervisor owns Home run rights and management writes. Desktop is a local shell (window, tray, first Node/pnpm/CLI prepare, connect). The workbench page is the same spaces-hub UI in the browser and in a sandboxed desktop view. Ordinary spaces get a view bridge, not a second manager.

DSH Spaces does **not** promise that arbitrary plugin combinations will run. Failures are recorded and reported. Spaces does not recover a failed environment.

中文说明见下方 [中文](#dsh-spaces-中文).

## Why

Official DSH profiles isolate the plugin stack, not sessions or workspace groups. Spaces gives every workbench its own session, storage, settings, and local credentials under `$DSH_HOME/hub/<name>/`. Shared LLM connections live in a Home-level catalog, not in `web` settings. `web` stays on the official home `settings.yaml` unless it is explicitly joined.

`web` is the unique home profile. Spaces never writes its isolation patch. The manager profile is `spaces-hub` (suffix if taken). Ordinary spaces install `@dsh-spaces/view-bridge`. Putting the full `@dsh-spaces/plugin` on an ordinary space is a misinstall.

## Safety

- **No Spaces telemetry.** Model calls and plugins use their own network settings.
- **`web` isolation protection.** No storage-root overrides, no chat migration.
- **Backups before write.** `cordis.patch.yml.bak-<timestamp>` is a pre-commit copy, not product restore.
- **Atomic writes.** Same-volume temp + rename. A failed prepare does not replace the previous file.
- **Start gate.** `dsh --profile <name> --dump-config` first; missing/wrong row ids refuse to start.
- **Dev sandbox.** Unpackaged builds use `.sandbox/dsh-home`. Tests refuse real `~/.dsh`.

One Supervisor per Home. Desktop and browser attach to that process when it is healthy. Closing a tab or **exiting the desktop client** does not stop the service. Stopping all spaces and **stopping the service** (`service.shutdown`) are separate, explicit actions. Unregistered manual DSH processes are a known gap — [external discovery](tasks/workbench-external-discovery.md).

## Failures

See [docs/let-it-crash.md](docs/let-it-crash.md). Error actions are **查看错误详情** and **复制脱敏日志**. User start / stop / restart / install / uninstall / config stay ordinary management. Public restore APIs fail explicitly. Remaining unrun CLI/browser items: [tasks/q-coverage.md](tasks/q-coverage.md).

Desktop shell updates, Spaces component updates, and official DSH runtime upgrades are different flows. A candidate that never becomes current is a failed prepare, not a restore. After a committed pointer switch, a later fault is reported in place.

## Current architecture (this branch)

Protocol **2**. Management state carries `protocolVersion`, `serviceEpoch`, `revision`, and `availability`. Ordinary writes use `{ serviceEpoch, expectedRevision }`. Old protocol, missing context, or epoch/revision mismatch is rejected. There is no public `controller.acquire` / `controller.release` / `recovery.*` / `snapshot.restore` / `config.restore`.

Shared Node modules for supervisor, jobs, products, and upgrade live under `src/adapters/node` (moved from `src/main`). Electron-only code stays in the desktop shell.

Build lists five immutable components in `lib/supervisor/manifest.json` (schemaVersion 2): Supervisor, manager plugin, view-bridge, llm-bridge, installation worker. Cold start and pack consume that group. Bootstrap passes `--component-payload` and the same group's plugin / view-bridge / llm-bridge artifacts plus `--snapshot-worker`.

`--snapshot-worker` remains required for **normal Home snapshots** and remaining installation IO. Runtime-installation has been extracted; the worker is not a restore product.

**Intended (B5, not verified here):** after a user-confirmed component upgrade, the old service stages the candidate, stops owned processes, and hands the Home lock to a one-shot launcher that selects the new payload and starts Supervisor once. **Verified in this branch:** isolated unit/CLI tests around payload, pack, and archive parse. **Not claimed:** real UI dual-end acceptance, published tarball/installer, or a completed launcher handoff.

## Requirements

- Node 24 for contributing; first desktop launch can install managed Node, pnpm, and DSH CLI
- Package source: China (npmmirror) or official (npmjs / nodejs.org)
- First install uses `@deepseek-ai/dsh@latest` and pins the resolved exact version
- Workbench write gate accepts any exact installed DSH CLI version. Tags are not a bound version. Plugin peers on SDK `0.1.5-rc.2` for this repo's build; that is not a CLI allowlist

## Develop

```bash
npm install
node scripts/setup-sandbox.mjs
npm test
npm run test:llm
npm run typecheck
npm run validate:isolation
npm run validate:llm:secrets
npm run dev
```

`npm run dev` uses `.sandbox/dsh-home`. Supervisor flags: [docs/workbench.md](docs/workbench.md). Do not run isolation/lifecycle scripts while the app uses the same sandbox profiles. Activity ledger: [tasks/todo.md](tasks/todo.md).

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

> **本分支仍在施工和验收，不是一次发布。** 现行工作台说明：[docs/workbench.md](docs/workbench.md)，合同：[tasks/workbench-contract.md](tasks/workbench-contract.md)、[tasks/merge-contract-v2.md](tasks/merge-contract-v2.md)。故障政策：[docs/let-it-crash.md](docs/let-it-crash.md)。历史恢复文档只作追溯，从 [tasks/history-recovery.md](tasks/history-recovery.md) 进入，不是现行门槛。

一个 Supervisor 持有 Home 运行权和管理写入。桌面是本地壳（窗口、托盘、首次 Node/pnpm/CLI 准备、连接服务）。浏览器和桌面沙箱 view 使用同一套 spaces-hub 工作台。普通空间只装 view-bridge。

插件组合可以失败。Spaces 记录并说明已知原因或明确未知，不提供自动或手动恢复。

## 数据规则

- `web` 是唯一根 profile，使用官方默认 `$DSH_HOME/sessions/` 与 `$DSH_HOME/storages/`，**永不打 patch**。
- 其它工作台的会话、存储、settings 和本地凭据在 `$DSH_HOME/hub/<name>/`。
- 共享的是 Home 级 LLM 连接库，不是整份 `settings.yaml`。
- 管理工作台是专用 profile `spaces-hub`。普通空间只装 `@dsh-spaces/view-bridge`。

## 现行行为

协议版本 **2**。变更带 `serviceEpoch` 与 `expectedRevision`。公开合同没有 `controller.acquire` / `release`、没有恢复命令。关标签或**退出桌面客户端**不停止后台。停止全部空间和停止服务（`service.shutdown`）是两个独立操作。

通用 Node 模块在 `src/adapters/node`。构建清单覆盖 Supervisor、管理插件、view-bridge、llm-bridge、安装 worker 五组件。启动仍需要同组 `--snapshot-worker`，运行时安装 IO 已抽出。组件升级采用一次性启动器交接，新管理器就绪后才确认成功。本次源码测试、标准插件、组件更新和桌面包的验证范围见 [合并验收记录](tasks/merge-execution.md)。

`npm run dev` 使用 `.sandbox/dsh-home`。监督进程参数见 [docs/workbench.md](docs/workbench.md)。活动账本：[tasks/todo.md](tasks/todo.md)。
