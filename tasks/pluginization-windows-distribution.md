## 当前有效合同（2026-09-15）

故障政策：[docs/let-it-crash.md](../docs/let-it-crash.md)。活动账本：[todo.md](todo.md)。

隔离、鉴权、单写者、原子写、错误报告，以及用户主动的启动、停止、重启、安装、卸载和配置，仍有效。救援入口、检查并恢复、恢复中断任务、配置恢复、整 Home 恢复、Doctor `unlock`/`recover`/`rollback`、失败回滚、失败重试和中断续接 **已撤销**，不是延期，不勾成已完成。剩余运行时工作见账本 R1–R6（pending）。下文是当时实施与验收记录，不是现行恢复门槛。

> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。
# Windows 打包桌面验收

日期：2026-09-12。分支：`codex/spaces-pluginization`。\
脚本：`scripts/verify-spaces-desktop.mjs`（本叶实现）。本叶**未**运行共享构建、真实 Electron 或浏览器。

## 入口

```
node --import tsx scripts/verify-spaces-desktop.mjs --prereq
node --import tsx scripts/verify-spaces-desktop.mjs
```

`--prereq` 或 `DSH_TEST_DESKTOP_PREREQ=1`：只做构建/夹具/产物路径检查，写 `prereq.json` 后退出，不启动 Electron，不执行 NSIS。

## 建议打包命令与 exe 入口

`package.json` `build.win.target` 为 `nsis`，`productName` 为 `DSH Spaces`，`directories.output` 为 `release`，当前版本 `0.2.0`。`scripts.dist:win` **没有** `--publish never`（`package.json` 第 35 行）；串行打包必须在命令行显式带上，避免存在 `GH_TOKEN` 时发布。

```
npm run build
npx electron-builder --win nsis --publish never
```

| 产物 | 路径 |
| --- | --- |
| 打包应用入口（推荐验收） | `D:\0 code\dsh-spaces\release\win-unpacked\DSH Spaces.exe` |
| NSIS 安装器 | `D:\0 code\dsh-spaces\release\DSH Spaces Setup 0.2.0.exe` |
| 安装后同名 exe | `<INSTDIR>\DSH Spaces.exe` |
| 卸载器 | `<INSTDIR>\Uninstall DSH Spaces.exe` |

`electron-builder` 的 nsis 目标会同时写出 `win-unpacked` 与 Setup 安装器。Playwright `_electron.launch` 应对 **已打包应用 exe**（旁边有 `resources/app.asar`），不要把 Setup 安装器当 `executablePath`。

