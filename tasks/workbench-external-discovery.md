# 外部未登记 DSH 发现审查（只读叶）

状态：只读结论，供 root 审计。2026-09-12。未改产品、未启动/停止真实 DSH 或浏览器、未读生产配置/凭据/完整环境、未改权限、未安装工具、未 Git、未做本机进程实验。`profile-boot` 两文件已由 root 排除 pid/lock，本叶不复述。

## 结论

**DSH 没有 Home 级 PID/端口/profile 进程登记，也没有未认证的发现端点。** 真实缺口成立：Supervisor 只能看见自己写进 `{canonicalHome}/.dsh-spaces-control/instances` 的记录；普通手工 `dsh --profile …`（未装 view-bridge、从未被本监督 spawn）对工作台不可见，整 Home 快照/恢复/升级仍会替换 `sessions/` 与 `hub/`，而 `stopAll` 不会停那些进程。

Windows 上 **没有已依赖的官方只读 API 能把任意 DSH 进程精确映射到 `DSH_HOME`**。CIM `Win32_Process.CommandLine` 通常只有 `--profile`（及可选 `--port`/`--host`）；`DSH_HOME` 由环境传入，不在 CommandLine。官方环境 API 只读调用方自身或用户/系统注册表，不读他进程 PEB。因此：

- 不得把“按端口猜 profile”或“本机所有 DSH 都算同 Home”当准确识别。
- 不得默认杀进程。
- 不得把读全环境或硬编码 PEB 偏移写成施工方案。
- **准确列出“属于本 Home 的外部实例”必须引入新能力（优先上游 DSH 登记）**；**保守挡住整 Home 写维护不必等新登记**，可复用 DSH 已有的会话写租约（Windows 命名信号量 / POSIX `session.lock`），且探测不得用会占锁的 `CreateSemaphoreW`/`SessionWriteLease.acquire`。

## 需求对照

计划与合同要求：

- 损坏或身份不明只进恢复，不猜测清锁，不接管外部实例（`tasks/workbench-implementation.md`）。
- `managed=false` 的外部实例只能查看，不能 start/stop/restart/adopt（`tasks/workbench-contract.md`）。
- 维护停机回调只能停所有权已知的实例，禁止自动强杀（`WorkbenchMaintenancePorts.stopSpace` 注释）。
- 整 Home 快照/恢复不能误碰仍由外部实例写入的资料。

当前实现只覆盖 **监督自己留下的 instance JSON**，不覆盖 **从未登记的手工进程**。

## DSH 官方机制（rc1 与 rc2 一致）

基线：`C:/Users/admin/AppData/Local/Temp/spaces-runtime-install-fIEaas/versions/0.1.5-rc.1/node_modules/@deepseek-ai`。rc2 对照：`.sandbox/spaces-unknown-cli/node_modules/@deepseek-ai`。下列包定向读过；未做全 vendor 扫描。

### CLI `@deepseek-ai/dsh` — 无实例命令

`dsh/lib/bin.js` `parseDshArgs` / `runCli` 只有：`--profile` 启动、`web` 别名、`plugin`（转发 pnpm）、`--dump-config` / `--dump-default-config`。没有 list/status/pid/lock/discover。

`dump-config-lFgMwK8i.js` `runDumpConfig`：组合补丁并打印，**不 boot、不求值 `!!js`、不查询运行中进程**。不能当发现。

### host-webserver — 无发现、无 PID 文件

`dsh-host-webserver/lib/index.js` `WebServer`：`node:http` 路由表、index 注入、fallback。README 写明 “knows no harness concepts”。`port` 0 由 OS 分配；`EADDRINUSE` 使插件初始化失败。无 health/registry 路由。

### web-app / 就绪信号 — 仅 stdout

`dsh-web-app/lib/index.js` `announceReady`：Loader 安顿后 `console.log('dsh web: ' + authenticatedUrl)`。URL 带一次性 `?token=`。默认端口 `cordis.patch.yml`：`ctx.webStartup.port ?? 3080`。`--host 0.0.0.0` 被拒绝。无磁盘 PID/实例文件。rc2 同一打印格式与默认 3080。

### core `dsh-base` — 共享 Home 资料，不是进程表

`dsh-base/cordis.patch.yml`：`session-persistence-jsonl.root: !!js dshHomePath('sessions')`，另有 `dshHomePath('storages')`。这是资料根，不是运行登记。

`dsh-home-paths` `resolveDshHome`：显式路径 > `$DSH_HOME` > `~/.dsh`。进程不把解析结果写回磁盘。

`dsh-launch-environment`：启动时冻结 env 快照并物化进 `process.env`；他进程看不到这份快照。

`dsh-app-boot` 的跨进程锁只保护 `$DSH_HOME/profiles/node_modules` 模块后备（`healProfilesModuleFallback` + `withFileLock`），不是实例登记。

`dsh-cordis-host-runner` `CordisInspectRegistryService`：进程内动态包检查，重启即清空，不写盘。

### HTTP — 无未认证身份

`dsh-client-connection`：每个进程自铸 launch token；无 cookie 的 RPC 为 401；静态资源公开但不含 profile/`DSH_HOME`。无独立 health。

