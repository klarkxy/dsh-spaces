# Workbench 维护期间入口响应性（审查重试交接）

日期：2026-09-12。分支：`codex/spaces-pluginization`。角色 executor。未 Git、未跑真实 DSH/Chromium。

## 1. 结论及完成状态

snapshot 相已过（`.sandbox/workbench-maintenance-product/snapshot-success.json`）。runtime.install **任务成功**（`versions/0.1.5-rc.1` 25280 文件，`meta.json` `installedAt=12:43:34Z`），但稳定入口断了 4018ms（门槛 3000ms 未改）：

- `runtime/supervisor.log`：`maxMs=4263.5 intervalLagMs=4114`
- `results.json`：job `succeeded/install`，heartbeat `maxGapMs=4018`、`maxGetMs=3012`、`outageFail=true`

因果：上一轮已把 copy/rm 移出主循环，**发布整树仍用主线程 `renameSync`**。产品树 2.5 万文件，Windows `MoveFileEx`/扫描器会把这一次 syscall 卡在主事件循环上。升级路径同类：`retargetTree`/`renameDirectory`/`clearRuntimeFallback` 仍在主线程整树走。

已修（本叶子范围）：

- `RuntimeStore.installOnce` 发布 `staging→versions/<ver>` 改为 `fs.promises.rename`，扫描器锁用 `setTimeout` 重试（不用 `Atomics.wait`）
- CoordinatedUpgrade 的 rename / retarget / clearRuntimeFallback 复用 snapshot-worker
- 保留 root 的 `observeChild`/`spawnCandidate`、worker 授权、async completeRestore

**隔离测试完成。产品 runtime 相未跑。** `ensureNode` 的 `renameSync` 在 `toolchain.ts`，不在写入范围，交 root。

## 2. 产物

- `D:\0 code\dsh-spaces\src\main\runtime-store.ts`
- `D:\0 code\dsh-spaces\src\main\snapshot-worker.ts`
- `D:\0 code\dsh-spaces\src\main\snapshot-executor.ts`
- `D:\0 code\dsh-spaces\src\main\coordinated-upgrade.ts`
- `D:\0 code\dsh-spaces\tests\maintenance-responsiveness.test.ts`
- `D:\0 code\dsh-spaces\tasks\workbench-maintenance-responsiveness-worker.md`

未改 supervisor/workbench-maintenance、toolchain、atomic、snapshot-store、build/manifest、其它 tests。未覆盖 `spawnCandidate`/`observeChild`。

## 3. 接口接线

Worker 操作新增：`renameTree` / `retargetTree` / `clearRuntimeFallback`（仍走现有 `runSnapshotWorker`）。

RuntimeStore 无 workerFile，大目录发布用 `fs.promises.rename`（libuv 线程池，不堵 HTTP）。

## 4. 验证

```
npx tsx --test tests/maintenance-responsiveness.test.ts tests/coordinated-upgrade.test.ts tests/runtime-store.test.ts
→ 36 pass / 0 fail，38s
npx tsx --test tests/snapshot-store.test.ts
→ 18 pass / 0 fail，7.5s
```

新增：sync `renameSync` 大树 vs RuntimeStore 异步发布；sync `retargetTree` vs worker retarget。原 upgrade commit/inject/junction 回归绿。探针 `listen(0)`，避开 3100–3199 / 34000–34999。3 秒门槛未改。

## 5. 未验证 / 交 root

- 未跑打包 supervisor 产品 runtime 相。
- **`src/main/toolchain.ts:302-305`** `ensureNode` 仍 `renameSync` 抽出的 Node 发行目录（本现场 `home-F2JXfZ/node/node-v22.23.2-win-x64` ~2000 文件）。主线程 MoveFileEx 仍可能破 3s。请改成 `fs.promises.rename`（或 worker），重试不要用 `Atomics.wait`。
- **`src/main/atomic.ts:13-22`** `renameDirectory` 的 `Atomics.wait` 堵事件循环。升级路径已改到 worker 内调用；其它主线程调用方若 rename 大目录仍会卡。
- 重打包 `src/main/snapshot-worker.ts` → `packages/supervisor/lib/snapshot-worker.mjs` 后再串行跑产品 runtime。
