# DSH Spaces workbench

**Presentation update:** [Host embedding](host/embedding.md) supersedes the old ordinary-host redirect restriction. Compatible top-level hosts now keep their application and mount an in-place rail; manager-only management RPC and embedded view-bridge ownership remain unchanged. The shipped iframe transport is same-site HTTP loopback only.

> **This branch is still under construction and acceptance.** It is not a release.

Fault policy: [let it crash](let-it-crash.md). Current protocol contract: [tasks/merge-contract-v2.md](../tasks/merge-contract-v2.md) and [tasks/workbench-contract.md](../tasks/workbench-contract.md). Historical recovery text: [tasks/history-recovery.md](../tasks/history-recovery.md) — not the current gate.

**User install (ordinary Web):** [plugin-standard-install.md](plugin-standard-install.md) — `pnpm run pack:plugin`, then `dsh plugin --profile web add` of that tarball, `dsh web`, **初始化 Spaces**. That is the intended path. Installing the full plugin onto `coding` / `notes` is a misinstall. The package is not on npm.

One Supervisor on `127.0.0.1` holds Home run rights. Ordinary workspaces keep their data and get `@dsh-spaces/view-bridge`. They are not a second manager. Public restore commands fail. Error surfaces keep **查看错误详情** / **复制脱敏日志**.