`dsh-api-gateway` 认证后 `$events` 首帧 `{ type: 'ready', clientId, host: { home } }`。`dsh-api-remotes/lib/index.js` 传入的 `home` 是 **`os.homedir()`，不是 `DSH_HOME`**。即使持有 token，也不能用该帧识别 Harness Home。本产品也不应去交换外部实例的 token。

### 会话写租约 — 唯一与“仍在写资料”对齐的官方锁

`dsh-session-persistence-jsonl` `SessionWriteLease`（`lib/types/lease.d.ts`，rc1/rc2 相同）：

- POSIX：会话目录旁 `session.lock` 上非阻塞 `flock(2)`。
- Windows：`Local\\dsh-session-lock-${sha256(resolve(path).toLowerCase())}` 命名内核信号量，**零文件系统足迹**（`acquireLockHandleWin32`）。
- 持有期 = 写句柄寿命；崩溃随进程释放；卡住的活进程会一直占锁。
- 未物化会话无锁。
- Windows 名在登录会话内（`Local\`）。

这不是 PID/profile 登记，只表示“该会话目录此刻有写者”。

设置/凭据的 `<file>.lock`（`dsh-settings-file` / `dsh-atomic-write` `withFileLock`）是秒级写周期，2 秒超时后留下孤儿锁且不能用锁龄区分崩溃与暂停。不能当 liveness。

## 本仓库已有可复用路径

| 路径 | 函数 | 能证明什么 | 不能证明什么 |
|---|---|---|---|
| 监督实例账 | `WorkbenchSupervisor.writeInstanceRecord` / `reconcileInstanceRecords` | 本监督 spawn 过、PID 仍像活着的 leftover | 从未写过该 JSON 的手工进程 |
| 协作子进程账 | `CooperativeChildren.spawn` | 同上，另有 IPC `dsh-spaces:stop` | 外部进程无该 channel |
| doctor | `packages/doctor/src/inspect.ts` 读 instances + `defaultPidAlive` | leftover 存活性 | 外部未登记 |
| 自有子进程就绪 | `waitForDshEndpoint` 解析 stdout `dsh web:`；`dshSessionCookie`；`dshSessionList` | **自己 spawn 且拿到 stdout/token** 的端口 | 无 stdout 的外部进程；不得拿外部 token |
| 启动参数 | `ProcessManager.startOnce`：`--profile name --no-open --host 127.0.0.1 --port P`，env `DSH_HOME` | 本产品子进程身份 | 外部 CommandLine 通常无 `DSH_HOME` |
| 隔离补丁 | `applyIsolationPatch` → `dshHomePath('hub/<name>/sessions\|storages')` | 经 Spaces 转换的 profile 写 `hub/` | 未打补丁的手工 web/profile 写 Home 级 `sessions/` / `storages/` |
| 维护停机 | `WorkbenchMaintenance.runSnapshotCreate/Restore` → `ports.stopAll` → `stopOwnedAll` | 只停 `managed && !unmanaged` | 外部进程继续写 |
| 快照范围 | `MANAGED_HOME_ENTRIES`：`profiles, sessions, storages, hub, settings.yaml, cordis.patch.yml` | 整 Home 会换会话与 hub | 控制目录不在此列，但资料在 |
| view-bridge | `packages/view-bridge/src/index.ts` `apply` | 仅当监督注入 `DSH_SPACES_VIEW_*` | 普通手工 DSH 无桥，无发现 RPC |
| PID 探活 | `defaultPidAlive` = `process.kill(pid, 0)` | 已知 PID | 未知 PID 集合 |
| CIM/TCP | 本仓库 **无** `Win32_Process` / `Get-NetTCPConnection` | — | — |

`listSpaces`：`unmanaged` leftover 显示 `managed: false`、`status: "unknown"`，`view()`/`startOwned` 拒绝。合同的“只展示”目前只覆盖 leftover，不覆盖从未登记者。从未登记者被当成 stopped，维护照常 `stopAll` 后改盘。

## Windows 本机映射（无实验）

官方 CIM [`Win32_Process`](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process) 有 `CommandLine`、`ExecutablePath`、`ProcessId`、`ParentProcessId`、`CreationDate`。**没有环境块。** [`GetEnvironmentStrings`](https://learn.microsoft.com/en-us/windows/win32/procthread/environment-variables) 只读调用方；`Win32_Environment` 是用户/系统注册表，不是他进程。读他进程 env 只能走未文档化的 PEB/`ReadProcessMemory`，本叶否决为施工。

因此 CIM 至多得到：`node …/dsh/lib/bin.js --profile <name> [--port N] [--host 127.0.0.1] [--no-open]`。同名 profile 可存在于多个 Home（`spaces-hub` 尤其常见）。`--port 0` 时 CommandLine 不是实绑端口。默认 3080 在任意 Home 的 web 模板上都会撞车，不能反推 Home。

`MSFT_NetTCPConnection` 可把 `127.0.0.1:port` 映到 PID，仍无 Home。对公开 `/` 做 HTTP 探测：无 token 得 401，且产品禁止把磁盘路径放进浏览器 DTO；即使用 token，ready 帧的 `host.home` 也是 `os.homedir()`。

**会话租约探测（非占锁）是已有 DSH 机制 + 文档化 Win32：** [`OpenSemaphoreW`](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-opensemaphorew) 打开已存在对象，不存在则失败。对象名算法与 `acquireLockHandleWin32` 相同。成功 ⇒ 本登录会话内有人持有该会话写锁。本仓库未依赖 koffi/`node-addon-system`；实现需 root 另开叶。禁止用 `CreateSemaphoreW` 或 `SessionWriteLease.acquire` 做探测：空闲时会创建并占锁，真实写者会 `SessionAlreadyOwnedError`。

边界：仅覆盖**当前持有写句柄**的会话；空闲 GUI、未物化会话、只改 settings 的进程检测不到。空闲不等于“不会再写”。

## 最小方案与边界（不编码）

**不要做：** 默认杀进程；按端口猜 profile；把全机 DSH 当同 Home；读全环境/PEB；交换外部 token 再 RPC；用会占锁的 acquire 探测；把 CIM 候选标成已确认本 Home 实例。

**现在就可以保守做的（复用已有机制，不必等 DSH 新登记）：**

1. 保持 leftover 账：活着的 `.dsh-spaces-control/instances` → `managed=false`、禁止 adopt/stop/start，`recoveryRequired`。已有。
2. 整 Home `snapshot.create` / `restore` / 升级 / recover 在 `stopAll` **之后、改 `MANAGED_HOME_ENTRIES` 之前**，对本 Home 的 `sessions/` 与 `hub/*/sessions/` 做非占锁租约探测。任一会话被占 → 失败并保留指针，文案说明有未登记写者，不杀。
3. UI 对 leftover 维持“只展示状态”。对 CIM/`--profile` 命中本地名字的进程，若要显示必须标 **Home 未证实**，动作集仍为空。宁缺勿假。
4. 空闲外部进程无租约：检测缺口。产品应失败关闭或要用户确认，而不是猜测已空闲。

**准确“列出本 Home 外部实例”做不到**，除非上游 DSH 提供登记（例如 Home 下原子 `{pid,profile,port,startedAt}`，或认证前即可询的只读身份且含 canonical Home）。那是新能力，本叶不施工。

view-bridge 不能当发现面：手工实例通常未装；装了也只消费监督注入的 env。

## 整 Home 维护应如何保守

`stopAll` 只停账内 owned。随后 `SnapshotStore.swapManaged` 会替换 `sessions` 与 `hub`。外部写者（未隔离则写 `$DSH_HOME/sessions`，已隔离则写 `hub/<profile>/sessions`）会在换树时被撕日志；Windows 上甚至看不到 `session.lock` 文件。

建议闸门（root 决定是否开工）：

1. leftover 活/模糊 PID → 已有恢复，不要清锁、不要 restore。
2. 本 Home 会话租约被占 → 新增拒绝，不杀。
3. CIM 看到 `--profile` 与本 Home 同名但 Home 未证实 → **不得**当作停机列表；可选 UI 警告，不得单独放行整 Home 写。
4. 停 owned 失败 → 已有 `maintenanceBlocked`，保持。
5. 绝不对未知 PID 默认 `Terminate`。

快照创建同样复制正在被写的树；创建也应受租约闸门约束，否则快照本身已撕裂。

## 是否必须引入新能力

| 目标 | 必须新能力？ |
|---|---|
| 不接管、不默认杀 | 否，已有 unmanaged/owned 边界 |
| 整 Home 维护避开**正在写会话**的外部实例 | 否；复用 DSH 租约 + `OpenSemaphoreW`/flock，本产品实现探测 |
| 准确列出属于本 Home 的未登记实例（PID↔`DSH_HOME`↔profile） | **是**。DSH 无登记；Windows 无官方他进程 env。应向上游要登记，不要 PEB |
| 用 HTTP 认出 profile/Home | 否，现有面不够；不要为此造 token 扫描 |
| 空闲但已打开本 Home 的进程 | 现有锁覆盖不了；要么接受残留风险+用户确认，要么等 DSH 登记 |

**推荐 root 下一步（本叶不施工）：** 先把整 Home 维护接到非占锁会话租约探测（失败关闭）；展示面继续只信任 instances leftover，CIM 最多作未证实警告。不要为“列表完整”去扫端口或读 PEB。若产品坚持准确列表，应开 DSH/上游能力，而不是本仓库私有进程黑客。

## 证据边界

- 只读了 CLI、host-webserver、web-app、app-boot、base 补丁、home-paths、launch-environment、client-connection、api-gateway/remotes、session-persistence lease/win32、以及本仓库监督/维护/快照/doctor/view-bridge。
- 未跑真实 DSH、未枚举本机进程、未打开生产 Home。
- 未验证“空闲 web GUI 是否一直持有会话写租约”（代码只保证写句柄期间持有）。
- rc1/rc2 在 CLI 动词、`dsh web:` 行、默认 3080、Windows 信号量名算法上一致；未对 rc2 其余包做全量 diff。
