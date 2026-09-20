# B5 workbench-maintenance 私有恢复链清理

日期：2026-09-20。只写：

- `src/adapters/node/workbench-maintenance.ts`
- `tests/workbench-maintenance.test.ts`
- `tasks/merge-b5-workbench-maintenance.md`

未改 Supervisor、ports、packageUpgrade、Git。未读真实 `~/.dsh`。故障政策仍是 [let it crash](../docs/let-it-crash.md)。

## 删除（不可达）

- `recoverLocked`（原 553–691：packageUpgrade.recover、upgrades.recover、stopAll、reinitialize、写 recovery outcome）
- `runSnapshotRestore` / `runConfigRestore`（会调 `upgrades.restore` / `diagnostics.restoreBackup`）
- `planSnapshotRestore` / `planConfigRestore`
- `resetRecoveryOutcome` / `setFailedRecovery` / `keepMaintenanceFlag` / `verifyRecoveredRuntime` / `hasRunningPlan` / `persistProfileEvidence`
- `liveHomeConsistent` / `homeConfigReadable`（仅 recoverLocked 使用，不是当前准入）
- `containedHomeEntry` / `sameResolved`

公开 `recover()` 仍直接 `workbench/forbidden`。`this.recovery` 不再被写入。

## 保留

- 正常 plugin / runtime / snapshot create/delete、`storeable(Omit<WorkbenchPlan,'id'|'serviceEpoch'|'stateRevision'>)`、serviceEpoch/revision、失败部分信息
- `inspectPendingRestore` / `readUpgradeJournal`：fingerprint 与 snapshot.delete 准入
- `ResolvedCommand` 的 `snapshot.restore` / `config.restore`：preview/parse/`requestFromCommand`/execute switch 单一 unsupported 拒绝，无 worker 调用
- 导出 `WorkbenchRecoveryOutcome` / `recoveryOutcome()`：Supervisor 仍 import；现始终 `undefined`

## 测试

误导标题改为实际 unsupported 留证拒绝（不增加可恢复路径）。仍 36 项。

```
npx tsx --test tests/workbench-maintenance.test.ts
```

## 残留类型（给其它写者）

- `WorkbenchRecoveryOutcome` 字段未收缩
- Supervisor `recoveryOutcome?()` / `settleProvedRecoveryJobs`
- harness 仍可 stub `recoverUpgrade` 以证明不被调用
