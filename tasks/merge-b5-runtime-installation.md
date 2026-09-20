# B5 runtime 安装 IO 抽出

日期：2026-09-20。本叶写入：

- `src/adapters/node/runtime-installation.ts`
- `src/main/snapshot-worker.ts`
- `src/main/snapshot-executor.ts`
- `tests/runtime-installation.test.ts`
- `tests/coordinated-upgrade.test.ts`（候选进程存活观察）
- `tasks/merge-b5-runtime-installation.md`
- `tasks/merge-b5-coordinated-upgrade.md`（补 kill 观察）

未改 `snapshot-store.ts`、Supervisor、构建、CLI flags、其它 worker 夹具。未读真实 `~/.dsh`。无新线程池。故障政策仍是 [let it crash](../docs/let-it-crash.md)。

## 实际修改

`runRuntimeInstallation(input)` 承载 RuntimeStore install / toolchain，并包 `observeMaintenanceChild`。生产 `snapshot-worker` 的 `runtimeInstall` 只调用它；RuntimeStore 在有 `installWorker` 时仍走现有 worker 离环。可选 `run` 只给测试注入 npm IO。

Worker 对 `restore` / `recover` / `completeRestore` 明确拒绝，不再落到 `store.delete`。`SnapshotExecutor` 这三项本地 unsupported，供现有类型消费者编译；`pendingRestore` / `restoreJournal` / `recoveryReceipt` 与 `create` / `list` / `delete` / `runtimeBin` / `runtimeRoot` 以及 copy / rename / retarget / clearFallback 仍在。

升级候选停杀：主跑 `child.exitCode` 仍为 null 是 Node 字段滞后。测试在字段未到时改查 OS `process.kill(pid, 0)` ESRCH；进程仍活则失败。未放宽 `terminateProcessTree`。

## 验证

```
npx tsx --test tests/coordinated-upgrade.test.ts tests/runtime-installation.test.ts
```

## 仍需主 Agent 接线的消费者

- `tests/maintenance-responsiveness.test.ts` 的 worker `completeRestore` 用例
- `src/core/application/restore-session.ts`
- `packages/doctor/src/recover.ts`
- `scripts/workbench-fault-snapshot-worker.ts`、`tests/fixtures/workbench-crash/snapshot-worker.ts`
- `snapshot-store.ts` 底层 restore（约定下一叶）

不是 B5 完成，也不是全部遗留恢复模块已清理。

Primary verification: restricted sandbox repeated the candidate-process failure and kill(pid,0) still observed a live process. This was not proven to be only an exit-event race. Scoped elevated execution of the same two suites passed 26/26 with disposable Home and owned child processes.
