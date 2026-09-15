## 当前有效合同（2026-09-15）

故障政策：[docs/let-it-crash.md](../docs/let-it-crash.md)。活动账本：[todo.md](todo.md)。

隔离、鉴权、单写者、原子写、错误报告，以及用户主动的启动、停止、重启、安装、卸载和配置，仍有效。救援入口、检查并恢复、恢复中断任务、配置恢复、整 Home 恢复、Doctor `unlock`/`recover`/`rollback`、失败回滚、失败重试和中断续接 **已撤销**，不是延期，不勾成已完成。剩余运行时工作见账本 R1–R6（pending）。下文是当时实施与验收记录，不是现行恢复门槛。

> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。
# 工作台自身升级审查（只读叶子）

日期：2026-09-12。分支 `codex/spaces-pluginization`。范围：工作台（监督程序 + 管理 profile 的 `@dsh-spaces/plugin`）是否已有用户可用且安全的闭环。**不是** DSH CLI/`runtime.upgrade`。未启动真实 DSH、浏览器、服务或生产 Home。未改产品源码。

结论：**没有用户可用且安全的工作台自升级闭环。** 现有事务覆盖 DSH runtime 整 Home 升级（回滚作为产品能力已撤销）、工作空间插件变更、以及**首次**监督冷启动+管理包安装。监督进程不能热替换；已安装的管理包不会在后续冷启动中按新 artifact 刷新。不得把 `runtime.upgrade` 或 Electron `autoUpdater` 当成工作台自升级已完成。与恢复相关的缺口不再作为施工门槛；安全与正常更新缺口仍有效。

---

## 1. 已存在（接线与恢复证据）

### 1.1 冷启动绑定：监督 payload 在 Home 外，插件来自本地包

管理进程加载 `@dsh-spaces/plugin` 后，`WorkbenchHostRuntime.bootstrap()` 先附着已有监督；仅 `role===manager|uninitialized` 且身份已确认、非 recovery 才允许冷启动。

| 步骤 | 证据 | 实际保证 |
| --- | --- | --- |
| 附着优先 | `packages/plugin/src/host/runtime.ts` 171–208；`supervisor-attach.ts` 45–78 | 活监督 + 同 origin 租约 + bearer `state` ping 成功则**不再**拷 payload / 不再 spawn。workspace 误装只附着，不冷启动（`canColdStart` 52–55；测试 `tests/workbench-plugin.test.ts` 612+）。 |
| 死/外/歧义租约 | `supervisor-attach.ts` 58–69；`bootstrapSupervisor` 118 | `blocked` 直接失败。不清锁、不杀 PID、不覆盖 endpoint。 |
| payload 出 Home | `supervisor-bootstrap.ts` 158–175, 244–250, 317–325 | 源：插件包内 `supervisor/` + `manifest.json` + `snapshot-worker.mjs`。目标：`{home}/../.dsh-spaces-tools/{manifest.version}-{contentDigest}`。同内容跳过；同路径不同内容抛错，不覆盖。 |
| 本地打包管理包 | `supervisor-pack.ts` 40–109；bootstrap 177–216 | `npm pack` 当前已安装的 `@dsh-spaces/plugin` 与 `@dsh-spaces/view-bridge`，tgz 必须在 Home/包树外。CLI 只收绝对路径 `--plugin-artifact` / `--view-bridge-artifact`（`workbench-supervisor.ts` 1854–1857, 1863–1874）。浏览器 DTO 无这些字段。 |
| 冷启动锁 | bootstrap 218–241 | `toolsRoot/coldstart.lock` mkdir 互斥；poll 结束后释放。咨询性，不是 Home 事务日志。 |
| 稳定入口 | supervisor 42–51, 791–794 | 默认复用 `entry-port.json`；`--port 0` 仍随机。关闭标签不停止监督。 |

**内容寻址已支持“同 package 版本、不同字节”的本地分发验证**：dest 含 digest，不必改 `packages/plugin/package.json` / `packages/supervisor` 的 `0.2.0`。这只在**冷启动路径真正跑起来**时生效。

### 1.2 管理 profile 首次安装：artifact → hub 归档 → plugin add

`bootstrapManager`（`workbench-supervisor.ts` 797–845）：

- `manager-bootstrap.json` 标记中断安装；`ordinary` 且无本标记则拒绝覆盖；`damaged` 拒绝重建。
- 仅 `missing` 时从 bound CLI 克隆 web profile。
- `installArtifact`（857–863）：`copyFileSync` 到 `hub/plugins/dsh-spaces-plugin.tgz`（`plugin-library.ts` 23–28），再 `pluginAdd(home, profile, dest)`。view-bridge 同理。
- 完成条件：`inspectManagerInstall === "manager"`（2069–2088）——**只看** `package.json` 的 `dependencies` / `dsh.profile.bundles` 是否出现 `@dsh-spaces/plugin`，**不看版本、digest、归档内容**。
- **已是 manager 且无 pending：直接 return，忽略新的 `--plugin-artifact`。** 这是自升级最大接线缺口。

