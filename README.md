# DSH Spaces

[![XERJ Corpus Hub contributor](https://hub.xerj.org/contributors/klarkxy/badge.svg)](https://hub.xerj.org/contributors/klarkxy)

**A multi-space plugin installed into compatible DSH applications (official Web and Desktop). There is no standalone client.**

DSH Spaces supports **Node.js 24.21+ (24.x) and 26.x** for its host, Supervisor, managed runtime and development tools. This includes the Node 24.21.0 bundled with official Desktop 0.2.1-rc.2. Newly installed managed toolchains still default to Node 26.10.0; existing supported toolchains are retained.

Current positioning and supported adapters: [Host embedding contract](docs/host/embedding.md). Ordinary loopback Web hosts and official Windows Desktop 0.2.1-rc.2 support the in-place rail. The installed Desktop and native Browser Space were exercised with isolated Homes; see the [acceptance record](tasks/node24-desktop-20261020.md). Third-party native adapters remain unverified.

**Blueprint users and authors:** start with [BLUEPRINT.md](BLUEPRINT.md). The independently installable [`@klarkxy/dsh-blueprint`](packages/blueprint/README.md) lives in this repository; Spaces consumes its protocol for creating and sharing spaces. DSHBP2 shares plugin compositions; DSHBP1 retains configuration presets. Current migration and DSH 0.2 acceptance: [migration record](tasks/archive/blueprint-migration-0.2.md).

Current workbench contract: [docs/workbench.md](docs/workbench.md), [tasks/workbench-contract.md](tasks/workbench-contract.md), [tasks/merge-contract-v2.md](tasks/merge-contract-v2.md). Fault policy: [docs/let-it-crash.md](docs/let-it-crash.md). Merge acceptance: [tasks/merge-execution.md](tasks/merge-execution.md). Historical recovery docs stay historical — start at [tasks/history-recovery.md](tasks/history-recovery.md), do not treat them as the current gate.

Plugin install: [standard install guide](docs/plugin-standard-install.md). Run `pnpm run pack:plugin`, install the printed tarball with the official CLI, then **工作台 → 初始化 Spaces** in ordinary DSH Web. The original application stays in place; the same window displays the space rail and contained manager. Default CLI version: official **`0.2.1-rc.2`**, pinned for new installations. The local plugin is not on npm.

After installing the plugin into an official DSH Web or Desktop profile, open the **工作台 / Workbench** entry and click **初始化 Spaces / Initialize Spaces**. Initialization is one explicit user request: it connects to a healthy workbench or starts it once when no service exists and the runtime is ready. A stopped service is not an error; genuine startup failures and ownership conflicts remain visible, without automatic retry or lock takeover.

One Supervisor owns Home run rights and management writes. Browsers and the official Desktop host attach to that process; the workbench page is the same spaces-hub UI everywhere. Ordinary spaces get a view bridge, not a second manager.

DSH Spaces does **not** promise that arbitrary plugin combinations will run. Failures are recorded and reported. Spaces does not recover a failed environment.

中文说明见下方 [中文](#dsh-spaces-中文).

## Why

Official DSH profiles isolate the plugin stack, not sessions or workspace groups. Spaces keeps each workbench's sessions, storage and local credentials under `$DSH_HOME/hub/space-<name>/`; alpha settings persist in `profiles/space-<name>/cordis.patch.yml` through the native ConfigEditor. Shared LLM connections live in a Home-level catalog. Named Spaces never import the root Home `settings.yaml` or write the default `web` profile. See the [alpha migration and acceptance record](tasks/archive/alpha-migration.md).

A space exists only when the user creates it in Spaces — directly, or from a template, blueprint, or share import. Its profile directory is always `$DSH_HOME/profiles/space-<name>` and its data lives under `$DSH_HOME/hub/space-<name>`; membership is the entry recorded in `hub/spaces.json`. Spaces never scans, adopts, lists, or modifies other profile directories. Profiles created by older versions or other tools are not migrated — they stay ordinary DSH profiles.

`web` is the unique home profile. Spaces never writes its isolation patch. The manager profile is `spaces-hub` (suffix if taken). Ordinary spaces install `@dsh-spaces/view-bridge`. Putting the full `@dsh-spaces/plugin` on an ordinary space is a misinstall.

## Safety

- **No Spaces telemetry.** Model calls and plugins use their own network settings.
- **`web` isolation protection.** No storage-root overrides, no chat migration.
- **Backups before write.** `cordis.patch.yml.bak-<timestamp>` is a pre-commit copy, not product restore.
- **Atomic writes.** Same-volume temp + rename. A failed prepare does not replace the previous file.
- **Start gate.** `dsh --profile <name> --dump-config` first; missing/wrong row ids refuse to start.
- **Dev sandbox.** Development uses `.sandbox` homes. Tests refuse real `~/.dsh`.

One Supervisor per Home. Browser tabs and host windows attach to that process when it is healthy. Closing a tab or host window does not stop the service. Stopping all spaces and **stopping the service** (`service.shutdown`) are separate, explicit actions. Unregistered manual DSH processes are a known gap — [external discovery](tasks/workbench-external-discovery.md).

## Failures

See [docs/let-it-crash.md](docs/let-it-crash.md). Error actions are **查看错误详情** and **复制脱敏日志**. User start / stop / restart / install / uninstall / config stay ordinary management. Public restore APIs fail explicitly. Remaining unrun CLI/browser items: [tasks/q-coverage.md](tasks/q-coverage.md).

Spaces follows the host-installed plugin: upgrade the plugin through DSH (`dsh plugin --profile web add <new tarball>`), shut the service down from the manager UI, then reopen Spaces. Each space pins an exact DSH version at creation (the host version). Switch a space's runtime from its details — no downgrade, no automatic snapshot; incompatible third-party plugins block the switch and official plugins are built into the selected runtime and change with it; Spaces never installs them into a profile. The manager follows the host CLI.

## Current architecture (this branch)

Protocol **2**. Management state carries `protocolVersion`, `serviceEpoch`, `revision`, and `availability`. Ordinary writes use `{ serviceEpoch, expectedRevision }`. Old protocol, missing context, or epoch/revision mismatch is rejected. There is no public `controller.acquire` / `controller.release` / `recovery.*` / `snapshot.restore` / `config.restore`.

Shared Node modules for supervisor, jobs, products, and runtime live under `src/adapters/node`.

Build lists six immutable components in `lib/supervisor/manifest.json` (schemaVersion 2): Supervisor, manager plugin, view-bridge, Browser, llm-bridge, installation worker. Cold start and pack consume that group. Bootstrap passes `--component-payload` and the same group's plugin / view-bridge / Browser / llm-bridge artifacts plus `--snapshot-worker`. On cold start the Supervisor always selects the group bundled with the host plugin; a previously selected group is reused only when its digest matches. An old Home is never rewritten or migrated.

The create dialog offers a Browser preset. It creates an ordinary Space, installs the bundled Browser plugin and view bridge, selects its independent Browser root, and leaves cross-Space callers denied until the Browser Space's `allowedSpaces` is edited explicitly. Browser Host and client use official DSH Web profile services (Cordis, authenticated Connection RPC and slots); the small standalone Browser root and tab state belong to this repository. Web pages appear in iframes, so sites may refuse embedding and cross-origin navigation cannot update the displayed address. See [Browser plugin notes](packages/browser/README.md).

`--snapshot-worker` remains required for **normal Home snapshots** and remaining installation IO. Runtime-installation has been extracted; the worker is not a restore product.

To upgrade Spaces, install the new host plugin with `dsh plugin --profile web add <new tarball>`, shut the service down from the manager UI, and reopen Spaces. The Supervisor then selects the host plugin's component group, aligns the manager plugin before it starts, and each space's bridges align at space start. Leftover evidence from an interrupted earlier update still blocks writes. See [the acceptance record](tasks/merge-execution.md) for exact builds and platform limits.

## Requirements

- Node 24.21+ (24.x) or Node 26.x for contributing
- Package source: China (npmmirror) or official (npmjs / nodejs.org)
- First install uses `@deepseek-ai/dsh@0.2.1-rc.2`. Every space pins an exact DSH version — `0.2.0-rc.2` is the minimum, spaces below it refuse to start — and unused runtimes can be removed in settings
- Workbench write gate accepts any exact installed DSH CLI version. Tags are not a bound version. This repo builds against SDK `0.2.1-rc.2`; plugin peers retain the `0.2.0-rc.2` lower bound and explicitly admit the new prerelease. This is not a CLI allowlist.

## Develop

```bash
npm install
node scripts/setup-sandbox.mjs
npm test
npm run test:llm
npm run typecheck
npm run validate:isolation
npm run validate:llm:secrets
npm run dev:web
```

`npm run dev:web` builds and links the repository root into the custom `spaces-dev` profile at `.sandbox/dsh-link-home`, then starts the official Web app. Existing development data stays. `npm run dev:link` only prepares the link. The root is directly installable with `dsh plugin --profile spaces-dev add .` after building; see [local linked development](docs/plugin-standard-install.md#local-linked-development). Rebuild and explicitly restart the host to load changes; Supervisor changes also need an explicit service shutdown before reopening Spaces. Click **初始化 Spaces / Initialize Spaces** in the browser. Do not run isolation/lifecycle scripts against profiles in use. Activity ledger: [tasks/todo.md](tasks/todo.md).

## Build

```bash
npm run build        # builds the component group into packages/*/lib
npm run pack:plugin  # packs the prebuilt plugin tarball
```

Install the printed tarball with the official CLI; see [docs/plugin-standard-install.md](docs/plugin-standard-install.md). There is no standalone desktop package.

## License

MIT. See `LICENSE`.

---

# DSH Spaces (中文)

支持 **Node.js 24.21 及以上的 24.x，以及 26.x**，覆盖官方 Desktop 0.2.1-rc.2 内置的 Node 24.21.0。宿主、Supervisor、托管运行时和开发工具均接受这两个版本范围，CI 覆盖两条版本线；新安装的托管工具链仍默认 Node 26.10.0，不自动替换已有工具链。

**安装在兼容 DSH 应用内的多空间插件：左侧切空间，右侧使用 WebUI，不要求打开专属客户端。**

定位及支持边界见 [宿主嵌入合同](docs/host/embedding.md)。普通 loopback Web 和官方 Windows Desktop 0.2.1-rc.2 均支持宿主内空间栏。当前安装版 Desktop 的普通空间和原生浏览器空间已用隔离 Home 实测，见 [验收记录](tasks/node24-desktop-20261020.md)；第三方原生适配仍未验收。

**使用或开发蓝图能力，请先阅读 [BLUEPRINT.md](BLUEPRINT.md)。** 独立蓝图插件在本仓库维护，Spaces 依赖其协议创建和分享空间；插件本身无需安装 Spaces。新版分享插件组合，旧格式保留配置预设。迁移及 DSH 0.2 验收见[迁移记录](tasks/archive/blueprint-migration-0.2.md)。

现行工作台说明：[docs/workbench.md](docs/workbench.md)，合同：[tasks/workbench-contract.md](tasks/workbench-contract.md)、[tasks/merge-contract-v2.md](tasks/merge-contract-v2.md)。故障政策：[docs/let-it-crash.md](docs/let-it-crash.md)。本次合并验证见 [验收记录](tasks/merge-execution.md)。历史恢复文档只作追溯，从 [tasks/history-recovery.md](tasks/history-recovery.md) 进入，不是现行门槛。

把插件装进官方 DSH Web 或 Desktop 后，打开左侧 **工作台** 并点击 **初始化 Spaces**。初始化是一次明确的用户操作：连接健康的工作台，或在无服务且运行环境就绪时正常启动一次。尚未启动不再显示成错误；真正的启动失败与运行权冲突仍明确报告，不自动重试或接管锁。

一个 Supervisor 持有 Home 运行权和管理写入。浏览器和官方 Desktop 宿主都连接同一个服务，使用同一套 spaces-hub 工作台。普通空间只装 view-bridge。

插件组合可以失败。Spaces 记录并说明已知原因或明确未知，不提供自动或手动恢复。

## 数据规则

- `web` 是唯一根 profile，使用官方默认 `$DSH_HOME/sessions/` 与 `$DSH_HOME/storages/`，**永不打 patch**。
- 空间只在 Spaces 中创建（直接创建、模板、蓝图或分享导入），profile 目录固定为 `profiles/space-<name>`，数据在 `hub/space-<name>`；成员资格以 `hub/spaces.json` 注册项为准。Spaces 不扫描、不收养、不修改其他 profile 目录；旧版本或其他途径创建的 profile 不迁移，仍是普通 DSH profile。
- 共享的是 Home 级 LLM 连接库，不是整份 `settings.yaml`。
- 普通新建空间默认使用主空间模型，也可在创建时选择全局连接或本地配置；已有空间不自动改策略。主空间凭据不复制到子空间，显式模型与推理等级由官方聊天界面选择。
- 管理工作台是专用 profile `spaces-hub`。普通空间使用 `@dsh-spaces/view-bridge` 与对应的 LLM bridge。

## 现行行为

协议版本 **2**。变更带 `serviceEpoch` 与 `expectedRevision`。公开合同没有 `controller.acquire` / `release`、没有恢复命令。关闭标签或宿主窗口不停止后台。停止全部空间和停止服务（`service.shutdown`）是两个独立操作。

通用 Node 模块在 `src/adapters/node`。构建清单覆盖 Supervisor、管理插件、view-bridge、Browser、llm-bridge、安装 worker 六组件。启动仍需要同组 `--snapshot-worker`，运行时安装 IO 已抽出。组件升级采用一次性启动器交接，新管理器就绪后才确认成功。本次源码测试、标准插件与组件更新的验证范围见 [合并验收记录](tasks/merge-execution.md)。

`npm run dev:web` 构建后把仓库根目录软链接到 `.sandbox/dsh-link-home` 下的独立 `spaces-dev` profile，再启动官方 Web 应用，保留已有调试数据。`npm run dev:link` 只准备链接。也可在构建后从根目录执行 `dsh plugin --profile spaces-dev add .`，完整步骤见[本地链接调试](docs/plugin-standard-install.md#local-linked-development)。修改后重新构建并显式重启宿主；Supervisor 变更还需从工作台停止服务后再进入。浏览器里点 **初始化 Spaces**。活动账本：[tasks/todo.md](tasks/todo.md)。
