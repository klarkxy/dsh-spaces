# Workbench jobs（A2 叶子交接）

## 当前有效合同（2026-09-15）

故障政策：[docs/let-it-crash.md](../docs/let-it-crash.md)。接口：[workbench-contract.md](workbench-contract.md)。实现任务：**R2 pending**。

目标状态：`queued → running → succeeded / failed / cancelled`。

删除作为产品要求：`recovery-required`、恢复冻结、`settleRecovery`、`recovery.resume`、先结算恢复再允许普通任务。

进程中断后重开：读取原任务，展示中断失败或结果无法确认，保留最后阶段和证据，不重放命令，不对账修补。幂等 `requestId` 仍保留。损坏 JSON 或未知 schema 只报告无法读取，保留原字节。

**已知实现差距：** 下列签名与冻结策略描述的是 2026-09-12 已落地的代码，不是现行合同。R2 删除前不得把恢复 hold 当成新功能继续扩建。

> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。

日期：2026-09-12。分支：`codex/spaces-pluginization`。组合 Store/Runner，不持有 Home 运行权，不启动 HTTP/DSH/Playwright。本叶不是整体维护实现。

## 结论

`WorkbenchJobStore` 仍是可被 Supervisor runtime 调用的组合 Store/单进程串行 runner。审计修正已落地：严格 schema、恢复冻结、显式 `settleRecovery`、公共投影收紧。任务目录：`canonicalHome/.dsh-spaces-control/jobs`。

未改公共 DTO、`home-controller.ts`、工作台 UI、A0 脚本、锁模块、`package.json`。

## 产物

- `D:\0 code\dsh-spaces\src\adapters\node\workbench-jobs.ts`
- `D:\0 code\dsh-spaces\tests\workbench-jobs.test.ts`
- `D:\0 code\dsh-spaces\tasks\workbench-jobs-worker.md`

## 签名

现有 `submit` / `job` / `get` / `list` / `cancel` / `whenIdle` 保持兼容。新增：

```ts
export interface WorkbenchJobSettle {
  status: "succeeded" | "failed" | "cancelled";
  result?: WorkbenchJobResult;
  message?: string;
}

export class WorkbenchJobStore {
  constructor(options: WorkbenchJobsOptions);
  readonly home: string;
  readonly jobsDir: string;
  submit(command: WorkbenchCommand, requestId: string, handler: WorkbenchJobHandler): Promise<WorkbenchJob>;
  job(id: string): WorkbenchJob;
  get(id: string): WorkbenchJob;
  list(): WorkbenchJob[];
  cancel(id: string): Promise<WorkbenchJob>;
  settleRecovery(id: string, settlement: WorkbenchJobSettle): Promise<WorkbenchJob>;
  whenIdle(): Promise<void>;
}
```

`WorkbenchJobContext` 未改：`signal` / `phase` / `message` / `cancellable` / `result`。

## 加载与证据

- 只把 `lstat` 的 `ENOENT` 当成 jobs 目录/文件不存在。其它读错误或非真实目录进入恢复，不当 empty。
- `schemaVersion` 必须是数字 `1`。filename stem、`id`、`requestId` 必须一致。
- 未知 schema、坏 JSON、缺 command、filename/id 不一致、无效终态（例如 succeeded 带路径 `runtimeVersion`）→ 内存 `recovery-required`，**保留原文件字节**，绝不改写另一个合法 job 文件。
- 形状合法的遗留 `queued`/`running` 仍落盘为 `recovery-required` 并保留原 phase/command（中断标记，不是销毁证据）。

## 恢复冻结（默认策略）

任一 `recovery-required` 会打开内部 hold：

1. 已排队且尚未开始的非 `recovery.resume` 任务立即取消，不跑 handler。用户需重新发起。
2. 新的非恢复 `submit` 拒绝（`workbench/recovery-required`）。同 id 幂等返回仍允许。
3. `{ kind: "recovery.resume" }` 在 hold 期间可以入队并执行，避免恢复任务被饿死。
4. 每一个中断 job 都由调用者在核对实际事务 journal 后 `settleRecovery`。本模块不重放原 command。
5. 全部 `recovery-required` 消失后解除 hold，之后才能提交普通变更。

`settleRecovery` 仅接受当前为 `recovery-required` 的 id。调用者必须已持有 A1 运行权；本模块不建锁、不检查 journal。

## 公共投影

- `runtimeVersion` 只接受 `isExactRuntimeVersion`（拒绝路径/tag/range）。
- `view.origin` 必须是精确 `http://127.0.0.1:<port>`（无 path/query/hash/credentials）。
- `view.entryPath` 必须是同源相对路径（拒绝 `//host`、绝对 URL、query、token、credentials）。
- 未知 `Error` 的 `job.error` 固定为目录文案 `workbench/failed`，不把底层报错正则后当安全。
- `ctx.message` / `settleRecovery.message` 可以是受控业务文案，仍做 path/token/cookie 筛查。

## 验证

`npx tsx --test tests/workbench-jobs.test.ts` — 20 pass。`tsc --noEmit -p tsconfig.node.json` 通过。未启动 HTTP/DSH/Playwright。

新增反例（不镜像实现）：schemaVersion 999 看似 succeeded、filename/id 冲突不覆盖邻接合法文件、缺 command、终态路径 version、jobs 路径是文件而非目录、两 job 排队后 first 第 3 次 write 失败冻结 second、未知 Error 静态文案、origin query token、`//host` entryPath、credentials origin、settle 拒绝路径 version。

## 未覆盖 / 风险

- 未接入 Supervisor HTTP 或 A1 运行权门；构造/settle 约定由调用者先持锁。
- 未测跨进程崩溃窗口（rename 前后）。
- 无 job TTL/GC。
- 不是整体维护/恢复执行器；`recovery.resume` 的真实 journal 核对在 runtime。

## runtime 使用流程

1. A1 已持有该 Home 运行权后 `new WorkbenchJobStore({ home })`。
2. `list()` 若含 `recovery-required`：不要提交普通变更。提交 `{ kind: "recovery.resume" }`，handler 读真实事务 journal，决定回滚/完成，再 `settleRecovery(interruptedId, { status, result?, message? })`。
3. 不要把原 command 再 `submit` 一次当重放。被 hold 取消的未开始任务默认作废，用户重新发起。
4. 全部中断 job 结算后才能 `submit` 普通命令。查询只用 `job`/`list`，磁盘 JSON 和内部 command 不送给浏览器。