中断后续接有测试：`tests/workbench-supervisor.test.ts` 53–77（失败后保留 marker，二次启动装完并删 marker）。那是首次引导，不是换包。

`reinitializeManager`（1063–1099）：重绑 CLI / `toolchain.json`，manager **missing** 才再 `bootstrapManager`；已是 manager 则只停工作空间、重启 manager 进程。runtime 升级后的“恢复管理器”不是刷新工作台包。

### 1.3 管理环境禁任意插件/主题（仍成立）

| 层 | 证据 |
| --- | --- |
| 合同 | `tasks/workbench-contract.md` 30–31；`src/shared/workbench.ts` 80–87：安装只有 `catalogId`+精确 `version`。 |
| 维护 | `targetSpace(..., false)` 禁止 manager（1389–1396）；`assertGuardedPackage` 含 `@dsh-spaces/plugin` 与官方 base/web（89, 1931–1938）；`rejectRawSpec` 拒 file/git/http/盘符路径（1945–1962）。测试 `tests/workbench-maintenance.test.ts` 130–154。 |
| `plugin.cleanup-manager` | 只从**普通**空间卸管理包，不迁数据（748–777, 1016–1034）。 |
| UI | `plugins.managerDenied`；install/toggle 点到 manager 被拒（`store.ts` 391–397, 770–774；`components.tsx` 363–417）。 |
| Host schema | `workbenchPlanRequestSchema` 无 path 字段（`workbench-schemas.ts` 201–231）。 |

普通工作空间插件变更有独立日志：`plugin-mutation.json` + profile 证据拷贝（1592–1644）。`recover` **不重放**插件变更；仅整 Home restore 成功才清日志（582–588）。单独 mutation 打开且无 restore/upgrade journal → 失败并保持证据（540–544）。

### 1.4 已有事务：DSH runtime，不是工作台

`runtime.upgrade` 用户路径完整：preview → plan（5 分钟 fingerprint）→ `CoordinatedUpgrade.upgrade(version, planId)`。

`src/main/coordinated-upgrade.ts` 164–252, 272–297：

1. drain / `stopAll`
2. `snapshots.create(..., "upgrade")`
3. journal `preparing`（含可选 `planId`）
4. `runtimes.install`；暂存 Home；只重钉 `@deepseek-ai/dsh-base` / `dsh-web-app`（`PROTECTED_PLUGIN_PACKAGES`）；第三方（含 `@dsh-spaces/plugin`）pin 变化则失败（348–350）
5. verify + web smoke
6. journal `committing`；提交 profiles；`runtimes.select`；清 journal

失败：`committing` 才 `rollbackSnapshot`；`preparing` 只清 journal + 丢 stage，**不**回滚 Home。`recover()`：先 snapshot pending restore，否则 `committing` 才 `upgradeRolledBack`；preparing 清掉返回 `{}`。

维护接线（`workbench-maintenance.ts` 495–498, 519–611, 1148–1169）：`withMaintenance` 成功后 `reinitializeManager`；不确定错误保持 maintenance。`recovery.resume` 只按 **planId/snapshotId** 结算（supervisor 1998–2032）：`snapshot.restore` 成功、`runtime.upgrade` 被回滚、`plugin.*` 被整 Home restore 覆盖。preparing 中断的 upgrade job **不会**被标 succeeded。

Doctor 复用同一 `CoordinatedUpgrade.recover()` / `restore(snapshotId)`（`packages/doctor/src/recover.ts` 20, 607–613, 786–789）。快照替换 `profiles/sessions/storages/hub/settings.yaml/cordis.patch.yml`，**保留** `.dsh-spaces-control` 与凭据（doctor 126–128；`src/shared/snapshots.ts` 1–8）。**不包含** `{home}/../.dsh-spaces-tools`。

Electron `src/main/updater.ts` 6–13：打包桌面应用 `autoUpdater`，与监督 payload / 管理插件无关。

---

## 2. 缺口（为何构不成自升级闭环）

1. **无用户命令。** `WorkbenchPlanRequest` / schema / UI 无 `workbench.upgrade`（全库无此标识）。Runtime 页只预览 DSH `runtime.upgrade`（`components.tsx` 573–609）。实施记录已写明：当前主要是 runtime/整 Home，不能自动当完整自升级（`tasks/workbench-implementation.md` 117）。

2. **活监督永不换码。** 附着成功则跳过 payload 拷贝与 spawn。监督更新只能冷启动（派工约束 + `bootstrapSupervisor` 实现）。运行中的监督无法用新 bits 替换自身。

