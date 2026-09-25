# DSH Spaces

**A multi-space plugin inside compatible DSH applications. Your own desktop is an optional distribution, not a required client.**

Current positioning and supported adapters: [Host embedding contract](docs/host/embedding.md). This branch adds an in-place rail to ordinary loopback Web hosts; official Desktop custom-scheme and third-party native adapters remain unverified.

**Blueprint users and authors:** start with [BLUEPRINT.md](BLUEPRINT.md), the first-level guide and format contract for sharing plugin compositions and configuration presets as JSON or copyable codes. Implementation and acceptance status: [blueprint work record](tasks/blueprint-implementation.md).

Download desktop builds from [GitHub Releases](https://github.com/klarkxy/dsh-spaces/releases). Current workbench contract: [docs/workbench.md](docs/workbench.md), [tasks/workbench-contract.md](tasks/workbench-contract.md), [tasks/merge-contract-v2.md](tasks/merge-contract-v2.md). Fault policy: [docs/let-it-crash.md](docs/let-it-crash.md). Merge acceptance: [tasks/merge-execution.md](tasks/merge-execution.md). Historical recovery docs stay historical — start at [tasks/history-recovery.md](tasks/history-recovery.md), do not treat them as the current gate.

Plugin install: [standard install guide](docs/plugin-standard-install.md). Run `pnpm run pack:plugin`, install the printed tarball with the official CLI, then **工作台 → 初始化 Spaces** in ordinary DSH Web. The original application stays in place; the same window displays the space rail and contained manager. Default CLI version: official **`0.1.7-alpha.1`**, pinned for new installations. The local plugin is not on npm.

Opening the desktop connects to a healthy workbench or starts it once when no service exists and the runtime is ready. First-time environment installation continues into the workbench automatically. A stopped service is not an error; genuine startup failures and ownership conflicts remain visible, without automatic retry or lock takeover.

One Supervisor owns Home run rights and management writes. Desktop is a local shell (window, tray, first Node/pnpm/CLI prepare, connect). The workbench page is the same spaces-hub UI in the browser and in a sandboxed desktop view. Ordinary spaces get a view bridge, not a second manager.

DSH Spaces does **not** promise that arbitrary plugin combinations will run. Failures are recorded and reported. Spaces does not recover a failed environment.

中文说明见下方 [中文](#dsh-spaces-中文).

## Why

Official DSH profiles isolate the plugin stack, not sessions or workspace groups. Spaces keeps each workbench's sessions, storage and local credentials under `$DSH_HOME/hub/<name>/`; alpha settings persist in `profiles/<name>/cordis.patch.yml` through the native ConfigEditor. Shared LLM connections live in a Home-level catalog. Named Spaces never import the root Home `settings.yaml` or write the default `web` profile. See the [alpha migration and acceptance record](tasks/alpha-migration.md).

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

After a user-confirmed component upgrade, the old service stages the candidate, stops owned processes, and hands the Home lock to a one-shot launcher that selects the new payload and starts Supervisor once. Acceptance covers a real component handoff, standard plugin installation, and a packaged Windows desktop sharing an active job with Chromium. See [the acceptance record](tasks/merge-execution.md) for exact builds and platform limits.

## Requirements

- Node 24 for contributing; first desktop launch can install managed Node, pnpm, and DSH CLI
- Package source: China (npmmirror) or official (npmjs / nodejs.org)
- First install uses `@deepseek-ai/dsh@0.1.7-alpha.1`; existing selected runtimes are upgraded explicitly
- Workbench write gate accepts any exact installed DSH CLI version. Tags are not a bound version. Plugin peers on SDK `0.1.7-alpha.1` for this repo's build; that is not a CLI allowlist

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
npm run dev:web
```

`npm run dev` (or `pnpm run dev`) builds the current component group, then opens Electron against the existing `.sandbox/dsh-home`. After acquiring the desktop instance lock, it compares installed content with the build, normally stops an idle older service, installs the current manager packages, and selects the matching Supervisor. Unchanged content skips installation. Space data stays in place; the default `web` profile is not modified. Electron browser storage uses `.sandbox/electron-user-data`; `DSH_SPACES_HOME` and `DSH_SPACES_USER_DATA` can override the development paths.

Exit the previous development command before launching another build, and normally stop active ordinary spaces before updating components. An already-open development window, active job, ambiguous ownership or unfinished maintenance causes an explicit refusal. Failed updates preserve evidence and are not replayed. Manager-plugin changes take effect on the next explicit `dev` launch; this is not plugin hot reload. `npm run test:development` checks this workflow.

`npm run dev:web` recreates `.sandbox/dsh-web-home`, installs this checkout's plugin into official `web`, and starts `dsh web`. Click **初始化 Spaces / Initialize Spaces** in the browser. Supervisor flags: [docs/workbench.md](docs/workbench.md). Do not run isolation/lifecycle scripts while the app uses the same sandbox profiles. Activity ledger: [tasks/todo.md](tasks/todo.md).

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

**安装在兼容 DSH 应用内的多空间插件：左侧切空间，右侧使用 WebUI，不要求打开专属客户端。**

新定位及支持边界见 [宿主嵌入合同](docs/host/embedding.md)。本批支持普通 loopback Web 宿主内的空间栏；官方 Desktop 自定义协议与第三方原生适配仍待实现、验收。

**使用或开发蓝图能力，请先阅读根目录 [BLUEPRINT.md](BLUEPRINT.md)。** 蓝图以 JSON 或分享码分发插件组合与配置预设。实现与验收状态见[蓝图实施记录](tasks/blueprint-implementation.md)。

桌面安装包见 [GitHub Releases](https://github.com/klarkxy/dsh-spaces/releases)。现行工作台说明：[docs/workbench.md](docs/workbench.md)，合同：[tasks/workbench-contract.md](tasks/workbench-contract.md)、[tasks/merge-contract-v2.md](tasks/merge-contract-v2.md)。故障政策：[docs/let-it-crash.md](docs/let-it-crash.md)。本次合并验证见 [验收记录](tasks/merge-execution.md)。历史恢复文档只作追溯，从 [tasks/history-recovery.md](tasks/history-recovery.md) 进入，不是现行门槛。

打开桌面会连接健康的工作台；确认没有后台且运行环境就绪时，正常启动一次。首次安装环境完成后会自动进入工作台。尚未启动不再显示成错误；真正的启动失败与运行权冲突仍明确报告，不自动重试或接管锁。

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

`npm run dev` / `pnpm run dev` 先构建当前组件，再打开 Electron，沿用 `.sandbox/dsh-home`。取得桌面单实例锁后，按内容比较已安装组件；有变化时正常停止空闲旧服务、安装管理插件并选择匹配的 Supervisor，没有变化则跳过安装。保留空间数据，不修改默认 `web`。开发窗口的浏览器数据位于 `.sandbox/electron-user-data`，可通过 `DSH_SPACES_HOME` / `DSH_SPACES_USER_DATA` 指定开发目录。

启动下一次开发构建前，退出上一次开发命令；更新组件前正常停止运行中的普通空间。已有开发窗口、执行中的任务、归属不明或中断维护都会明确拒绝；失败留证，不续跑。管理插件源码改动在下一次主动运行 `dev` 时生效，不提供插件热重载。定向验证：`npm run test:development`。

`npm run dev:web` 每次重建 `.sandbox/dsh-web-home`，把当前仓库插件装进官方 `web`，再启动 `dsh web`。浏览器里点 **初始化 Spaces**。监督进程参数见 [docs/workbench.md](docs/workbench.md)。活动账本：[tasks/todo.md](tasks/todo.md)。