磁盘上现有 `release/win-unpacked/DSH Spaces.exe` 与 `release/DSH Spaces Setup 0.1.0.exe` 等是 **0.1.0 残留**；`package.json` 已是 `0.2.0`。`prereq.json` 的 `onDiskInstaller` 对 0.2.0 文件名为 false，串行验收前需要按上面命令重建。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_TEST_PACKAGED_EXE` | 显式打包 exe。设置后启动该 exe，并断言 `app.isPackaged === true` |
| `DSH_TEST_INSTALLER` | 可选安装器路径，仅 `--prereq` 做 `7z l` 列举，**不执行** |
| `DSH_TEST_LOCALE` | `en`（默认）或 `zh`；UI 点击同时匹配中英文 |
| `DSH_TEST_BIN` / `DSH_TEST_PLAYWRIGHT_MODULE` / `DSH_TEST_NODE_ZIP` | 与既有桌面冒烟相同的夹具 |
| `DSH_TEST_DESKTOP_PREREQ` | 同 `--prereq` |

打包模式启动参数不含仓库路径。始终设置独立 `DSH_SPACES_HOME` / `DSH_SPACES_USER_DATA` / `DSH_SPACES_TOOLCHAIN`、`DSH_SPACES_DISABLE_UPDATES=1`，拒绝 `~/.dsh`。

完整运行示例：

```
$env:DSH_TEST_PACKAGED_EXE = "D:\0 code\dsh-spaces\release\win-unpacked\DSH Spaces.exe"
node --import tsx scripts/verify-spaces-desktop.mjs
```

中文界面可加 `$env:DSH_TEST_LOCALE = "zh"`。未设置 `DSH_TEST_PACKAGED_EXE` 时仍走未打包 `node_modules/electron` + 仓库 `out/main`，并断言 `app.isPackaged === false`。

## 运行时证明（待主 Agent 串行执行）

1. 主窗口 `isVisible`、未最小化、尺寸 ≥ 800×560；壳层截图 `.sandbox/spaces-desktop-acceptance/window.png`。
2. 壳层按钮同时接受 `Settings`/`设置`、`New space`/`新建工作台`。
3. 点击侧栏 `coding`（用户动作，不是只调 `startProfile` IPC）。
4. 嵌入 DSH 通过认证后，只点击 `Continue`/`继续` 与 `稍后配置`/`set up later`/`configure later`，**不输入 API key、不调模型**；出现 `New Session`/`新会话` 才算 Space 已呈现。截图 `coding.png`。
5. 保留 IPC：`restartProfile`、`updateMeta` 读回、锁文件释放、`stopProfile`、`quitApp`，并确认占用端口 TCP 关闭。

## 安装器证明边界（本叶未执行，主 Agent 决定是否串行）

当前 `package.json` 未配置 `nsis` 块，因此 electron-builder 默认 **oneClick=true、per-user**。默认 GUI 安装目录是 `%LOCALAPPDATA%\Programs\DSH Spaces`。禁止用 UI 自动点击安装器写系统目录。

`app-builder-lib/templates/nsis/multiUser.nsh` 明确支持 `/D`（必须是最后一个参数，路径即使有空格也**不能加引号**）。卸载文件名模板为 `Uninstall ${PRODUCT_FILENAME}.exe`。

### A. 推荐：不跑安装器

打包后直接用 `win-unpacked\DSH Spaces.exe`。证明 `app.isPackaged`、asar 布局、独立 Home 冒烟。**不证明**开始菜单、卸载注册表、默认安装路径。

### B. NSIS 静默安装到临时目录（可选）

```
$dest = Join-Path $env:TEMP "spaces-nsis-verify"
New-Item -ItemType Directory -Path $dest | Out-Null
& "D:\0 code\dsh-spaces\release\DSH Spaces Setup 0.2.0.exe" /S /currentuser /D=$dest
# 等待 $dest\DSH Spaces.exe 与 Uninstall DSH Spaces.exe
$env:DSH_TEST_PACKAGED_EXE = Join-Path $dest "DSH Spaces.exe"
node --import tsx scripts/verify-spaces-desktop.mjs
& (Join-Path $dest "Uninstall DSH Spaces.exe") /S
```

证明：静默解包到 `/D` 目录、该 exe 可按打包应用冒烟、静默卸载。\
不证明：oneClick GUI、Program Files 全机安装、UAC、开始菜单/桌面快捷方式、签名信任对话框、自动更新。`/S` 仍会写该临时目录和可能的 HKCU 卸载项，故必须用临时 `/D`，不要指向 Program Files。

### C. 7z 列举/解包安装器（研究用）

`--prereq` 在安装器存在且本机有 7-Zip 时只跑 `7z l`，不释放文件。完整 `7z x` 可能得到 `$PLUGINSDIR` 和内嵌 7z，布局不一定等于 `win-unpacked`，也没有卸载器。不能代替安装器 OS 注册，也不能代替 `app.isPackaged` 冒烟。

## 证据路径

| 文件 | 何时出现 |
| --- | --- |
| `D:\0 code\dsh-spaces\.sandbox\spaces-desktop-acceptance\prereq.json` | `--prereq` 或完整运行开头 |
| `...\window.png` | 完整运行：主窗口可见 |
| `...\coding.png` | 完整运行：跳过介绍后的嵌入 DSH |
| `...\results.json` | 完整运行通过 |
| `...\failure.json` | 完整运行失败（正文截断，token 脱敏） |

## 本叶已做 / 未做

已做：脚本扩展、静态阅读 `package.json` build 与 NSIS 模板、`--prereq` 构建前提检查。\
未做：`npm run build` / `electron-builder`、启动 Electron、NSIS `/S /D`、7z 解包到磁盘、浏览器。\
未改：`package.json`、lockfile、产品源码、最终验收报告。
# 独立验收补充：2026-09-12

主 Agent 已构建 `.sandbox/spaces-windows-distribution/DSH Spaces Setup 0.2.0.exe`（显式 `--publish never`），用 electron-builder 缓存的 7za 提取安装包载荷，确认载荷 `app.asar` 与构建输出哈希一致，并使用载荷中的 `DSH Spaces.exe` 跑完脚本。`app.isPackaged=true`、中文壳层可见、侧栏打开 coding、跳过介绍和 API key 引导、认证视图、重启、元数据保存读回、停止、退出及两个端口关闭均通过。没有执行 NSIS 安装器或修改现有安装/系统注册项。

证据：`.sandbox/pluginization-windows-packager.log`、`.sandbox/pluginization-installer-extract.log`、`.sandbox/pluginization-packaged-runtime.log`、`.sandbox/spaces-desktop-acceptance/{results.json,window.png,coding.png}`。7za 存在于 `%LOCALAPPDATA%/electron-builder/Cache/7zip@1.0.0/7zip-win-x64-a34pt/bin/7za.exe`；下文“本机无 7-Zip”仅指 worker 检查的 PATH/常规安装位置。结果时间 `2026-09-12T06:18:51.683Z`。
