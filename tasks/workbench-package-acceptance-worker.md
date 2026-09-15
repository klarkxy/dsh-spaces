## 当前有效合同（2026-09-15）

故障政策：[docs/let-it-crash.md](../docs/let-it-crash.md)。活动账本：[todo.md](todo.md)。

隔离、鉴权、单写者、原子写、错误报告，以及用户主动的启动、停止、重启、安装、卸载和配置，仍有效。救援入口、检查并恢复、恢复中断任务、配置恢复、整 Home 恢复、Doctor `unlock`/`recover`/`rollback`、失败回滚、失败重试和中断续接 **已撤销**，不是延期，不勾成已完成。剩余运行时工作见账本 R1–R6（pending）。下文是当时实施与验收记录，不是现行恢复门槛。

> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。
# 工作台管理包更新验收脚本（叶子交接）

日期：2026-09-13。分支 `codex/spaces-pluginization`。只改三个指定文件。未 Git / 发布 / 真实 DSH / 浏览器 / 联网。本叶只做语法与安全 self-check。

## 1. 结论及完成状态

已交付可被 root **串行实跑**的管理包更新验收脚本与 source-seam driver。**不是产品闭环，本叶未跑真实安装/回滚。**

- `--phase success`：复用 `.sandbox/workbench-maintenance-network-acceptance/results.json` 的 `phases.runtime.home`，`npm pack` 当前 `packages/plugin` 与 `view-bridge` 到新输出 `packed/`，用最新 `packages/supervisor/lib` 启动。候选来自同版本不同内容，不改版本、不造假包、不写 `node_modules` 当安装。无 candidate 则 fail/uncovered，不模拟。
- `--phase rollback`：source-seam driver（明确非打包产品故障注入）。`options.pluginAdd` 调用原 `pluginAdd`；仅 digest 命名的 view-bridge（升级第二次 add）故意 throw，第一包必须已真正 installed。manager bootstrap 的 `dsh-spaces-plugin.tgz` / `dsh-spaces-view-bridge.tgz` 不注入。失败后走生产整 Home snapshot rollback。
- 冷启动只读时正式 `POST controller.acquire` 回收已证明死的自有记录，不假定 `tryOwn` 自动抢权。
- 任务只从 `state.jobs` 与 `POST /api/workbench/job {id}` 按 **exact job id** 读取，没有 `/jobs` 端点，不把任意 `recovery-required` 当匹配。

## 2. 产物（绝对路径）

- `D:\0 code\dsh-spaces\scripts\verify-workbench-package-upgrade.mjs`
- `D:\0 code\dsh-spaces\tests\fixtures\workbench-package\driver.ts`
- `D:\0 code\dsh-spaces\tasks\workbench-package-acceptance-worker.md`

未改 production / doctor / 锁文件 / 依赖 / 其它脚本。

## 3. 用法

```
node scripts/verify-workbench-package-upgrade.mjs --self-check
node scripts/verify-workbench-package-upgrade.mjs --phase success
node scripts/verify-workbench-package-upgrade.mjs --phase rollback
node scripts/verify-workbench-package-upgrade.mjs --phase all
node scripts/verify-workbench-package-upgrade.mjs --http-only
```

结果：`.sandbox/workbench-package-acceptance/results.json`、phase 截图、过滤后的 supervisor 日志。长操作默认 15 min（`--job-ms`，上限 900000）。`--http-only` 未跑真实 UI 时该 phase 记 `partial`，**不是 pass**。

Home：只允许 network-acceptance 的 `phases.runtime.home`，或本脚本在 `.sandbox/workbench-package-acceptance` 内新建的 Home。资源目录读该 Home `.dsh-spaces-control/toolchain.json` 的 `nodeExe` / `bin` / `toolchainRoot` / `runtimeRoot` / `snapshotRoot` 传 Supervisor，不换新输出目录。清理只发 `controller.shutdown`，`stopOwned` 只对自己 spawn 的 ChildProcess。

## 4. API / UI 合同（脚本按此调用）

- `POST /api/workbench/workbenchPackage` `{}` → release 或 `null`
- preview `{kind:'workbench.upgrade',catalogId:'bundled-workbench',version}`（实跑用读回 version，当前包为 `0.2.0`）
- submit `{command:{kind:'plan.execute',planId},requestId}`
- 公共 DTO 断言不含 path/token/cookie/bootstrap
- 浏览器：稳定入口引导按钮（`#acquire` / DSH Continue|继续|稍后配置）→ Runtime 页 `[data-workbench-package]` → `[data-workbench-upgrade]` preview → 计划对话框确认。不 mock、不 `route.fulfill`。Playwright cookie 来自 bootstrap 导航，不 `addCookies({url, path})`。

success 读回（现行）：关键 lib 与 `lib/supervisor/{manifest.json,index.js,snapshot-worker.mjs}` 哈希变化、入口 3s 内心跳、普通空间仍停、原 job 持久 `succeeded`。整 Home 快照与 “manager 恢复”不是通过条件。

rollback 读回：**已撤销**（2026-09-15）。升级失败应保持失败现场并报告；不要求 before/after 哈希一致、不要求 receipt `rolled-back`、不把管理器再拉起来当通过。当时脚本仍测回滚，是 R4/R6 差距。

## 5. 本叶子验证

```
node --check scripts/verify-workbench-package-upgrade.mjs
node scripts/verify-workbench-package-upgrade.mjs --self-check
```

覆盖：mjs 语法；invoked guard；不 import 会自动执行的 maintenance/product/interactions；distribution helpers 可安全 import；driver `--self-check` 与 `--allow-real-home` / 生产 Home 拒绝；exact job id；入口心跳用 async fetch。不启动监督/DSH/Chromium。

## 6. 未实际验收 / 风险

- 未跑真实 `dsh plugin add`、未开 Playwright、未冷启动 packed supervisor
- 若当前 `npm pack` 结果与 network-acceptance 已装 tarball 哈希相同，脚本会 uncovered/fail，不会造假 candidate（需要先 `build:spaces` 使 lib 内容不同）
- `all` 时 success 会改写复用 Home；rollback 另建 `.sandbox/workbench-package-acceptance` 内新 Home，先用旧 artifact bootstrap 再注入
- Windows 上 DSH 引导按钮文案若变化，UI 路径会超时；`--http-only` 仍可走持久任务但只能 `partial`

root 继续真实安装与故障回滚串行验收。不要把本叶 self-check 当成工作台自升级产品完成。
