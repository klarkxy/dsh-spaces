## 当前有效合同（2026-09-15）

故障政策：[docs/let-it-crash.md](../docs/let-it-crash.md)。活动账本：[todo.md](todo.md)。

隔离、鉴权、单写者、原子写、错误报告，以及用户主动的启动、停止、重启、安装、卸载和配置，仍有效。救援入口、检查并恢复、恢复中断任务、配置恢复、整 Home 恢复、Doctor `unlock`/`recover`/`rollback`、失败回滚、失败重试和中断续接 **已撤销**，不是延期，不勾成已完成。剩余运行时工作见账本 R1–R6（pending）。下文是当时实施与验收记录，不是现行恢复门槛。

> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。
# Workbench 维护分发验收脚本（审计重试交接）

日期：2026-09-12。分支：`codex/spaces-pluginization`。只改本叶子两个文件。未改产品源码，未跑真实 DSH/Chromium。

## 结论

针对主 Agent 实跑 `all` 的测试缺陷做了验收脚本修正，**不是产品修复**。根上次结果：plugins 全过；`snapshot.create` 成功；`snapshot.restore` 查询 job 遇 `ECONNRESET` 即进入 catch/cleanup；`runtime.install` 查询 job 30s 超时同样截断。当时 snapshot 任务已到 reinitialize、runtime 仍在 install。

本轮保持严格 FAIL，但长操作会在原 `JOB_MS`/`RUNTIME_MS` 内收齐终态再结束。不能声称 SnapshotExecutor / CoordinatedUpgrade / RuntimeStore 已修好。现行验收改为：失败可见、无额外恢复性修改；`snapshot.restore` 成功不再是通过条件。

## 产物

- `D:\0 code\dsh-spaces\scripts\verify-workbench-maintenance-product.mjs`
- `D:\0 code\dsh-spaces\tasks\workbench-maintenance-product-worker.md`

未改 supervisor、maintenance、RuntimeStore、锁文件或其它脚本。

## 脚本行为变化

**job 查询**

- 状态查询改走 `fetch`（5s/次），不再用 Playwright 30s `context.request` 一失败就抛
- transport（`ECONNRESET`、超时、`fetch failed` 等）在整体时限内有限退避重试（250ms→2s），**不重新 submit**
- 每次 transport 记 `at` + 脱敏摘要，写入该 phase 的 `observations.jobs[]`
- supervisor 已退出：立刻 FAIL，带 `exitCode`/`signal` 与最后 job 快照
- 未退出：继续查到 terminal 或整体超时；超时仍 FAIL，保留 last status/phase/transport 次数
- 入口持续失联仍 FAIL，不靠放宽 `JOB_MS`/`RUNTIME_MS` 掩盖

**稳定入口心跳（每个 job）**

- 独立 `GET /`，1s 间隔、3s 超时、无并发重叠
- 记录 maxGetMs、失败样本、最大连续不可用
- 连续失联 > 3s：该验收 FAIL；先收 job 终态再抛。单次 reset 且 3s 内恢复 ≠ 进程崩溃；恢复后成功 ≠ 入口通过（看 maxGap，不看最后一次）

**仅测试 preload 探针**

- phase 目录生成 `event-loop-probe.cjs`
- `node --require <probe> packages/supervisor/lib/index.js ...`
- 只挂监督主进程：`monitorEventLoopDelay` + interval lag，超 100ms 写 pid+lag 到 stderr，进入脱敏 `supervisor.log`
- 不设 `NODE_OPTIONS`（spawn env 删除该键），避免 DSH 子进程/worker 继承
- 产物只在 `.sandbox/workbench-maintenance-product/<phase>/`

**更强读回**

- config.restore：`livePatch === applyIsolationPatch(sourceBackup, coding, livePath)`（`packages/core/lib` 的 PatchWriter 同一转换），并检查 isolation 文本；不只看文件存在/bak 数量
- snapshot marker：主证据 `hub/coding/sessions/maintenance-marker.txt`（非 JSONL，不进合法会话）；保留 `sessions/coding/maintenance-marker.txt` 作整 Home 额外覆盖

**未改**

- 覆盖矩阵、主题包 `@eternalnight/dsh-theme@0.5.1`（root 已修 `parsePluginKey`，plugins 实跑已过）
- 刷新/同 `requestId` 不新建 job
- `/view` 仍断言 200 + `location.replace`

## 用法（同前）

```
node scripts/verify-workbench-maintenance-product.mjs
node scripts/verify-workbench-maintenance-product.mjs --phase snapshot
```

结果：`.sandbox/workbench-maintenance-product/results.json`（含 `phases.*.observations`、`supervisorExit`）。失败保留 Home/log。

## 覆盖 / 未覆盖

现行覆盖：plugins 安装卸载读回、runtime install+upgrade rc1（提交前失败不切换指针）、rc2 upgrade 拒绝、requestId 幂等、关浏览器不结束服务。config restore 与整 Home 快照恢复成功：**已撤销**，不再作为本脚本通过条件。当时脚本仍调用那些 API，是 R4/R6 差距，不是继续验收恢复成功。

本叶子未跑真实 DSH/Chromium。snapshot/runtime 产品响应性由另一叶子修，本脚本只避免测试自己截断证据。

## 本叶子验证

- `node --check` 语法
- 静态 import 不启动 supervisor
- 未启动服务、未声称产品已修好
