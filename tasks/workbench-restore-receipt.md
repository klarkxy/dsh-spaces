> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。
# Workbench restore receipt（叶子交接）

日期：2026-09-12。分支：`codex/spaces-pluginization`。角色：施工叶子。未 Git、未 build 正式包、未启动 DSH/浏览器/监督进程。

## 1. 结论及完成状态

已在 SnapshotStore 增加持久 `restore-receipt.json`，区分完整恢复与物理回滚。`recover()` 仍返回 `PendingRestore | undefined`。上层 CoordinatedUpgrade / Maintenance / Supervisor / doctor **未接线**，不宣称 job 结算闭环已完成。

## 2. 本叶写入（绝对路径）

- `D:\0 code\dsh-spaces\src\shared\snapshots.ts`
- `D:\0 code\dsh-spaces\src\main\snapshot-store.ts`
- `D:\0 code\dsh-spaces\src\main\snapshot-executor.ts`
- `D:\0 code\dsh-spaces\tests\snapshot-store.test.ts`
- `D:\0 code\dsh-spaces\tasks\workbench-restore-receipt.md`

未改 `snapshot-worker.ts`、`src/shared/workbench.ts`、CoordinatedUpgrade、WorkbenchMaintenance、Supervisor、doctor。

## 3. 接口

- `PendingRestore` / `RestoreJournal`：optional `planId`（严格 UUID）。缺省时旧桌面 JSON 不含该字段。
- `RestoreRecoveryReceipt extends PendingRestore { schemaVersion: 1; outcome: "completed" | "rolled-back" }`
- `SnapshotRestoreOptions.planId?` 写入 journal/pending。
- `SnapshotStore.restoreJournal()` / `recoveryReceipt()`：无文件 `undefined`；坏 JSON、`schemaVersion !== 1`、非法字段 throw 并保留原文件。
- Receipt 在 snapshot store root `restore-receipt.json`，不在 `MANAGED_HOME_ENTRIES`。
- `rollbackSwap`：物理回滚后、删 journal/stage/pending 前原子写 `rolled-back`。
- `completeRestore`：删 pending/journal 前原子写 `completed`。
- 写失败不删 journal/pending。新 restore 不因旧 receipt 拒绝；新结果原子替换。`recover()` API 不变。
- `SnapshotExecutor` 同步只读代理上述两方法；`recover` 仍走原 worker 消息。

## 4. 本叶验证

```
npx tsx --test tests/snapshot-store.test.ts
```

覆盖：swap 前/部分 swap 中断后新 Store recover 可读 rolled-back receipt；completeRestore completed receipt；精确 planId；receipt 写失败保留 journal/pending；重复 recover 结果不变；无 planId 旧格式；坏/未来 receipt 拒绝且保留。临时目录 fixture，不杀 root 服务。

## 5. 未验收 / 需 root 接线

- CoordinatedUpgrade.recover 读 `recoveryReceipt()`，返回 `restoreRolledBack` 与凭据字段。
- Workbench `snapshot.restore` 透传 stored planId。
- Maintenance 无 pending 时仍识别 journal/receipt 并驱动 recover。
- Supervisor/doctor 仅 exact planId 结算；回滚不得标 succeeded；无 planId 旧 job 保持 recovery-required。
- 真实 `scripts/verify-workbench-crash.mjs` 由 root 跑。
