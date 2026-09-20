# B5 download bounds：deadline 与 body 释放

2026-09-20。未改 Git、Supervisor、DSH CLI 诊断、shared schema、UI、build。未读真实 `~/.dsh`。未跑 package-upgrade 全组。

默认 HTTP deadline 是 **180000 ms**（`DOWNLOAD_TIMEOUT_MS`），不是 20s。测试可注入更短 `timeoutMs`。

写入：`src/adapters/node/plugin-ops.ts`、`tests/plugin-library.test.ts`、`tests/workbench-package-upgrade.test.ts`（仅 afterEach）、`tasks/merge-b5-download-bounds.md`。

## 本轮四点

1. `createDownloadControl` 与 byte limits 改到 `enqueuePlugin` 回调内。排队等待不消耗 deadline。父 signal 已 abort 时在回调开头拒绝。
2. `close()` 在清 timer/listener 之外 abort 内部 controller，释放未消费的 HTTP body/socket；不 abort 父 signal。
3. `reader.cancel()` 使用 `.catch(() => undefined)`，abort 时无 unhandled rejection；不 await 无界 cleanup。
4. package-upgrade `afterEach` 恢复严格 `rmSync`（`maxRetries: 3`, `retryDelay: 50`），不再静默忽略 EPERM/EBUSY。

## 计数（准确）

Root 此前：60 = plugin 6 + library 19 + package-upgrade 35（59 pass，1 为 afterEach EPERM，隔离复跑通过，非行为失败）。package-upgrade 35 = 先前 32 + prepare cancel/timeout 2 + 同组 wrong-bridge 1。

本轮 library 由 19 增至 21（queue 后才开始 deadline；non-ok 停滞 body 时内部 signal abort、父 signal 不变）。package-upgrade 仍 35，本轮未重跑。

## 实测

```text
npx tsx --test --test-concurrency=1 tests/plugin-library.test.ts
```

**21 pass / 0 fail**（约 0.9s）。含原 19 项与本轮 2 项。package-upgrade 35 与 plugin 6 未跑。