3. **已安装管理包不刷新。** `existing === "manager" && !pending` 直接 return（807）。新监督带着新 tgz 启动，只要 profile 里已有包名，就不会 `pluginAdd`。`inspectManagerInstall` 不读版本。本地同版本换内容时，读回仍会显示“已是 manager”。

4. **无工作台 journal。** `hasMaintenanceEvidence` 只认 restore/upgrade/mutation/plugin-mutation（1605–1614）。tools 目录、`coldstart.lock`、payload digest 都不进恢复。快照回滚 Home **不会**撤掉已拷到 `.dsh-spaces-tools` 的新监督；反之，只换 tools 而不换管理包，下次 manager 启动仍从**旧插件内嵌 payload** 打包。

5. **不能借用 `plugin.install`。** 管理空间 forbidden；`@dsh-spaces/plugin` guarded。目录 seed 无该包。浏览器不能传路径。

6. **不能借用 `CoordinatedUpgrade.upgrade()`。** 它安装 DSH CLI、重钉官方 base/web、web smoke。`preparing` 中断丢 journal 不清 Home。把它扩成监督二进制暂存会变成第二套回滚机，且与“监督只能冷启动”冲突（升级算法在旧监督进程内跑完 commit）。

7. **同版本 `plugin add` 读回未证。** `pluginAdd` 把 hub tgz 交给 DSH `plugin add file:...`（`plugin-ops.ts` 132–148）。package 仍为 `0.2.0` 时，pnpm/DSH 是否替换 node_modules **没有产品证据**。施工必须用归档 digest/内容读回，不能只信包名。

8. **view-bridge 与监督必须同次替换。** 冷启动总是两个 tgz 一起传；只换其中一个会分裂。现有引导无“已安装则跳过单个 artifact”的细粒度。

---

## 3. 建议：最小可施工 API（复用事务，不新造回滚机）

### 3.1 合同（Codex 单写 `src/shared/workbench.ts` + schema）

```ts
| { kind: "workbench.upgrade"; catalogId: string; version: string }
```

- 浏览器只给 catalogId + 精确版本；禁止 path/file/git/URL。
- 服务端将 catalogId **解析为且仅允许** `@dsh-spaces/plugin`（或将来目录里受保护的官方工作台条目）。禁止任意插件/主题装进 manager。
- `WorkbenchPlan.scope: "home"`；`destructive: true`；changes 必须写明：停全部 owned、替换管理包+view-bridge、用户主动冷启动。失败则报告并保留现场。**失败则 restore 该快照：已撤销**（2026-09-15）。提交前候选失败不切换当前指针，不是回滚。
- Job result 可沿用 `snapshotId` + 现有 `runtimeVersion` **不要**滥用；工作台身份用服务端日志/control 记录，不把磁盘路径回给浏览器。
- 无后续发布版本时：服务端用当前 payloadRoot `packLocalArtifacts`（已存在），**不改 package 版本号**；预览 fingerprint 含 payload/plugin **content digest**。测试/验收可注入 artifact 路径，DTO 仍无路径。

不要加 `workbench.installFromPath`。不要让 `plugin.install` 对 manager 开例外。

### 3.2 执行顺序（旧监督还活着时做 Home 侧；然后冷启动）

复用现成步骤，禁止新写 stage/smoke/commit 状态机：

1. **preview/plan/fingerprint/TTL** — `WorkbenchMaintenance.buildPlan` 现有计划文件（`PLAN_SCHEMA=1`，5 分钟，执行前重算 fingerprint）。fingerprint 增加：manager 包读回、hub 归档 digest、当前 tools dest digest、pending restore/upgrade journal（已有 journal 字段）。
2. **`stopAll`** — 已有 ports。
3. **不要**把 `snapshots.create` / SnapshotExecutor 当作升级失败的回滚源。整 Home 快照恢复 **已撤销**。当时建议用它做唯一回滚源，不再作为可施工合同。
4. **`writePluginMutation`** — 扩展 `expected`：允许 **仅此 kind** 对 manager 执行 `FULL_SPACES_PACKAGE`（及 view-bridge）的 install。其它 kind 仍 forbidden。失败标 `phase:failed`，不重放。
5. **替换归档 + `pluginAdd`** — 复用 `installArtifact`（supervisor 857–863），**即使** `inspectManagerInstall==="manager"`。归档 id 保持 `dsh-spaces-plugin` / `dsh-spaces-view-bridge`，快照含 `hub/`。
6. **读回** — 不能只查包名。至少：hub tgz digest、profile 依赖指向该归档、必要时解包 `package.json` name=`@dsh-spaces/plugin`。同版本换内容失败则保持 mutation 日志并走步骤 8。
7. **control 标记（不是第二套回滚）** — 例如 `.dsh-spaces-control/workbench-upgrade.json`：`{schemaVersion:1, planId, snapshotId, pluginDigest, payloadDigest, phase:"plugin-committed"}`。然后 **`controller.shutdown` / `close()`**（已有 release 路径）。旧监督退出。
8. **失败/中断** — 报告失败或结果无法确认，保留标记与证据。**不要** `CoordinatedUpgrade.restore` / `upgrades.recover()`。整 Home 回滚 **已撤销**。不要回滚 tools 目录（content-addressed 残留无害）。
9. **冷启动** — 仅用户主动再次打开管理 profile：附着失败则按正常冷启动拷 payload / spawn。digest 与标记不一致：显示错误并 fail closed，**不**设 `recoveryRequired`、不走恢复步骤。
10. **结算** — job 终态 `succeeded` / `failed` / `cancelled`。禁止 restore 完成后把升级标成回滚成功。doctor 不 settle 恢复 job。

