# @dsh-spaces/supervisor

> **This branch is still under construction and acceptance. It is not a release.** User flows: [docs/workbench.md](../../docs/workbench.md). Fault policy: [docs/let-it-crash.md](../../docs/let-it-crash.md).

Independent workbench supervisor. It binds `127.0.0.1`, holds Home run rights, and serves the stable entry plus `POST /api/workbench/<method>`.

This package is Node-only. Browser callers never receive filesystem paths, CLI commands, child launch tokens, or the host bearer.

The supervisor manages **normal** operations: bind locally, authenticate, enforce single-writer, run user commands, query real state, start/stop spaces the user asked for. It does not resurrect a failed manager, reinstall dependencies, rebuild identity, auto-take-over, restore run rights, or enter rescue mode.

Public restore APIs fail explicitly. `--snapshot-worker` is still required for the current runtime-install / long-IO path.

中文见 [中文](#中文)。

## What it starts

- Dedicated manager profile `spaces-hub` (or `spaces-hub-N`). Existing ordinary profiles are attached in place; an ordinary profile already using the reserved name is **not** overwritten.
- `@dsh-spaces/plugin` on the manager only; `@dsh-spaces/view-bridge` on ordinary spaces.
- Stable entry at `origin`. Closing a browser tab does not stop instances. Stopping the manager does not stop this process — if the entry is still alive it can show the manager’s real failure (**查看错误详情**, **复制脱敏日志**). If this process itself dies, use stderr / launcher / existing logs. There is no watchdog.
- One writer per Home. Desktop on the same Home stays read-only until it takes over. Live or unclear owners are refused.

Default DSH channel is official **`latest`**, pinned to the resolved exact version. Any exact installed CLI can bind. SDK `0.1.5-rc.2` is this repo's plugin peer, not a CLI allowlist. Unregistered manual DSH is not discovered — [external discovery](../../tasks/workbench-external-discovery.md). Manager plugin self-upgrade is not delivered yet.

## Launch (runnable local build)

Compile from the repository root with `npm run build:spaces` (writes `packages/supervisor/lib/index.js`, `snapshot-worker.mjs`, `manifest.json`). Then pack plugin and view-bridge **outside** those packages. Use a **disposable** Home for development — do not pass `--allow-real-home` and do not point `--home` at `~/.dsh`.

```powershell
npm run build:spaces
npm pack ./packages/plugin --ignore-scripts --pack-destination D:\dsh-packages
npm pack ./packages/view-bridge --ignore-scripts --pack-destination D:\dsh-packages

node packages/supervisor/lib/index.js `
  --home D:\dsh-workbench-dev\home `
  --bin D:\path\to\@deepseek-ai\dsh\bin.js `
  --node D:\path\to\node.exe `
  --plugin-artifact D:\dsh-packages\dsh-spaces-plugin-0.3.0.tgz `
  --view-bridge-artifact D:\dsh-packages\dsh-spaces-view-bridge-0.3.0.tgz `
  --control-tool-root D:\dsh-workbench-dev\tools `
  --snapshot-worker <abs-repo>\packages\supervisor\lib\snapshot-worker.mjs `
  --snapshot-root D:\dsh-workbench-dev\snapshots
```

Do not omit `--plugin-artifact`, `--view-bridge-artifact`, `--node`, `--snapshot-worker`, or `--control-tool-root`. Without the two tarballs the manager profile cannot finish installing and ordinary iframes have no handshake. `--bin` must be a supported CLI (`--cli` is an alias). Paths must be absolute. The browser must not be asked to supply them.

Prefer `packages/supervisor/lib/index.js` after `build:spaces`. Running the TypeScript entry with plain `node` will not compile.

Package bin name after install: `dsh-spaces-workbench` → `lib/index.js`.

stdout (only):

```
origin=http://127.0.0.1:<port>
bootstrap=http://127.0.0.1:<port>/bootstrap/<one-time-token>
```

Open `bootstrap=` once locally. It sets HttpOnly SameSite=Strict cookie `dsh-auth-<sha256(127.0.0.1:port)>` and 303s to `/`. `bootstrap=` is Node-only; do not put it in browser DTOs.

A Home you already use (writes that Home — not a tutorial):

```
--allow-real-home --home <abs-your-home>
```

plus the same artifact / worker / tools flags, with tools and snapshots **outside** trees the current binary still treats as replaceable. `--allow-real-home` authorizes this process only.

Omit `--port` to reuse `{home}/.dsh-spaces-control/entry-port.json` when valid. `--port 0` always takes a new ephemeral port. Always `127.0.0.1`.

Same process API:

```ts
import { createWorkbenchSupervisor, parseSupervisorArgs, supervisorCliArgs } from "@dsh-spaces/supervisor";

const handle = await createWorkbenchSupervisor({
  home,
  bin,
  nodeExe,
  // omit port to reuse entry-port.json; pass 0 for a new port
  controlToolRoot,
  pluginArtifact,
  viewBridgeArtifact,
  snapshotWorkerFile,
  snapshotRoot,
});
// handle.origin is a clean http://127.0.0.1:<port>
// handle.bootstrapUrl is a one-time Node-only bootstrap; do not put it in DTOs
await handle.close();
```

`supervisorCliArgs(options)` rebuilds the argv for a child spawn (`--bin`, not `--cli`).

A manager Host that already has this plugin attached will spawn the same argv (see `packages/plugin/src/host/supervisor-bootstrap.ts`): `--home --bin --node --plugin-artifact --view-bridge-artifact --control-tool-root --snapshot-worker` and optional `--snapshot-root` / `--allow-real-home`. Ordinary workspaces only attach; they do not cold-start a second controller. A failed initialization ends that request; the next page open does not silently complete it.

## Flags (all Node-only paths)

| Flag | Meaning |
|---|---|
| `--home` | Canonical DSH home. Required. Refuses `~/.dsh` unless `--allow-real-home`. |
| `--bin` / `--cli` | Selected DSH `bin.js`. Version from the adjacent package.json; must be an exact version. |
| `--node` | Node executable used to spawn DSH. Pass explicitly. |
| `--port` | Listen port. Omit to reuse saved `entry-port.json`. `0` picks an ephemeral port. Always `127.0.0.1`. |
| `--control-tool-root` | Toolchain / payload copies outside trees the current binary still treats as replaceable. Product cold start uses `{parent(home)}/.dsh-spaces-tools`. |
| `--supervisor-asset-root` | Optional static assets for the stable entry. |
| `--plugin-artifact` | File path of packed `@dsh-spaces/plugin` for the manager profile. Required for manager bootstrap. |
| `--view-bridge-artifact` | File path of packed `@dsh-spaces/view-bridge` for ordinary spaces. Required for iframe handshake. |
| `--snapshot-worker` | `snapshot-worker.mjs` used for current runtime install and long IO. Not a restore product. Required until R4. |
| `--snapshot-root` | Directory the current binary may still use for snapshot files. Default: sibling `{parent}/{homeName}-snapshots` (not inside Home). Must stay outside `profiles` / `hub` / `sessions` / `storages` / `.dsh-spaces-restore`. Applying snapshots as disaster recovery is revoked. |
| `--allow-real-home` | Flag with no value. Opt in for a Home you intend to manage. |

Root build/manifest wiring is owned by the integrating agent. This package does not rewrite the desktop Electron entry.

## Auth

- Browser: one-time `/bootstrap/<token>` or `/?token=` → HttpOnly SameSite=Strict cookie named `dsh-auth-<sha256(127.0.0.1:port)>` → 303 `/`.
- Manager host proxy: bearer in `{home}/.dsh-spaces-control/host.bearer`. Never copied into browser DTOs.
- Origins: supervisor entry and the live manager origin. Ordinary workspace origins are rejected for management APIs. No arbitrary URL proxy.

Private `{home}/.dsh-spaces-control/endpoint.json` is `{version:1,origin,bearer}` for Host attach. Release deletes this process's endpoint only.

## Build need

`npm run build:spaces` from the repository root compiles `packages/supervisor/src/index.ts` to `packages/supervisor/lib/index.js` the same way as `@dsh-spaces/doctor`. Root `package.json` / tsconfig / electron-builder files are not owned by this leaf.

---

# 中文

独立工作台监督进程，只绑 `127.0.0.1`。完整可运行命令（含 plugin / view-bridge / node / worker / tools，缺一不可）见 [docs/workbench.md](../../docs/workbench.md)。故障政策见 [docs/let-it-crash.md](../../docs/let-it-crash.md)。

开发用一次性 Home，不要加 `--allow-real-home`，不要指向 `~/.dsh`。管理你已经在用的 Home 时才同时给绝对 `--home` 和 `--allow-real-home`。默认快照目录是 Home 的兄弟 `{上一级}/{Home名}-snapshots`，不是 Home 内部文件夹。当前启动仍需要 `--snapshot-worker`，因为它同时承担运行时安装；这不是恢复产品。

关标签不停实例；管理 profile 停掉后，入口若仍在线只显示真实失败，不提供救援页或“检查并恢复”。浏览器不得提交这些路径。默认跟随官方 `latest` 并钉住精确版本。未登记的手工 DSH 不会被接管。
