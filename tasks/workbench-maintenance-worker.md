## 当前有效合同（2026-09-15）

故障政策：[docs/let-it-crash.md](../docs/let-it-crash.md)。活动账本：[todo.md](todo.md)。

隔离、鉴权、单写者、原子写、错误报告，以及用户主动的启动、停止、重启、安装、卸载和配置，仍有效。救援入口、检查并恢复、恢复中断任务、配置恢复、整 Home 恢复、Doctor `unlock`/`recover`/`rollback`、失败回滚、失败重试和中断续接 **已撤销**，不是延期，不勾成已完成。剩余运行时工作见账本 R1–R6（pending）。下文是当时实施与验收记录，不是现行恢复门槛。

> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。
# Workbench maintenance（C 叶子交接，审计重试）

主Agent复验补充：25项测试通过，包含真实DSH清单格式对应的file:本地包引用、已安装package.json版本及锁文件读回；缺少安装文件不能报成功。该验证仍是隔离文件fixture，实际pnpm/Chromium/升级验收待整合。

日期：2026-09-12。分支：`codex/spaces-pluginization`。本轮只修审计反例，不扩范围。

## 结论

`WorkbenchMaintenance` 已按根作者反例修正：pendingRestore 抛错不再被当成无 pending；recover 每次重置 outcome；无 snapshot/upgrade 日志不得 settle 无关 job；有 pending 时先 stopAll 再 recover；未知 journal 不启动 manager；插件失败不把 package.json 冒充回滚；计划一次消费；withMaintenance 仅在 live 已证明一致时才 reinitialize。

未改 ports 公共 types、`src/main`、supervisor、A1/A2。

## 产物

- `D:\0 code\dsh-spaces\src\adapters\node\workbench-maintenance.ts`
- `D:\0 code\dsh-spaces\tests\workbench-maintenance.test.ts`
- `D:\0 code\dsh-spaces\tasks\workbench-maintenance-worker.md`

## 签名（未改公开方法名）

```ts
preview(request): Promise<WorkbenchPlan>
execute(planId, ctx): Promise<WorkbenchJobResult | void>
plugins(query) / snapshots() / snapshot(id) / runtimes() / backups(spaceId)
recover(ctx?): Promise<void>
recoveryOutcome(): WorkbenchRecoveryOutcome | undefined
```

`WorkbenchRecoveryOutcome.settleInterruptedJobs` 仅在**实际调和了 pending snapshot 或 upgrade journal** 后为 true。空 journal 时 `consistent` 只表示这些维护事务已检查为无 pending，`settleInterruptedJobs` 为 false。监督不得据此伪造取消或批量清 space/plugin 中断任务。

新增错误码：`workbench/conflict`（plan 已执行）。

## 行为变化

1. `inspectPendingRestore`：抛错 → `unreadable`，recover 失败，`consistent:false`，`settleInterruptedJobs:false`。根反例 `.sandbox/workbench-maintenance-root-repro.ts` 现输出该结果。
2. recover 入口先重置 outcome。未知/不可读 journal：`setMaintenance(true)` 作进度，**不** `reinitializeManager`，不 finally 装成正常。
3. 有 pending/合法 journal：maintenance → `stopAll` → `upgrades.recover` → 再确认 journal 无歧义 → `reinitializeManager` → `setMaintenance(false)`。stopAll 失败不调用 recover。
4. 插件变更把 package.json / pnpm-lock / cordis.patch.yml 复制到 `.dsh-spaces-control/plugin-mutation-files`，元数据 `plugin-mutation.json`。失败保留证据并保持目标停止；成功按 package.json、listProfilePlugins、可选 node_modules 与 lock 读回校验。
5. `config.restore`：`diagnostics.restoreBackup` 会 stop。管理 profile 随后 `setMaintenance` + `reinitializeManager`；普通空间不自动 start。
6. plan `status: previewed|running|succeeded|failed|cancelled`。execute 先校验再标 running。非法 planId / 非 ISO expiresAt / schema≠1 拒绝且不改文件。
7. `withMaintenance` 失败时：pendingRestore 可读为空且无 upgrade journal 才 reinitialize；否则保留 maintenance flag 与 journal。不把 reinit 错误盖住原错误。

## 监督 / 根需接的点（不改公共 types）

- `CoordinatedUpgrade` 构造时设 `onProgress: ({ phase, detail }) => { ctx.phase(phase); if (detail) ctx.message(detail); }`。本模块拿不到已构造实例的 onProgress。
- `createMaintenance: (ports) => new WorkbenchMaintenance(ports)`。
- 仅当 `recoveryOutcome()?.settleInterruptedJobs === true` 时 settle **对应的 snapshot/upgrade** 中断 job。空 journal 或插件 mutation 未完成时不要批量 `cancelled`。
- `options.log` 接本地日志。`setMaintenance` 只是进度；`recoveryRequired` 由 outcome + 真实 journal 决定。

## 验证

`npx tsx --test tests/workbench-maintenance.test.ts` — **23 pass**。

根反例：`npx tsx .sandbox/workbench-maintenance-root-repro.ts` → `recover threw` 且 `consistent:false, settleInterruptedJobs:false`。

覆盖新增：unreadable pending、outcome 重置、空 journal 不 settle、stopAll 失败不 recover、未知 journal 不启动、插件 node_modules/lock 不一致、中断后 recover 判断、plan 一次消费、非法 schema/日期保留、manager vs 普通 config restore、升级失败 live 一致可重启 vs leftover journal 不得启动。

未启动真实 DSH / npm / Playwright。安装成功路径仍注入 pluginAdd + packument fetch。

## 未覆盖

- SnapshotExecutor worker、真实 pnpm、0.1.5-rc.2 门禁、committing swap 中崩溃的真实回滚。
- 监督 HTTP 接线与 onProgress 绑定（根作者）。
- 控制目录证据不含 `node_modules` 整树（只拷贝 package.json/lock/patch）。
