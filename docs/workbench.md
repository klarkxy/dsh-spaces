# DSH Spaces workbench

> **This branch is still under construction and acceptance.** It is not a release. Do not treat these pages as a published product, and do not treat a local build as a way around the official CLI gate.

**User install (ordinary Web):** [plugin-standard-install.md](plugin-standard-install.md) — `pnpm run pack:plugin`, then `dsh plugin --profile web add` of that tarball, `dsh web`, **初始化 Spaces**. That is the intended path, not a misinstall. Installing the full plugin onto `coding` / `notes` still is. The package is not on npm.

The workbench is a local supervisor on `127.0.0.1` plus a dedicated manager profile. Ordinary workspaces keep their data and get a lightweight view bridge. They do not become a second Spaces manager.

Chinese: [中文](#dsh-spaces-工作台).

## What you get

- An independent supervisor process. Closing a browser tab does not stop spaces. Stopping the manager profile does not stop the supervisor; the same origin stays up as a rescue / maintenance page.
- A dedicated manager profile named `spaces-hub` (or `spaces-hub-2`, … if that name is already taken). Existing profiles are attached in place. Spaces does not overwrite an ordinary profile that already uses the reserved name.
- A 72px space rail. Each workspace runs in its own iframe origin. Drafts, scroll, and the last confirmed selection stay until a new view is ready. Failed starts keep the previous space.
- Ordinary spaces install `@dsh-spaces/view-bridge` only. If someone installs the full `@dsh-spaces/plugin` there, that space only offers **Return to workbench**. It does not recursively host another manager.
- One writer per Home. Desktop and Web can share the same Home; the other side stays read-only until you take over.
- Long jobs persist across refresh. Whole-Home snapshots, plugin install/remove, config restore, and doctor recovery are available as described below. Some upgrade and crash paths are still in acceptance.

Official write gate: DSH CLI **`0.1.5-rc.1` and `0.1.5-rc.2`**. The plugin peers on SDK `0.1.5-rc.2`; that is not “CLI 2”. Isolated candidate builds are a verification channel for this repo, not a user tutorial for bypassing the gate.

## Still being accepted

Already exercised on this branch (isolated Homes, not a release): two workspace iframes and a stable entry after the manager stops; 竹青 / EternalNight / an explicit 0.1.1 XP adapter with inner chat; draft keep, fast last-click, create / rename / icon / sort / restart / delete / refresh selection; packaged `win-unpacked` desktop and Web dual-control (read-only vs take-over); plugin install / remove / config restore; one whole-Home snapshot restore.

Not complete — do not document these as done:

- Final runtime upgrade, kill-fault recovery, and full rollback
- Compatibility beyond the explicitly supported rc.1 and rc.2
- Manager plugin self-upgrade (runtime / whole-Home maintenance is not that)
- Final regression matrix and a new intro video
- Catppuccin: the original theme still fails because of missing dependencies. That is not wrapped as a Spaces fix.

Unregistered DSH processes that were never started by this supervisor are not reliably discovered. The supervisor does not take over “every DSH on this machine.” See [external discovery](../tasks/workbench-external-discovery.md).

## Isolated Home vs your Home

| | Development / local try | Product Home you already use |
|---|---|---|
| Purpose | Disposable directory. Safe to create, snapshot, and delete. | A Home you chose, often `~/.dsh` in a packaged desktop app. |
| How to point | Absolute `--home` **without** `--allow-real-home`. Unpackaged `npm run dev` uses `.sandbox/dsh-home`. | Packaged desktop defaults to `~/.dsh`. Supervisor / doctor need `--home <abs>` **and** `--allow-real-home`. |
| Do not | Point experiments at `~/.dsh` or copy over production `settings.yaml`. | Use production as a tutorial Home, or skip `--allow-real-home` and hope the guard is off. |

Unpackaged desktop and tests refuse the real `~/.dsh` unless the process is explicitly authorized. Paths on the supervisor CLI stay on the Node process. The browser never submits filesystem paths, CLI commands, or launch tokens.

## Build, pack, start (from this repo)

Run these from the repository root after `npm install`. `npm run build:spaces` writes `packages/*/lib`. Pack **outside** the package trees (never into `packages/plugin`).

PowerShell (use directories **without spaces** for the tarballs; keep every path absolute):

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

# --bin must be the selected DSH CLI bin.js whose adjacent package.json is 0.1.5-rc.1 or 0.1.5-rc.2
node packages/supervisor/lib/index.js `
  --home $spacesHome `
  --bin C:\path\to\@deepseek-ai\dsh\lib\bin.js `
  --node "$env:ProgramFiles\nodejs\node.exe" `
  --plugin-artifact $artifacts\dsh-spaces-plugin-0.2.0.tgz `
  --view-bridge-artifact $artifacts\dsh-spaces-view-bridge-0.2.0.tgz `
  --control-tool-root $tools `
  --snapshot-worker "$(Resolve-Path packages\supervisor\lib\snapshot-worker.mjs)" `
  --snapshot-root $snapshots
```

Required for a working manager and iframe handshake:

| Flag | Why it is required |
|---|---|
| `--home` | Canonical DSH Home. Absolute. |
| `--bin` (alias `--cli`) | Bound DSH `bin.js`. Write gate accepts `0.1.5-rc.1` and `0.1.5-rc.2`. |
| `--node` | Node used to spawn DSH. If omitted the supervisor falls back to `process.execPath`; pass it anyway so the CLI you intend is the one that runs. |
| `--plugin-artifact` | Packed `@dsh-spaces/plugin` tarball. Without it, manager bootstrap cannot finish. |
| `--view-bridge-artifact` | Packed `@dsh-spaces/view-bridge` tarball. Ordinary spaces need this for the iframe handshake. |
| `--control-tool-root` | Toolchain / copies **outside** snapshot-replaced Home trees (`profiles`, `hub`, `sessions`, `storages`, …). Product bootstrap uses a sibling of Home, defaulting to `{parent}/.dsh-spaces-tools`. |
| `--snapshot-worker` | `packages/supervisor/lib/snapshot-worker.mjs` after `build:spaces`. Maintenance and runtime install run here, not in the snapshot-replaced tree. |

Optional:

- `--port` omitted: reuse `{home}/.dsh-spaces-control/entry-port.json` when it is valid; first listen still binds `127.0.0.1`. `--port 0` always asks the OS for a new port.
- `--snapshot-root`: default is the sibling `{parent}/{homeName}-snapshots`, not a folder inside Home.
- `--allow-real-home`: only when `--home` is a Home you intend to manage (including `~/.dsh`). Never add this to a disposable experiment.
- `--supervisor-asset-root`: static files for the stable entry. Not needed for the default page.

The process prints:

```
origin=http://127.0.0.1:<port>
bootstrap=http://127.0.0.1:<port>/bootstrap/<one-time-token>
```

Open `bootstrap=` once in a local browser. That URL is Node-only: it sets an HttpOnly cookie named `dsh-auth-<sha256(127.0.0.1:port)>` and 303s to `/`. Do not paste host bearer files or DSH launch tokens into the page. After that, `/` is the stable entry.

To attach to a Home you already use (not a tutorial — this writes that Home):

```powershell
node packages/supervisor/lib/index.js `
  --allow-real-home `
  --home $env:USERPROFILE\.dsh `
  --bin <abs-supported-dsh-bin.js> `
  --node <abs-node.exe> `
  --plugin-artifact <abs>\dsh-spaces-plugin-0.2.0.tgz `
  --view-bridge-artifact <abs>\dsh-spaces-view-bridge-0.2.0.tgz `
  --control-tool-root <abs-tools-outside-that-home> `
  --snapshot-worker <abs>\packages\supervisor\lib\snapshot-worker.mjs `
  --snapshot-root <abs-snapshots-outside-replaced-trees>
```

`--allow-real-home` authorizes **this process** for that Home. It does not change OS permissions or rewrite global config by itself.

A manager profile that already has `@dsh-spaces/plugin` can attach to a live supervisor, or cold-start one with the same flags (the Host packs tarballs into the tools directory). Ordinary workspaces never cold-start a second controller.

## Using the workbench

### Stable entry

`/` stays up even when `spaces-hub` is stopped.

- Manager running: the entry embeds the manager. Banner **工作台入口在线**.
- Manager stopped or in maintenance: **救援入口** / **维护中** / **需要恢复**. Buttons: **接管运行权**, **检查并恢复**, **刷新**. Copy on the page: the supervisor does not exit with the manager profile; closing the tab does not stop started workspaces.
- Read-only: **只读。接管前不会安装或启动管理环境。** Take-over is explicit. The page does not steal a live owner.

Inside the manager UI (default Chinese):

- **启动** / **停止** / **重启** on a space. Stop timeouts keep the instance record; they do not silently force-kill.
- Closing the browser tab is not shutdown.
- **设置 → 释放写控制权** (preview `controller.release`) hands the Home to the other end.
- **设置 → 预览关闭** (preview `controller.shutdown`) stops the supervisor. Confirm the plan first.
- Recovery overlay: **接管写控制权**, **恢复中断的工作**.

### Space rail (72px)

Left rail is 72px. Click starts a space if you hold write access. The last click wins; the previous ready iframe stays visible until the new one is ready. Create does not auto-switch. Rename, icon, sort, restart, and delete go through preview/confirm where the UI asks for a plan.

`web` stays the official root profile (no isolation patch). The manager profile is protected: no ordinary plugins or themes, no delete through space actions.

### Desktop + Web, same Home

One Home, one writer.

| Surface | Holding write | Other side |
|---|---|---|
| Desktop title | **桌面正在控制此 Home** / **移交** | **只读 — Web 工作台正在控制此 Home** or **只读 — 另一桌面实例正在控制此 Home**; **接管** |
| Web workbench | Writable until you **释放写控制权** | **只读。仍可查询；取得运行权后才能改动。** |
| Stable entry | **当前进程持有运行权** | **接管运行权** (disabled if already writable here) |

Take-over only works when no one holds the lease and ownership is not ambiguous. A dead recorded owner can be reclaimed from the entry; live or unclear owners are not guessed away.

Desktop: closing the window hides to the tray; **退出** stops spaces this desktop started. That is separate from Web tab close.

### Plugins, themes, misinstall

Install onto a chosen **workspace** from the workbench Plugins page: catalog id + exact version, then **预览安装**. This is not a hot switch; a running space may need **重启**.

The initial ordinary Web profile uses the full plugin as its workbench entry. After initialization, managed spaces such as `coding` need only view-bridge; installing the full plugin in those spaces is a misinstall. The space then only shows **返回工作台** / **Return to workbench**.

Cleanup from a writable workbench: **清理误装的完整 Spaces** (preview first). If the workbench cannot load, the recovery-only CLI path is:

```powershell
# Limitation / recovery — not the install path for the new architecture
# On Windows CLI 0.1.5-rc.1, put the tarball on an absolute path with no spaces if you must add; quotes are not enough for dsh plugin add.
dsh plugin --profile <ordinary-space> remove @dsh-spaces/plugin
```

`dsh plugin add` of a local tarball is the same class of recovery/limitation: the profile cwd is the profile directory, so the tarball path must be absolute. Do not treat a folder junction or a manual extract as an install.

Themes: 竹青 and EternalNight have been shown in an isolated Home. Original XP 0.1.1 draws a nested desktop unless the explicit adapter is applied; inner chat works with that adapter. Original Catppuccin still fails on missing dependencies.

### Long jobs and whole-Home maintenance

Dangerous work is **preview → confirm plan → execute**. Plans expire in five minutes and are checked again at execute. Cancel is only for queued / still-reversible phases.

**创建整 Home 快照** stops running spaces, snapshots the Home, and **leaves spaces stopped**. Restore is also previewed. After restore the manager may come back while ordinary spaces stay stopped until you start them.

Browser requests never carry disk paths. Snapshot and runtime roots are Node flags / private `toolchain.json`, not form fields.

Runtime **预览安装** / **预览升级** still go through the rc.1 / rc.2 gate. Final upgrade and crash-recovery acceptance is not finished.

### Logs and doctor

Workbench **诊断** is the in-app diagnostics surface. When the plugin cannot load, use the standalone doctor (see [packages/doctor/README.md](../packages/doctor/README.md)). From this repo after `npm run build:spaces`:

```powershell
node packages/doctor/lib/index.js doctor --home <abs-disposable-home>
node packages/doctor/lib/index.js verify --home <abs> --cli <abs-bin.js> --profile <name>
```

Production Home: add `--allow-real-home` and an explicit `--home`. Doctor does not default to `~/.dsh`, does not kill PIDs, and does not clear live or ambiguous locks. `unlock` / `recover` / `rollback` are explicit operator commands; prefer `--dry-run` first. Doctor and supervisor binaries must not live inside a Home that restore will replace.

## What not to do

- Do not `dsh --profile coding` + `dsh plugin add @dsh-spaces/plugin` as the way to get a manager. The standard path is ordinary **web** add + **初始化 Spaces** ([plugin-standard-install.md](plugin-standard-install.md)).
- Do not pass `--home`, `--bin`, or tarball paths through the browser.
- Do not point `--snapshot-root` or `--control-tool-root` at `profiles`, `hub`, `sessions`, `storages`, or `.dsh-spaces-restore`.
- Do not assume every DSH window on the machine belongs to this Home. Unmanaged instances are view-only; whole-Home restore still replaces Home data and will not stop processes the supervisor never registered. Details: [external discovery](../tasks/workbench-external-discovery.md).
- Do not use `scripts/build-workbench-candidate.mjs` as an install guide. It only builds an isolated rc.2 candidate for in-repo verification.

## Related

- [Root README](../README.md) — desktop safety, isolation rules, license
- [Plugin roles](../packages/plugin/README.md)
- [Supervisor CLI](../packages/supervisor/README.md)
- [Doctor](../packages/doctor/README.md)

---

# DSH Spaces 工作台

> **本分支仍在施工和验收，不是一次发布。** 不要把这些页面当成已上线产品，也不要把本地构建当成绕过官方 CLI 门禁的方法。

**用户安装（普通 Web）：** [plugin-standard-install.md](plugin-standard-install.md) — `pnpm run pack:plugin`，对打印出的 tarball 执行 `dsh plugin --profile web add`，再 `dsh web`，点 **初始化 Spaces**。这不是误装。本包未发布到 npm。

工作台 = 绑定 `127.0.0.1` 的独立监督进程 + 专用管理 profile。普通工作空间原地接入，只装轻量视图桥，不会变成第二套 Spaces 管理器。

## 能做什么

- 独立监督进程。关掉浏览器标签不会停空间。停掉管理 profile 也不会停监督进程；同一入口变成救援 / 维护页。
- 专用管理 profile：`spaces-hub`（重名则 `spaces-hub-2`…）。已有 profile 原地接入，不覆盖已经占用保留名的普通 profile。
- 左侧 72px 空间栏。每个工作空间独立 iframe。草稿、滚动和最后一次确认的选择会保留到新视图就绪；失败则留在原空间。
- 普通空间只装 `@dsh-spaces/view-bridge`。若误装完整 `@dsh-spaces/plugin`，该空间只有 **返回工作台**，不会递归再开一层管理。
- 同一 Home 只有一个写控制者。桌面和 Web 可共用 Home，另一端只读，直到你明确接管。
- 长任务刷新后续看。整 Home 快照、插件安装/卸载、配置恢复、doctor 见下文。部分升级和崩溃恢复仍在验收。

正式写门禁：DSH CLI **`0.1.5-rc.1` 和 `0.1.5-rc.2`**。插件 peer 的 SDK `0.1.5-rc.2` 不是「CLI 2」。仓库里的 candidate 构建只是隔离验证通道，不是给用户绕门禁的教程。

## 尚未写进「已完成」的部分

本分支已在隔离 Home 上跑过：两个工作空间 iframe、管理停机后稳定入口仍在；竹青 / EternalNight / 显式适配的 XP 0.1.1 内层聊天；草稿保留、快速最后点击、创建/改名/图标/排序/重启/删除/刷新选择；本地 `win-unpacked` 桌面与 Web 双向运行权（只读与接管）；插件安装/卸载/配置恢复；一次整 Home 快照恢复。

不能写成已经完成：

- 运行时升级的提交失败与强杀回滚全覆盖（rc1 实际安装/协调升级及一次恢复强杀后的冷恢复已通过）
- 超出 rc.1 / rc.2 的其它 CLI 兼容性
- 管理插件自身升级的真实安装与回滚验收（接口、管理页与独立恢复接线已实现，仍在补实测）
- 最终回归和新介绍视频
- Catppuccin 原主题缺依赖仍然失败，不能包装成 Spaces 已修复

从未被本监督启动、也未登记的手工 DSH，无法可靠地按 Home 发现。监督进程不会接管「这台机器上所有 DSH」。说明见 [外部发现审查](../tasks/workbench-external-discovery.md)。

## 开发隔离 Home 和你自己的 Home

| | 开发 / 本地试验 | 你要管理的产品 Home |
|---|---|---|
| 用途 | 可随时建、快照、删的目录 | 你选定的 Home，打包桌面默认是 `~/.dsh` |
| 指向方式 | 绝对路径 `--home`，**不要**加 `--allow-real-home`。未打包 `npm run dev` 使用 `.sandbox/dsh-home` | 打包桌面默认 `~/.dsh`。监督 / doctor 需要 `--home <绝对路径>` **以及** `--allow-real-home` |
| 不要 | 拿 `~/.dsh` 做实验，或覆盖生产 `settings.yaml` | 把生产 Home 当教程，或指望不传 `--allow-real-home` 也能写进去 |

未打包桌面和测试会拒绝真实 `~/.dsh`，除非该进程被明确授权。监督 CLI 的路径只留在 Node 进程。浏览器不会提交磁盘路径、CLI 命令或启动 token。

## 从本仓库构建、打包、启动

在仓库根目录，先 `npm install`。`npm run build:spaces` 写出 `packages/*/lib`。tarball 打到包目录**外面**（不要打进 `packages/plugin`）。

PowerShell（tarball 目录避免空格；路径一律绝对）：

```powershell
# 一次性 Home，不要用 ~/.dsh
$root = "C:\dsh-workbench-dev"
$spacesHome = "$root\home"
$tools = "$root\tools"
$artifacts = "$root\artifacts"
$snapshots = "$root\snapshots"
New-Item -ItemType Directory -Force -Path $spacesHome, $tools, $artifacts, $snapshots | Out-Null

npm run build:spaces
npm pack ./packages/plugin --ignore-scripts --pack-destination $artifacts
npm pack ./packages/view-bridge --ignore-scripts --pack-destination $artifacts

# --bin 必须是相邻 package.json 为 0.1.5-rc.1 或 0.1.5-rc.2 的 DSH bin.js
node packages/supervisor/lib/index.js `
  --home $spacesHome `
  --bin C:\path\to\@deepseek-ai\dsh\lib\bin.js `
  --node "$env:ProgramFiles\nodejs\node.exe" `
  --plugin-artifact $artifacts\dsh-spaces-plugin-0.2.0.tgz `
  --view-bridge-artifact $artifacts\dsh-spaces-view-bridge-0.2.0.tgz `
  --control-tool-root $tools `
  --snapshot-worker "$(Resolve-Path packages\supervisor\lib\snapshot-worker.mjs)" `
  --snapshot-root $snapshots
```

管理环境和 iframe 握手真正需要的参数：

| 参数 | 作用 |
|---|---|
| `--home` | 规范 DSH Home，绝对路径 |
| `--bin`（别名 `--cli`） | 绑定的 DSH `bin.js`，写门禁 `0.1.5-rc.1` / `0.1.5-rc.2` |
| `--node` | 用来拉起 DSH 的 Node。省略时退回 `process.execPath`，请显式传入以免用错 |
| `--plugin-artifact` | 打好的 `@dsh-spaces/plugin` tarball。没有它管理 profile 装不完 |
| `--view-bridge-artifact` | 打好的 `@dsh-spaces/view-bridge` tarball。普通空间 iframe 握手需要 |
| `--control-tool-root` | 工具链，放在会被快照替换的目录外面。产品冷启动用 Home 的兄弟目录，默认 `{上一级}/.dsh-spaces-tools` |
| `--snapshot-worker` | `build:spaces` 之后的 `packages/supervisor/lib/snapshot-worker.mjs`。维护和运行时安装走这里 |

可选：

- 不传 `--port`：有效时复用 `{home}/.dsh-spaces-control/entry-port.json`；始终只绑 `127.0.0.1`。`--port 0` 每次向系统要新端口。
- `--snapshot-root`：默认是兄弟目录 `{上一级}/{Home名}-snapshots`，不在 Home 里面。
- `--allow-real-home`：仅当你真的要管理那个 Home（包括 `~/.dsh`）。一次性试验不要加。
- `--supervisor-asset-root`：稳定入口静态资源，默认页不需要。

进程会打印 `origin=` 和 `bootstrap=`。用本地浏览器打开一次 `bootstrap=`。这是 Node 侧一次性地址，会写下 HttpOnly cookie 再 303 到 `/`。不要把 `host.bearer` 或 DSH 启动 token 贴进页面。之后 `/` 就是稳定入口。

接入你已经在用的 Home（这会写入该 Home，不是教程）：

加上 `--allow-real-home`、绝对 `--home`，以及上表全部 artifact / worker / tools 参数。该标志只授权**本次进程**使用该 Home，不改系统权限。

已经装了 `@dsh-spaces/plugin` 的管理 profile 可以附着到正在运行的监督进程，或按同一组参数冷启动。普通工作空间不会再冷启动第二个控制器。

## 使用

### 稳定入口

`/` 在 `spaces-hub` 停掉以后仍然可用。

- 管理在运行：入口嵌入管理页，横幅 **工作台入口在线**。
- 管理已停或维护中：**救援入口** / **维护中** / **需要恢复**。按钮：**接管运行权**、**检查并恢复**、**刷新**。页面写明：监督进程不随管理 profile 停机；关闭标签不会停止已启动的工作空间。
- 只读：**只读。接管前不会安装或启动管理环境。** 接管是按钮，不会因为轮询发现空闲就抢权。

管理 UI（默认中文）：

- 空间上的 **启动** / **停止** / **重启**。停止超时会保留实例记录，不会悄悄强杀。
- 关掉浏览器标签 ≠ 关闭工作台。
- **设置 → 释放写控制权**（预览 `controller.release`）把 Home 交给另一端。
- **设置 → 预览关闭**（预览 `controller.shutdown`）才停监督进程。先确认计划。
- 恢复层：**接管写控制权**、**恢复中断的工作**。

### 72px 空间栏

左侧栏宽 72px。持有写权时点击会启动空间。最后一次点击生效；新视图就绪前仍显示上一个已就绪 iframe。创建成功不会自动切换。改名、图标、排序、重启、删除在需要时走预览确认。

`web` 仍是官方根 profile，不打隔离 patch。管理 profile 受保护：不能装普通插件或主题，也不能按普通空间删除。

### 同一 Home 的桌面和 Web

一个 Home 只有一个写者。

| 界面 | 持有写权时 | 另一端 |
|---|---|---|
| 桌面标题栏 | **桌面正在控制此 Home** / **移交** | **只读 — Web 工作台正在控制此 Home** 或 **只读 — 另一桌面实例正在控制此 Home**；**接管** |
| Web 工作台 | 可写，直到 **释放写控制权** | **只读。仍可查询；取得运行权后才能改动。** |
| 稳定入口 | **当前进程持有运行权** | **接管运行权**（本端已可写时禁用） |

无人占有且无歧义时才能接管。记录里已死亡的所有者可从入口回收；活着或说不清的不会被猜掉。

桌面：关窗口会进托盘；**退出**会停掉这个桌面启动的空间。这和 Web 关标签不是一回事。

### 插件、主题、误装

在工作台「插件」里选**工作空间**、目录 id、精确版本，再 **预览安装**。这不是热开关，运行中的空间往往要 **重启**。

最初的普通 Web profile 安装完整插件作为工作台入口。初始化后，工作台管理的空间（如 `coding`）只需 view-bridge；在这些空间重复安装完整插件属于误装。该空间只会显示 **返回工作台**。

可写工作台里用 **清理误装的完整 Spaces**（先预览）。工作台都加载不了时，才用官方 CLI 恢复：

```powershell
dsh plugin --profile <普通空间> remove @dsh-spaces/plugin
```

Windows 上 CLI `0.1.5-rc.1` 转发 `dsh plugin add` 时，带空格的绝对路径即使加引号也不稳；那是限制，不是推荐安装方式。不要把目录联接或手工解压当成安装。

主题：隔离 Home 里竹青、EternalNight 已实际显示。原版 XP 0.1.1 在 iframe 里会画一层桌面，显式适配后内层聊天可用。原版 Catppuccin 仍会因缺依赖失败。

### 长任务和整 Home 维护

危险操作都是 **预览 → 确认计划 → 执行**。计划约五分钟过期，执行时再核对。只能取消仍在队列或尚未进入不可逆阶段的任务。

**创建整 Home 快照**会先停运行中的空间，再快照整个 Home，**之后空间保持停止**。恢复同样先预览。恢复后管理环境可能重启，普通空间要你再启动。

浏览器请求不含磁盘路径。快照和运行时根目录是 Node 参数 / 私有 `toolchain.json`，不是表单字段。

运行时 **预览安装** / **预览升级** 仍受 rc.1 / rc.2 门禁。最终升级和崩溃恢复验收还没结束。

### 日志和 doctor

工作台里的 **诊断** 是应用内诊断。插件加载不了时，用独立 doctor（[packages/doctor/README.md](../packages/doctor/README.md)）。本仓库 `npm run build:spaces` 之后：

```powershell
node packages/doctor/lib/index.js doctor --home <绝对路径-一次性Home>
```

生产 Home 必须同时给 `--home` 和 `--allow-real-home`。doctor 不会默认 `~/.dsh`，不会杀 PID，也不会清掉仍活着或说不清的锁。`unlock` / `recover` / `rollback` 是明确的操作员命令，先 `--dry-run`。doctor 和监督程序本身不要放在即将被恢复替换的 Home 里。

## 不要做的事

- 不要用 `dsh --profile coding` 再 `dsh plugin add @dsh-spaces/plugin` 来获得管理。标准路径是普通 **web** 安装后点 **初始化 Spaces**（[plugin-standard-install.md](plugin-standard-install.md)）。
- 不要让浏览器提交 `--home`、`--bin` 或 tarball 路径。
- 不要把 `--snapshot-root` 或 `--control-tool-root` 指到 `profiles`、`hub`、`sessions`、`storages`、`.dsh-spaces-restore`。
- 不要假定本机每个 DSH 窗口都属于这个 Home。未管理实例只能查看；整 Home 恢复仍会替换 Home 资料，且不会停止监督从未登记的进程。[外部发现](../tasks/workbench-external-discovery.md)。
- 不要把 `scripts/build-workbench-candidate.mjs` 写成安装教程。它只为仓库内 rc.2 隔离验证打一份候选包。
