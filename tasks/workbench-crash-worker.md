> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。

现行通过条件（取代下文“恢复成功 / recovery.resume / doctor 回滚”）：kill 后失败可见、无自动恢复、无额外 spawn/恢复调用。`test:workbench:recovery` 不得整组删除；与恢复无关的覆盖保留。本叶未跑真实 DSH 的事实不变。

# Workbench 真实维护崩溃验收（审查重试交接）

日期：2026-09-12。分支：`codex/spaces-pluginization`。角色：独立叶子。未改 runtime/Node/desktop 生产文件、未 Git。未启动真实 DSH/Chromium/CLI 服务。

## 1. 结论及完成状态

已按派工路径迁移四个文件，并改掉复制 dispatcher。测试 worker **补丁 `SnapshotStore.prototype.restore` 后动态加载生产 `src/main/snapshot-worker.ts`**，因此 `runtimeInstall`、async `errorName`/`ProcessTerminationError`、子进程记账随生产 worker 走，不会落入 `delete(undefined)`。

`--allow-real-home` 在 driver 直接拒绝；生产 Home 拒绝且不回显凭据。restore:swap 在真正 swap 前 kill，读回必须保持 **pre-restore** hash；若 resume/doctor 因缺少已证明 rollback 收据仍 `recovery-required`，脚本记 **blocked/FAIL** 并保留证据，不会把未知 job 当成恢复完成。

**真实 DSH 相未跑。** 只完成 `--self-check`。

## 2. 产物（绝对路径）

- `D:\0 code\dsh-spaces\scripts\verify-workbench-crash.mjs`
- `D:\0 code\dsh-spaces\tests\fixtures\workbench-crash\driver.ts`
- `D:\0 code\dsh-spaces\tests\fixtures\workbench-crash\snapshot-worker.ts`
- `D:\0 code\dsh-spaces\tasks\workbench-crash-worker.md`

旧路径已删除：`scripts/verify-workbench-maintenance-faults.mjs`、`scripts/workbench-fault-supervisor.mjs`、`scripts/workbench-fault-snapshot-worker.ts`、`tasks/workbench-maintenance-faults-worker.md`。

## 3. 脚本行为

| phase | 注入 | 数据期待 | 恢复入口 | 未证明收据 |
| --- | --- | --- | --- | --- |
| upgrade-throw | `opts.inject` `commit:swap` throw | 原 hash/runtime；manager running；普通空间 stopped | 源码 driver 进程内 | job failed |
| restore-kill | 生产 worker + restore inject，`restore:swap` SIGKILL | **pre-restore（changed）hash**，不是 snapshot 原件 | 打包 supervisor `recovery.resume`，失败再 doctor | 仍 `recovery-required` → **blocked**；settled succeeded → FAIL |
| upgrade-kill | `commit:retarget` SIGKILL | 升级前 hash/runtime | 同上 | 同上 |

`all` = upgrade-throw + restore-kill。默认输出 `.sandbox/workbench-crash/`。心跳 3s 未放宽。cleanup 只杀本脚本 spawn 树。

## 4. 本叶子验证

```
node scripts/verify-workbench-crash.mjs --self-check
```

应覆盖：mjs 语法；产品脚本 unsafe 不 import；distribution helpers 安全 import；生产 worker 含 `runtimeInstall`/errorName/观察记账；测试 worker 源码无复制 `store.delete` dispatcher；esbuild bundle 保留新 operation；driver `--self-check` 与 `--allow-real-home` 拒绝。不启动监督/DSH。

## 5. 可能缺口（交 root 串行）

- 物理 rollback 成功但 jobs 无法证明时，脚本会 **blocked** 而不是放宽通过。这是产品收据缺口，不是把未知 job 标完成。
- Windows SIGKILL 的 `signalCode` 可能不是字符串 `SIGKILL`。
- 最终跑必须最新 `build:spaces`（含生产 snapshot-worker 的 `runtimeInstall`）。root 仍在真实双端验收。

```
npm run build:spaces
node scripts/verify-workbench-crash.mjs --self-check
node scripts/verify-workbench-crash.mjs --phase upgrade-throw
node scripts/verify-workbench-crash.mjs --phase restore-kill
node scripts/verify-workbench-crash.mjs --phase upgrade-kill
node scripts/verify-workbench-crash.mjs
```

预计 upgrade-throw / upgrade-kill 各 15–25 min，restore-kill 8–15 min，`all` 约 25–40 min。Git/发布禁止。
