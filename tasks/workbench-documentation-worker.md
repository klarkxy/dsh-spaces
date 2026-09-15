## 当前有效合同（2026-09-15）

故障政策：[docs/let-it-crash.md](../docs/let-it-crash.md)。活动账本：[todo.md](todo.md)。

隔离、鉴权、单写者、原子写、错误报告，以及用户主动的启动、停止、重启、安装、卸载和配置，仍有效。救援入口、检查并恢复、恢复中断任务、配置恢复、整 Home 恢复、Doctor `unlock`/`recover`/`rollback`、失败回滚、失败重试和中断续接 **已撤销**，不是延期，不勾成已完成。剩余运行时工作见账本 R1–R6（pending）。下文是当时实施与验收记录，不是现行恢复门槛。

> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。
# 工作台用户文档叶子交接

状态：文档施工已落地。2026-09-12。HEAD `5911e60` 只读对照。未 Git、未发版、未改版本、未改源码/测试、未改 doctor README、未启动 DSH/浏览器/录制、未做网络检索。

## 结论

用户文档已从 Phase 0/1「Web 不能生命周期 / iframe / 维护」和「往普通 coding profile 装完整插件获得管理」改为当前产品角色：独立 `127.0.0.1` 监督进程、专用 `spaces-hub` 无损接入、误装 guide-only、轻量 view-bridge、72px 空间栏、同 Home 双端写权、长任务/整 Home 维护/doctor。每份用户文档顶部标明本分支仍在施工验收、不是发布。

## 写入范围（仅这些路径）

- `D:\0 code\dsh-spaces\README.md`
- `D:\0 code\dsh-spaces\packages\plugin\README.md`
- `D:\0 code\dsh-spaces\packages\supervisor\README.md`
- `D:\0 code\dsh-spaces\docs\workbench.md`（新建）
- `D:\0 code\dsh-spaces\tasks\workbench-documentation-worker.md`（本文件）

## 主要修订与静态对照

### 1. 过时范围 → 当前角色

| 旧表述 | 现表述 | 源码对照 |
|---|---|---|
| README：Phase 0+1 Web 无生命周期/iframe/维护 | 工作台监督进程 + iframe 空间栏；维护走监督/doctor | `packages/plugin/src/client/index.tsx` manager 换 root / 普通空间仅返回工作台；`workbench-http.ts` 稳定入口 |
| plugin README：`dsh plugin --profile coding add` 作为安装路径 | 明确为误装/恢复；推荐监督进程安装管理 profile | `SpacesPlugin` 按 `HomeController.roleOf`；`bootstrapSupervisor` 仅 manager/uninitialized 冷启动 |
| supervisor README：缺 artifact 的短命令；默认快照 `{home}/.dsh-spaces-snapshots` | 完整 flags；默认快照为兄弟 `{parent}/{homeName}-snapshots` | `parseSupervisorArgs` 1823–1860 行；`snapshotRoot()` 1046–1048 行；`supervisor-bootstrap.ts` `childArgv` 199–216 行 |

### 2. 可运行本地命令（未实际执行）

对照 `parseSupervisorArgs` / `SUPERVISOR_CLI_FLAGS` / `scripts/build-spaces.mjs`：

- 先 `npm run build:spaces`（写出 `packages/supervisor/lib/index.js` 与 `snapshot-worker.mjs`），再 `npm pack` plugin 与 view-bridge 到包外目录。
- CLI 使用 `lib/index.js`，不用裸 `node …/src/index.ts`。
- 命令含 `--home --bin --node --plugin-artifact --view-bridge-artifact --control-tool-root --snapshot-worker`，可选 `--snapshot-root` / `--port` / `--allow-real-home`。
- 开发隔离 Home 与产品 `--allow-real-home` 分开写，不推荐覆盖生产配置。
- 浏览器不接受路径；tarball 名按 `package.json` `0.2.0` → `dsh-spaces-plugin-0.2.0.tgz` / `dsh-spaces-view-bridge-0.2.0.tgz`。

