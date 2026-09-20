# @dsh-spaces/plugin

> **This branch is still under construction and acceptance. It is not a release.** How to run the workbench: [docs/workbench.md](../../docs/workbench.md).

This package is the **manager** Host plugin. The supervisor installs it only on the dedicated `spaces-hub` profile (or `spaces-hub-N` if that name is taken). Ordinary workspaces must not get this package as their “Spaces install.”

On a manager profile it replaces the DSH root with the 72px workbench (iframes, lifecycle, plugins, snapshots, runtime). On any other profile it is **guide-only**: a sidebar entry **返回工作台** / **Return to workbench**. No second rail, no recursive manager.

The Host performs filesystem and CLI work. The browser receives typed business data only — never disk paths, CLI argv, host bearer, cookies, or launch tokens.

中文见 [中文](#中文)。

## Product roles

| Profile | What this package does |
|---|---|
| Manager (`spaces-hub` …) | Workbench UI + write remotes, proxied to the supervisor on `127.0.0.1`. |
| Ordinary workspace | If this package is present at all, guide-only return-to-workbench. The intended package there is `@dsh-spaces/view-bridge`. |
| Uninitialized / damaged identity | Guide remotes only. No lock clear, no second controller. |

Recommended path: start `@dsh-spaces/supervisor` (or packaged desktop) so **it** creates the manager profile and installs this tarball plus view-bridge. See [docs/workbench.md](../../docs/workbench.md).

**Not recommended:** `dsh plugin --profile coding add …dsh-spaces-plugin-0.2.0.tgz` as the way to obtain management. That is the old preview habit and a misinstall on an ordinary space.

## Build the tarball (local)

From the repository root. Pack **outside** this package (the Host refuses sources that already contain a tarball):

```powershell
npm ci
npm run typecheck:spaces
npm run build:spaces
npm pack ./packages/plugin --ignore-scripts --pack-destination D:\dsh-packages
npm pack ./packages/view-bridge --ignore-scripts --pack-destination D:\dsh-packages
```

Pass those tarballs to the supervisor as `--plugin-artifact` and `--view-bridge-artifact`. The browser cannot supply those paths.

`dsh.bundle.patch` (`./cordis.patch.yml`) makes a real `dsh plugin add` append this package to `dsh.profile.bundles` and compose `id: dsh-spaces`. Do not add a second Loader `insert`. Do not treat a manual extract or a directory junction as an install.

## Misinstall and recovery

If an ordinary space already has `@dsh-spaces/plugin`:

1. Open it: you should only see **返回工作台**. That button hands you to the authenticated stable entry; it does not start a second supervisor from a workspace.
2. From a writable workbench: **清理误装的完整 Spaces** (preview first).
3. If the workbench cannot load, official CLI removal is a limitation/recovery path — not the new install path:

```powershell
dsh plugin --profile <ordinary-space> remove @dsh-spaces/plugin
```

On Windows, CLI `0.1.5-rc.1` forwards `dsh plugin add` through a shell that does not preserve path quoting. If you must add a tarball by hand, put it on an absolute path **without spaces or shell metacharacters**. Outer quotes alone do not fix forwarding. `dsh plugin` runs `pnpm` with cwd = the profile directory, so a relative `./….tgz` is resolved against the profile, not the shell cwd. Workbench templates set `autoInstallPeers: false`; keep `--config.auto-install-peers=true` so Host peers resolve **only when you are doing this recovery add**.

Development and acceptance use a disposable `DSH_HOME`. Installation changes the selected profile's plugin set. No registry publication is required for a local tarball.

A local tarball install records a `file:` spec in the profile `package.json`. Path-like specs are hidden from the plugin list, so the panel version can show as unknown even though this package.json is `0.2.0`.

## What the manager can do

When this profile **is** the manager and the supervisor holds write access:

- Space rail, start / stop / restart, create / rename / icon / sort / delete (preview where required). `web` and the manager space are protected.
- Plugin search, install onto a **workspace**, remove, config backup restore. Catalog id + exact version only. Not a hot switch.
- Whole-Home snapshot create / restore / delete (spaces stay stopped after snapshot).
- Runtime preview install / upgrade, still gated to CLI `0.1.5-rc.1`.
- Dual-control: **释放写控制权** / **预览关闭**. Closing the tab is not shutdown.
- Cleanup of a full Spaces install on an ordinary workspace.

Closing the manager process does not take down the supervisor. The stable entry stays on `127.0.0.1` for **接管运行权** / **检查并恢复**.

Still in acceptance on this branch (do not document as done): final runtime upgrade and kill-fault recovery, official CLI `0.1.5-rc.2`, **manager plugin self-upgrade**, final video. SDK `0.1.5-rc.2` is the Host peer, not CLI 2. Isolated candidate packages are not a user bypass.

The verified write target is CLI `0.1.5-rc.1` with installed `0.1.5-rc.2` SDK contracts. Version matching alone does not grant write permission.

## snapshotRoot (Node only)

`SpacesHost` still accepts optional Host config `snapshotRoot` and the runtime forwards it to supervisor bootstrap. It is **not** a browser field. The product default is the supervisor sibling directory `{parent}/{homeName}-snapshots`. If you set it, it must be a real absolute directory outside snapshot-replaced Home entries (`profiles`, `hub`, `sessions`, `storages`, `.dsh-spaces-restore`). Relative paths, symlinks, and junctions are rejected.

Do not hand-edit `cordis.patch.yml` overlays as the install path. Pass `--snapshot-root` on the supervisor CLI.

## Architecture

`src/core` holds shared isolation/registry rules and maintenance/recovery application logic. Node adapters provide filesystem, process and lock access. The plugin always registers `workbenchGuide`. `workbench` write remotes and compatibility `spaces` reads register only when `HomeController.roleOf(current profile)` is manager.

Ordinary spaces use `@dsh-spaces/view-bridge` (handshake only, no management). Desktop, plugin, supervisor and doctor use the same per-home operation lock. Ordinary external `dsh` commands do not participate. Unregistered manual DSH processes are not taken over — [external discovery](../../tasks/workbench-external-discovery.md).

Browser bundles use DSH's module loader and its React instance. They contain neither Electron nor Node adapters.

## Recovery

Use standalone `@dsh-spaces/doctor` when the plugin cannot load. See [packages/doctor/README.md](../doctor/README.md). A dead owner's lock requires an explicit unlock command; incomplete or ambiguous ownership remains blocked. Whole-Home restore is a supervisor / doctor operation, not a browser path.

---

# 中文

> **本分支仍在施工验收，不是发布。** 可运行流程见 [docs/workbench.md](../../docs/workbench.md)。

本包是**管理 profile** 用的 Host 插件，由监督进程装到专用 `spaces-hub`（重名则加后缀）。不要把它装进普通 `coding` 工作空间来「获得 Spaces 管理」——那是误装，该空间只会显示 **返回工作台**。普通空间应装 `@dsh-spaces/view-bridge`。

从仓库根目录 `npm run build:spaces`，再把 plugin 与 view-bridge 的 tarball 打到包外目录，交给监督进程的 `--plugin-artifact` / `--view-bridge-artifact`。浏览器不能提交这些路径。

误装恢复：工作台「清理误装的完整 Spaces」，或在工作台无法加载时 `dsh plugin --profile <普通空间> remove @dsh-spaces/plugin`。手工 `dsh plugin add` 只是限制/恢复手段，不是新架构安装路径。Windows CLI `0.1.5-rc.1` 对带空格路径的 `add` 转发不可靠。

写门禁仍是 CLI `0.1.5-rc.1`。SDK `0.1.5-rc.2` 不是 CLI 2。管理插件自身升级尚未交付。关标签不停监督进程；设置里的「释放写控制权」「预览关闭」才是移交和停机。