Chinese: [中文](#dsh-spaces-工作台).

## What you get

- Protocol **2**. State includes `protocolVersion`, `serviceEpoch`, `revision`, `availability`. Writes use `{ serviceEpoch, expectedRevision }`. Old protocol or a mismatched epoch/revision is rejected. There is no public `controller.acquire`, `controller.release`, `recovery.*`, `snapshot.restore`, or `config.restore`.
- One Supervisor per Home. A second client attaches to a healthy existing service. It does not start a second controller and does not take over a live or unclear lock.
- Closing a tab does not stop spaces. **Exiting the desktop client destroys that client only** — the Supervisor stays up. Stopping all spaces and **stopping the service** (`service.shutdown`, preview then execute) are separate user actions.
- Manager profile `spaces-hub` (or `spaces-hub-2`, …). Ordinary spaces use a 72px rail and their own iframe origin. A failed start keeps the previous view and marks this switch as failed.
- User-initiated Home backups: **create**, **list**, **delete**. Create stops owned spaces first. That is not restore.

Default DSH channel is official **`latest`**, resolved to an exact version and pinned. Compatibility is required interfaces, not a permanent rc.1 / rc.2 allowlist.

## Isolated Home vs your Home

| | Development | Product Home |
|---|---|---|
| Purpose | Disposable directory | A Home you chose, often `~/.dsh` in a packaged desktop |
| How | Absolute `--home` **without** `--allow-real-home`. `npm run dev` uses `.sandbox/dsh-home`. `npm run dev:web` recreates `.sandbox/dsh-web-home` | Packaged desktop defaults to `~/.dsh`. Supervisor / doctor need `--home` **and** `--allow-real-home` |
| Do not | Point experiments at `~/.dsh` | Use production as a tutorial Home |

Browser callers never submit filesystem paths, CLI commands, or launch tokens.

Shared LLM connections are a Home-level catalog. Management uses `POST /api/workbench/llm` and `POST /api/workbench/llmCredential`. See [the global LLM plan](plans/global-llm-connections.md).

## Build, pack, start (from this repo)

From the repository root after `npm install`. `npm run build:spaces` writes `packages/*/lib` including the v2 component manifest at `packages/plugin/lib/supervisor/manifest.json`. Pack **outside** the package trees.

The manifest names five components: Supervisor, manager plugin, view-bridge, llm-bridge, installation worker (schemaVersion 2, exact versions, file sha256, `source: bundled`). Standard plugin install and desktop payload consume that group. Missing components fail closed.

PowerShell (directories **without spaces**; every path absolute):

```powershell
# Disposable Home — not ~/.dsh
$root = "C:\dsh-workbench-dev"
$spacesHome = "$root\home"
$tools = "$root\tools"
$artifacts = "$root\artifacts"
$snapshots = "$root\snapshots"
New-Item -ItemType Directory -Force -Path $spacesHome, $tools, $artifacts, $snapshots | Out-Null

npm run build:spaces
npm pack ./packages/plugin --ignore-scripts --pack-destination $artifacts
npm pack ./packages/view-bridge --ignore-scripts --pack-destination $artifacts
npm pack ./packages/llm-bridge --ignore-scripts --pack-destination $artifacts

node packages/plugin/lib/supervisor/index.js `
  --home $spacesHome `
  --bin C:\path\to\@deepseek-ai\dsh\lib\bin.js `
  --node "$env:ProgramFiles\nodejs\node.exe" `
  --plugin-artifact $artifacts\dsh-spaces-plugin-0.3.0.tgz `
  --view-bridge-artifact $artifacts\dsh-spaces-view-bridge-0.3.0.tgz `
  --llm-bridge-artifact $artifacts\dsh-spaces-llm-bridge-0.3.0.tgz `
  --control-tool-root $tools `
  --component-payload "$(Resolve-Path packages\plugin\lib)" `
  --snapshot-worker "$(Resolve-Path packages\plugin\lib\supervisor\snapshot-worker.mjs)" `
  --snapshot-root $snapshots
```

Current Node entry is that argv: `--component-payload` plus **three archives** (plugin, view-bridge, llm-bridge) and the **same group's** `--snapshot-worker`. Product bootstrap from an installed plugin copies the immutable group outside Home and passes the same flags. Do not mix tarballs from different builds. There is no automatic repair, retry, restore, or lock reclaim.

| Flag | Role |
|---|---|
| `--home` | Canonical DSH Home. Absolute. |
| `--bin` (alias `--cli`) | Bound DSH `bin.js`. Adjacent `package.json` must be an exact version. |
| `--node` | Node used to spawn DSH. Pass it explicitly. |
| `--plugin-artifact` | Packed `@dsh-spaces/plugin`. |
| `--view-bridge-artifact` | Packed `@dsh-spaces/view-bridge`. |
| `--llm-bridge-artifact` | Packed `@dsh-spaces/llm-bridge`. Same build group. Third of the three archives. |
| `--control-tool-root` | Tools **outside** `profiles` / `hub` / `sessions` / `storages`. Default sibling `{parent}/.dsh-spaces-tools`. |
| `--snapshot-worker` | Same-group `packages/plugin/lib/supervisor/snapshot-worker.mjs` after `build:spaces`. Required for **normal snapshot create/delete** and remaining tree copy/rename/retarget IO. Runtime install lives in `runtime-installation.ts`; the worker only forwards. This is not restore. |
| `--component-payload` | Immutable selected `lib` directory (product bootstrap sets this). Required. |

Optional: `--port` / `--port 0`; `--snapshot-root` (default sibling of Home; create/list/delete backups only); `--allow-real-home` only for a Home you intend to manage.

The process prints `origin=` and `bootstrap=`. Open `bootstrap=` once locally. It is Node-only: HttpOnly cookie, then 303 to `/`. Do not paste host bearer files or DSH launch tokens into the page.

A manager profile that already has `@dsh-spaces/plugin` can attach to a live Supervisor, or cold-start with the same group. Ordinary workspaces never cold-start a second controller.

## Using the workbench

`/` stays up when `spaces-hub` is stopped **if this Supervisor is still alive**. Manager running: embed the manager. Manager failed: show the real failure. If the Supervisor itself is dead, use stderr / launcher / local logs. There is no watchdog and no rescue page.

Read-only clients can query. They do not acquire the Home lock. Live or unclear owners stay blocked. Spaces does not clear locks.

In the manager UI:

- **启动** / **停止** / **重启** on a space. Restart is a new user command.
- Closing a tab is not shutdown.
- **预览关闭服务** uses `service.shutdown` (preview then execute). That stops the Supervisor after owned work is stopped. It is not desktop Exit.
- Desktop: close window hides to tray; **退出** drops the desktop client and leaves the service running.
- Backups: create / list / preview-delete. No restore action.

Do not document **救援入口**, **需要恢复**, **接管**, **移交写控制权**, **配置恢复**, or **整 Home 恢复** as current capability.

### Errors

Known cause:

```text
空间 coding 启动失败

阶段：加载插件
插件：example-plugin@1.2.3
原因：缺少服务 example.database
退出码：1

该次启动已失败。

查看错误详情    复制脱敏日志
```

Unknown cause: report the observation, unknown root cause, and that the plugin could not be attributed. A plugin error while the host is still alive does not kill the host.

### Jobs and backups

Dangerous work is **preview → confirm plan → execute**. Plans expire in five minutes and are checked again at execute (`serviceEpoch` + `stateRevision`). Job states: `queued` → `running` → `succeeded` / `failed` / `cancelled`. Refresh reads the same job. Interrupted jobs are failed, not replayed.

Batch: first failure ends that batch. Import records definition / plugin install / start separately.

Home backups are ordinary management. `snapshot.restore` and `config.restore` stay unsupported. Do not delete user backups to prove restore is gone.

Runtime **预览安装** / **预览升级** follow official **`latest`**, pin the exact version. A candidate that never becomes current is a failed prepare.

**B5 upgrade in source:** after install of a complete validated candidate, the old service stages the payload and hands the lock to a one-shot launcher (`packages/supervisor/src/launcher.ts`, `--accept-handoff`, job phase `handoff-pending`). Isolated pack/archive and unit tests exist.

**Real acceptance:** use `scripts/verify-plugin-standard-install.mjs`, `scripts/verify-spaces-desktop.mjs`, `scripts/verify-component-update.mjs`, and `scripts/verify-workbench-maintenance-product.mjs`. The [merge acceptance record](../tasks/merge-execution.md) separates source tests, real CLI/browser flows, packaged desktop checks and platform limits. Retired crash/faults/package-upgrade/dual-control scripts fail closed on invocation; they are not current evidence.

### Logs and doctor

Workbench **诊断** is in-app diagnostics. Standalone doctor is **diagnose only** ([packages/doctor/README.md](../packages/doctor/README.md)):

```powershell
node packages/doctor/lib/index.js doctor --home <abs-disposable-home>
```

Production Home: `--home` and `--allow-real-home`. Old recover / unlock / rollback commands are unsupported product surfaces (nonzero exit). Do not document them as how to use doctor.

## What not to do

- Do not `dsh --profile coding` + `dsh plugin add @dsh-spaces/plugin` to get a manager.
- Do not pass `--home`, `--bin`, or tarball paths through the browser.
- Do not point `--snapshot-root` or `--control-tool-root` at `profiles`, `hub`, `sessions`, `storages`, or `.dsh-spaces-restore`.
- Do not mix component artifacts from different builds.
- Do not treat restore, rescue, rollback, retry, lock reclaim, or client take-over as current product actions.

## Related

- [Let it crash](let-it-crash.md)
- [Root README](../README.md)
- [Plugin roles](../packages/plugin/README.md)
- [Supervisor CLI](../packages/supervisor/README.md)
- [Doctor](../packages/doctor/README.md)

---

# DSH Spaces 工作台

> **本分支仍在施工和验收，不是一次发布。** 现行合同：[tasks/merge-contract-v2.md](../tasks/merge-contract-v2.md)。历史恢复文档：[tasks/history-recovery.md](../tasks/history-recovery.md)。

故障政策：[let it crash](let-it-crash.md)。**用户安装：** [plugin-standard-install.md](plugin-standard-install.md)。本包未发布到 npm。

一个 Supervisor 持有 Home 运行权。协议版本 **2**，变更带 epoch 与 revision。没有公开的接管/释放运行权或恢复命令。关标签或退出桌面客户端不停止服务。停止全部空间和 `service.shutdown` 是两个操作。

构建清单覆盖五组件。启动需要 `--component-payload`、同组三份制品（plugin / view-bridge / llm-bridge）以及同组 `--snapshot-worker`（正常快照 create/delete 与树拷贝 IO）。运行时安装已抽到 `runtime-installation.ts`，worker 只转发。组件升级通过一次性 launcher 交接，只有新管理器就绪才确认成功；真实流程和构建证据见 [合并验收记录](../tasks/merge-execution.md)。

管理 UI 里用预览关闭服务来停 Supervisor。桌面退出只销毁客户端。备份可创建、查看、删除，不能恢复。Doctor 只诊断。不要把接管、救援、回滚写成当前能力。
