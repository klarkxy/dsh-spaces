# @dsh-spaces/supervisor

> This is a private, unpublished package distributed inside the Spaces plugin tarball. User flows: [docs/workbench.md](../../docs/workbench.md). Current architecture baseline: [docs/architecture.md](../../docs/architecture.md). Fault policy: [docs/let-it-crash.md](../../docs/let-it-crash.md).

Independent workbench supervisor. It binds `127.0.0.1`, holds Home run rights, and serves the stable entry plus the management API.

This package is Node-only. Browser callers never receive filesystem paths, CLI commands, child launch tokens, or the Node management credential.

The supervisor manages **normal** operations: bind locally, authenticate, enforce single-writer, run user commands, query real state, start/stop spaces the user asked for. It does not resurrect a failed manager, reinstall dependencies, rebuild identity, auto-take-over, restore run rights, or enter rescue mode.

Public restore APIs fail explicitly. The snapshot worker is required for normal snapshot create/delete and the remaining tree copy/rename/retarget IO; runtime installation is a separate step. That is not restore.

中文见 [中文](#中文)。

## What it starts

- Dedicated manager profile `spaces-hub` (or `spaces-hub-N`). Existing ordinary profiles are attached in place; an ordinary profile already using the reserved name is **not** overwritten.
- The manager plugin on the manager only; the view bridge on ordinary spaces.
- Stable entry at `origin`. Closing a tab does not stop spaces or the Supervisor. A Supervisor launched by the official Desktop follows that Desktop: when the Desktop host process ends, the Supervisor performs one normal shutdown (stops the spaces it owns, releases run rights, exits). If that shutdown fails it stays as it is with run rights kept; it is not force-killed or retried. A Supervisor launched by Web is unaffected, and attaching from Desktop does not change an existing Supervisor's lifetime. Stopping the manager does not stop this process — if the entry is still alive it can show the manager’s real failure (**查看错误详情**, **复制脱敏日志**). If this process itself dies, use stderr / existing logs. There is no watchdog.
- One writer per Home. A second client attaches to a healthy existing service. Live or unclear owners are refused. There is no take-over.

New installations pin official DSH **`0.2.1-rc.2`**; existing runtimes require an explicit upgrade. Any exact installed CLI can bind. This repo builds against SDK `0.2.1-rc.2`; plugin peers retain their existing lower bound and explicitly admit this prerelease, rather than defining a CLI allowlist. Unregistered manual DSH is not discovered — [external discovery](../../tasks/workbench-external-discovery.md).

The manager plugin follows the host plugin: at startup the Supervisor aligns the manager's installed plugin with the bound component group, and alignment failure blocks the manager from starting. Ordinary spaces receive the group's bridge when they do not have one yet; an already-installed space bridge is **not** automatically re-aligned to the current group, and the actual bridge state must be shown rather than assumed.

Spaces are upgraded through the host plugin: update the Spaces plugin in the host, shut the service down from the manager UI, then reopen Spaces. There is no in-app self-update and no automatic component handoff.

## Launch (runnable local build)

Compile from the repository root with `npm run build:spaces`. Pack the plugin, view-bridge, Browser and LLM-bridge archives **outside** those package trees, and use a **disposable** Home for development — do not pass `--allow-real-home` and do not point `--home` at `~/.dsh`.

```powershell
npm run build:spaces
npm pack ./packages/plugin --ignore-scripts --pack-destination D:\dsh-packages
npm pack ./packages/view-bridge --ignore-scripts --pack-destination D:\dsh-packages
npm pack ./packages/browser --ignore-scripts --pack-destination D:\dsh-packages
npm pack ./packages/llm-bridge --ignore-scripts --pack-destination D:\dsh-packages

node packages/plugin/lib/supervisor/index.js `
  --home D:\dsh-workbench-dev\home `
  --bin D:\path\to\@deepseek-ai\dsh\lib\bin.js `
  --node D:\path\to\node.exe `
  --plugin-artifact D:\dsh-packages\dsh-spaces-plugin-0.5.0.tgz `
  --view-bridge-artifact D:\dsh-packages\dsh-spaces-view-bridge-0.5.0.tgz `
  --browser-artifact D:\dsh-packages\dsh-spaces-browser-0.4.0.tgz `
  --llm-bridge-artifact D:\dsh-packages\dsh-spaces-llm-bridge-0.5.0.tgz `
  --control-tool-root D:\dsh-workbench-dev\tools `
  --component-payload <absolute-component-payload-directory> `
  --snapshot-worker <absolute-snapshot-worker-file> `
  --snapshot-root D:\dsh-workbench-dev\snapshots
```

Do not omit `--plugin-artifact`, `--view-bridge-artifact`, `--browser-artifact`, `--llm-bridge-artifact`, `--component-payload`, `--node`, `--snapshot-worker`, or `--control-tool-root`. Mix-and-match archives from different builds fail closed. `--bin` must be an exact CLI (`--cli` is an alias). Paths must be absolute. The browser must not be asked to supply them. There is no automatic repair or retry.

Ordinary workspaces only attach; they do not cold-start a second controller. A failed initialization ends that request; the next page open does not silently complete it.

## Flags (all Node-only paths)

| Flag | Meaning |
|---|---|
| `--home` | Canonical DSH home. Required. Refuses `~/.dsh` unless `--allow-real-home`. |
| `--bin` / `--cli` | Selected DSH `bin.js`. Version from the adjacent package.json; must be an exact version. |
| `--node` | Node executable used to spawn DSH. Pass explicitly. |
| `--port` | Listen port. Omit to reuse the saved entry port. `0` picks an ephemeral port. Always `127.0.0.1`. |
| `--control-tool-root` | Toolchain / payload copies outside trees the current binary still treats as replaceable. Product cold start uses a sibling directory of the Home. |
| `--supervisor-asset-root` | Optional static assets for the stable entry. |
| `--plugin-artifact` | File path of the packed manager plugin for the manager profile. Required. |
| `--view-bridge-artifact` | File path of the packed view bridge for ordinary spaces. Required. |
| `--browser-artifact` | File path of the packed Browser plugin. Required. Same build group. |
| `--llm-bridge-artifact` | File path of the packed LLM bridge. Required. Same build group. |
| `--component-payload` | Selected component directory of the same group. Required for product cold start. |
| `--snapshot-worker` | Same-group worker for snapshot create/delete and remaining tree IO. Runtime installation is extracted; the worker only forwards. Not restore. |
| `--exit-with-host` | No value. Passed only by the Desktop host, paired with an IPC channel. |
| `--snapshot-root` | Directory the current binary may still use for snapshot files. Must stay outside `profiles` / `hub` / `sessions` / `storages`. Applying snapshots as disaster recovery is revoked. |
| `--allow-real-home` | Flag with no value. Opt in for a Home you intend to manage. |

## Launch options

A Home you already use (writes that Home — not a tutorial) needs `--allow-real-home --home <abs-your-home>` plus the same artifact / worker / tools flags, with tools and snapshots **outside** trees the current binary still treats as replaceable. `--allow-real-home` authorizes this process only.

Omit `--port` to reuse the saved entry port when valid; `--port 0` always takes a new ephemeral port. The entry always binds `127.0.0.1`.

## Entry and authentication

stdout (only):

```
origin=http://127.0.0.1:<port>
bootstrap=http://127.0.0.1:<port>/bootstrap/<one-time-token>
```

Open `bootstrap=` once locally. It sets an HttpOnly SameSite=Strict cookie scoped to the loopback authority and 303s to `/`. `bootstrap=` is Node-only; do not put it in browser DTOs.

- Browser: one-time bootstrap exchange or `/?token=` → HttpOnly SameSite=Strict cookie → 303 `/`.
- Manager host: a Node-only management credential kept in the Home's control area. It is never copied into browser DTOs.
- Origins: the supervisor entry and the live manager origin. Ordinary workspace origins are rejected for management APIs. No arbitrary URL proxy.

The supervisor also records a private endpoint document in the Home's control area for host attach. It is bound to the Home identity, the public service epoch, the protocol version and the Node credential. Older or unrecognized endpoint documents are refused. Release deletes this process's endpoint only.

## Build

Build from the repository root with `npm run build:spaces`.

---

# 中文

独立工作台监督进程，只绑 `127.0.0.1`。完整可运行命令见上方 **Launch**，包含 plugin / view-bridge / Browser / llm-bridge / node / worker / tools，缺一不可。当前架构基线见 [docs/architecture.md](../../docs/architecture.md)。故障政策见 [docs/let-it-crash.md](../../docs/let-it-crash.md)。

开发用一次性 Home，不要加 `--allow-real-home`，不要指向 `~/.dsh`。管理你已经在用的 Home 时才同时给绝对 `--home` 和 `--allow-real-home`。快照目录必须在 Home 之外；启动需要 `--component-payload`、四份同组制品和同组 worker（正常快照与树 IO）。这不是恢复产品。没有自动修复或重试。

关闭标签不会停止空间或 Supervisor。由官方 Desktop 启动的 Supervisor 跟随该 Desktop 退出：Desktop 宿主进程结束时，Supervisor 执行一次正常关闭（停止它管理的空间、释放运行权后退出）；关闭失败时保持原样并保留运行权，不强杀、不重试。由 Web 启动的 Supervisor 不受影响；Desktop 附着到已有 Supervisor 时不改变它的生命周期。管理 profile 停掉后，入口若仍在线只显示真实失败，不提供救援页或“检查并恢复”。浏览器不得提交这些路径。新安装默认固定官方 `0.2.1-rc.2`；已有运行时通过正常升级操作更新。未登记的手工 DSH 不会被接管。

管理插件在管理器启动前与当前组件组对齐，对齐失败即阻止管理器启动。普通空间只在缺少桥接时获得随组桥接；既有空间桥接不会自动重新对齐，界面必须据实展示桥接状态。

升级走宿主插件：更新宿主中的 Spaces 插件 → 在管理工作台停止服务 → 重新打开 Spaces。没有应用内自我更新，也没有自动组件交接。