### 3. UI/CLI 用词对齐（静态）

- 关标签 ≠ 停机：`settings.shutdownHint`；按钮「释放写控制权」「预览关闭」。
- 稳定入口：`救援入口` / `接管运行权` / `检查并恢复` / `刷新`（`workbench-http.ts` `renderEntryPage`）。
- 桌面双端：`接管` / `移交`；「只读 — Web 工作台正在控制此 Home」（`ControllerStatus.tsx`）。
- 误装：`返回工作台`；「清理误装的完整 Spaces」。
- 空间栏 72px：`packages/plugin/src/workbench/styles.ts` 与 `src/shared/layout.ts` `RAIL_WIDTH`。

### 4. 验收边界（按派工事实，未重跑）

写入为「已在隔离 Home 验证」而非产品完成：双 iframe/管理停机稳定入口；竹青/EternalNight/显式 XP 适配+内层聊天；草稿/切换/创建改名图标排序重启删除/刷新；win-unpacked 双端运行权；插件 install/remove。当时还验证过 config restore 与一次整 Home 快照恢复；那些作为产品能力 **已撤销**，不得再写进现行用户文档。

明确未完成（现行）：最终 runtime 升级（候选准备与指针切换，不是失败回滚）、rc2 之外兼容、管理插件自升级的真实安装、最终回归与新视频。Catppuccin 原主题缺依赖失败不包装修复。kill 故障恢复：**已撤销**（2026-09-15，改验失败可见且无抢救）。CLI 门禁 `0.1.5-rc.1` / `0.1.5-rc.2`；SDK `0.1.5-rc.2` 不是 CLI 2；candidate 不是绕门禁教程。外部未登记 DSH 缺口链到 `tasks/workbench-external-discovery.md`。

### 5. 保留未改

根 README 的 Why / vs Launcher / Safety 条目 / Requirements 主体 / 开发 sandbox 命令 / Build / License / 中文数据规则与安全主体，在 2026-09-15 let it crash 修订中已去掉恢复原则。doctor README 目标改为只诊断。

## 验证（实际做了什么）

- 只读：`parseSupervisorArgs`、`supervisor-bootstrap.ts` `childArgv`、`plugin.ts` / `client/index.tsx` 角色分流、`workbench-http.ts` 入口文案、`i18n.ts` / `ControllerStatus.tsx`、`home-guard.ts` / `dsh-home.ts`、`build-spaces.mjs` 产出路径、`COMPATIBLE_DSH_CLI_VERSIONS`、`snapshotRoot()` 默认值、doctor README（未改）。
- 未运行 `npm run build:spaces`、`npm pack`、监督进程、DSH、浏览器、doctor CLI。因此**没有**把「用户按文档能一次启动成功」标为已验证。
- 未做产品验收；文档更新 ≠ 工作台交付完成。

## 假设与风险

- tarball 文件名假定当前 `packages/*/package.json` 仍为 `0.2.0`；改版本后文档文件名要跟着改。
- `--node` 在代码里可省略并回退 `process.execPath`；文档仍要求显式传入，避免用错 Node。
- 默认快照目录已按源码写成兄弟目录；若根之后改 `snapshotRoot()` 需再改文档。
- 根正在串行跑维护、另一叶子改恢复收据：本文只读当时接线，不保证与后续源码同步。
- `npm pack --pack-destination` 未在本叶执行，路径以 npm 实际输出为准。

## 需要整合

- 根 README 与 `docs/workbench.md` 互链已加。无需源码接口变更。
- 若 doctor README 恢复叶改了命令，工作台 guide 里的 doctor 示例需再对一次（本叶未改 doctor）。
- 主 Agent 审查：施工横幅、误装口径、完整 CLI 参数、未完成验收四条是否写进用户可见页。