**不要**调用 `CoordinatedUpgrade.upgrade()`。**不要**在旧监督进程内替换自己的可执行文件。

同版本本地验证：步骤 5–6 用 pack 出的 tgz（文件名可仍含 `0.2.0`），digest 变化即可；禁止改仓库 package 版本。

### 3.3 文件责任（给 root 固定接口后派工）

| 文件 | 责任 | 不要做 |
| --- | --- | --- |
| `src/shared/workbench.ts` | 增加 plan kind；Codex 合同作者 | 不把路径放进 DTO |
| `packages/plugin/src/host/workbench-schemas.ts` | 同步 schema；catalogId+exact version | 不放宽 manager 普通插件 |
| `packages/plugin/src/workbench/{store,components,i18n}.ts` | 独立“工作台”维护入口，不是 Runtime 页冒充 | 不开放 manager 普通 install |
| `src/adapters/node/workbench-maintenance.ts` | preview/execute/mutation/fingerprint；调用 ports，不 spawn 监督 | 不复制 CoordinatedUpgrade |
| `src/adapters/node/workbench-maintenance-ports.ts` | 一个窄回调，如 `replaceManagerWorkbench(artifacts)` / `shutdownForColdUpgrade()` | 不把路径交给维护层拼 CLI |
| `src/adapters/node/workbench-supervisor.ts` | 实现 ports：已安装仍 `installArtifact`；写/清 upgrade 标记；shutdown；结算新 kind | 不在 `bootstrapManager` 热更新活进程 |
| `packages/plugin/src/host/supervisor-bootstrap.ts` | 已有 digest dest；可选把 payloadDigest 写入可检验记录 | 不改附着/租约失败语义 |
| `packages/plugin/src/host/supervisor-pack.ts` | 已有本地 pack；验收复用 | 不把 tgz 写回插件树 |
| `packages/doctor/src/recover.ts` | 识别新标记；仍只 `restore(snapshotId)` / 现有 recover | 不新写 tools 回滚 |
| `src/main/coordinated-upgrade.ts` | **只读复用** `restore`/`recover`/`snapshots.create` | 不把工作台编进 runtime stage |
| `tests/workbench-maintenance.test.ts` + `workbench-supervisor.test.ts` + `workbench-plugin.test.ts` | 同版本 digest 换包、已安装仍刷新、活监督不换码、restore 回滚、浏览器无路径 | 不改 package 版本号做验收 |

并行时：合同与 schema 由 Codex 单写；维护与监督不要同时改 `workbench.ts`。

---

## 4. 验证范围（本叶子）

**已做：** 只读对照 `src/shared/workbench.ts`、`src/adapters/node/workbench-supervisor.ts`、`workbench-maintenance.ts`、`workbench-maintenance-ports.ts`、`src/main/coordinated-upgrade.ts`、`packages/supervisor/src/index.ts`、`packages/plugin/src/host/{supervisor-bootstrap,supervisor-pack,supervisor-attach,runtime,plugin,workbench-manager,workbench-schemas,identity}.ts`、`packages/plugin/src/workbench/{store,components}.ts`、`src/main/{plugin-ops,plugin-library,updater}.ts`、`packages/doctor/src/recover.ts`、相关测试与 `tasks/workbench-{contract,implementation,audit}.md`。

**未做：** 未跑测试、未启动监督/DSH/浏览器、未打本地 tgz、未验证同版本 `plugin add` 是否替换 node_modules。上述第 7 条为未验证风险，不是已证缺陷。

**未验证假设：** 旧监督 shutdown 后 endpoint 呈 `stale`（ping 失败）而非 `dead/ambiguous blocked`，否则冷启动会被 attach 拒绝（`supervisor-attach.ts` 58–69 vs bootstrap 118）。施工必须规定：shutdown 删除或作废 `endpoint.json`，或允许 `stale` 冷启动（已有）且 **dead 租约需用户 acquire/reclaim**，不能在升级路径里自动清锁。
