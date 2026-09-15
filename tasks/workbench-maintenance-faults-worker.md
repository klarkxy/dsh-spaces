> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。
# Workbench 真实维护故障验收（叶子交接）

日期：2026-09-12。分支：`codex/spaces-pluginization`。角色：独立叶子 executor。未改产品源码、未改共享清单、未 Git/推送/发版。未启动真实 DSH/Chromium/监督进程。

## 1. 结论及完成状态

已交付两类真实故障验收脚本和专用测试驱动，**不是分发产物完全验收，也不是产品修复**。

- 故障注入走**源码测试缝**：`createWorkbenchSupervisor({ createMaintenance })` 设置已有 `CoordinatedUpgrade.opts.inject`；`SnapshotExecutor` 使用专用 worker，worker 内构造原 `SnapshotStore({ inject })`，不另写事务算法。
- 崩溃后的正式恢复入口走**打包** `packages/supervisor/lib/index.js` 的 `recovery.resume`，失败再跑打包 `packages/doctor/lib/index.js recover`。
- 心跳门槛未放宽：稳定入口 1s 间隔、3s 超时、连续不可用 > 3s 仍 FAIL（仅 SIGKILL 期望进程退出的那一段不把失联当产品心跳失败）。
- `scripts/verify-workbench-maintenance-product.mjs` **不能安全 import**：顶层 `parseFlags(process.argv)`。本脚本只复用 `verify-spaces-distribution.mjs` 的 seed/pack/授权/cleanup 辅助，并按该产品脚本的真实流程重写计划 job/读回。

## 2. 产物（绝对路径）

- `D:\0 code\dsh-spaces\scripts\verify-workbench-maintenance-faults.mjs`
- `D:\0 code\dsh-spaces\scripts\workbench-fault-supervisor.mjs`
- `D:\0 code\dsh-spaces\scripts\workbench-fault-snapshot-worker.ts`
- `D:\0 code\dsh-spaces\tasks\workbench-maintenance-faults-worker.md`

未改 supervisor/maintenance/jobs、CoordinatedUpgrade、SnapshotStore、package.json、锁文件或其它脚本。不覆盖旧测试 Home；默认输出 `.sandbox/workbench-maintenance-faults/`，每 phase 独立 `mkdtemp` Home。

## 3. 脚本行为

`--phase upgrade-throw|restore-kill|upgrade-kill|all`（`all` = 前两项）。`--self-check` 只做语法/bundling/安全 import。默认 `--http-only`（bootstrap 303 cookie）；`--with-browser` 才用 Playwright。长日志：`run.log` + `results.json` 增量写。

| phase | 注入 | 期望 | 恢复入口 |
| --- | --- | --- | --- |
| upgrade-throw | 源码缝 `commit:swap` **throw** | 原 CoordinatedUpgrade catch 回滚；job failed；原 marker/配置/runtime hash；manager running；普通空间 stopped | 故障驱动进程内（非打包） |
| restore-kill | 专用 worker `restore:swap` **SIGKILL(process.pid)** | 监督进程真实退出；同 Home 冷启打包监督先 `recoveryRequired` + 原 job `recovery-required`；再 resume 或 doctor；数据回到 restore 前 changed hash；未证明 job 不得 succeeded；入口 200 | 打包 supervisor / doctor |
| upgrade-kill | 源码缝 `commit:retarget` **SIGKILL** | 同上冷启恢复；数据/runtime 回到升级前 hash；未证明 job 不得 succeeded | 打包 supervisor / doctor |

证据：`markers/fault-marker.json`（hook/pid/action）、监督 `exitCode/signal`、upgrade/restore journal 与 jobs/plans 拷贝、managed 文件前后 sha256。cleanup 只 `stopOwned` 本脚本 spawn 的进程树；实例目录里未知存活 PID 只记 `leftoverInstances`，不按端口杀、不杀不明进程。

Worker 在运行时 esbuild 到输出目录 `fault-snapshot-worker.mjs`（不改 `packages/supervisor/lib/snapshot-worker.mjs`）。Worker 线程 `process.pid` 即监督 Node PID。

## 4. 本叶子验证（未跑真实 DSH）

```
node scripts/verify-workbench-maintenance-faults.mjs --self-check
```

覆盖：两份 mjs `node --check`；产品脚本静态判定 unsafe 故不 import；`verify-spaces-distribution.mjs` 安全 import；esbuild worker 后 `--check`；`node --import tsx scripts/workbench-fault-supervisor.mjs --self-check`（只 import TS 模块，不 `createWorkbenchSupervisor()`）。

未覆盖：真实 rc1 CLI、打包桥、runtime.upgrade、snapshot.restore、SIGKILL、冷启、resume/doctor、3s 心跳实跑。

## 5. 交 root 串行实跑

最终跑必须用最新 build（root 正在修 runtime 入口卡死）。不要放宽心跳。

```
npm run build:spaces
node scripts/verify-workbench-maintenance-faults.mjs --self-check
node scripts/verify-workbench-maintenance-faults.mjs --phase upgrade-throw
node scripts/verify-workbench-maintenance-faults.mjs --phase restore-kill
node scripts/verify-workbench-maintenance-faults.mjs --phase upgrade-kill
node scripts/verify-workbench-maintenance-faults.mjs
```

预计：upgrade-throw / upgrade-kill 各 15–25 min（真实 install+smoke+commit）；restore-kill 8–15 min；`all` 约 25–40 min。结果 `.sandbox/workbench-maintenance-faults/results.json`。失败保留该 phase Home/log。

未跑边界：真实 DSH 与打包监督；Windows 上 SIGKILL 的 `signalCode` 可能不是字符串 `SIGKILL`（以 marker + 进程已退出为准）；job↔journal `planId` 精确关联仍可能被另一 Grok 改动，脚本以磁盘 job 状态和 hash 为准；upgrade-kill 不在 `all` 内。Git/发布禁止。
