# B5 SnapshotStore 去掉 restore 算法

日期：2026-09-20。本叶写入：

- `src/main/snapshot-store.ts`
- `tests/snapshot-store.test.ts`
- `tests/maintenance-responsiveness.test.ts`
- `packages/doctor/src/recover.ts`
- `tests/workbench-doctor.test.ts`
- `scripts/workbench-fault-snapshot-worker.ts`
- `tests/fixtures/workbench-crash/snapshot-worker.ts`
- `tasks/merge-b5-snapshot-store.md`

未改 Supervisor、core restore-session、snapshot-executor/worker（已抽出）、Git、构建、CLI flags。未读真实 `~/.dsh`。故障政策仍是 [let it crash](../docs/let-it-crash.md)。

## 删除

- 可达 `restore` / `recover` / `completeRestore` 算法
- 私有 `backupCurrent` / `stageIncoming` / `swapManaged` / `isDataSwapped` / `finishSwapped` / `rollbackSwap`
- 仅恢复使用的 `writeJournal` / `writePending` / `writeRecoveryReceipt` / `pendingFromJournal` / `currentPresence`
- Doctor `recover.ts` 整段离线恢复/rollback 实现（CLI `index.ts` 本来就不引用）
- 故障夹具对 `SnapshotStore.prototype.restore` 的假注入，以及 fault worker 默认 `delete` 回落

`restore` / `recover` / `completeRestore` 现为显式 unsupported，供现有类型编译。

## 保留

- 正常 `create` / `list` / `preview` / `delete` / `runtimeRoot` / `runtimeBin`
- 只读 `pendingRestore` / `restoreJournal` / `recoveryReceipt`（损坏/未知原字节）
- `copyLinkedTree` / `retargetTree` / `clearRuntimeFallback`（升级 stage IO）
- 用户快照目录、manifest schema、managed home 条目；不删已有备份
- pending 证据挡住 create/delete（不提供 complete 入口）

## 测试覆盖（保留）

创建与校验、路径穿越、in-use 删除、create 失败不发布、内外链接/junction、已发布 runtime 再创建、CLI fallback 链接省略、pending/journal/receipt 只读留证、restore 方法无写入拒绝。

去掉原 restore 中断重试、rollback 收据、data-only backup、连续 restore junction 等数百行死测。

维护响应性：sync/worker **create** 心跳；worker restore/completeRestore 拒绝且 pending 原字节保留。Doctor recover 仍 UNSUPPORTED；夹具改写 pending 文件，不再调用 `store.restore`。

## 验证

```
npx tsx --test tests/snapshot-store.test.ts tests/maintenance-responsiveness.test.ts tests/workbench-doctor.test.ts tests/spaces-doctor.test.ts
```

## 仍需主 Agent 接线

- `src/core/application/restore-session.ts`（其它叶删除中）
- `tests/workbench-maintenance.test.ts` `executorFromStore` 仍把 restore 映射到 SnapshotStore
- `scripts/verify-workbench-crash.mjs` 若仍注入 `restore:swap` 等 restore hook

不是 B5 完成，也不是全部遗留恢复模块已清理。
