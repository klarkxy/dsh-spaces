## 当前有效合同（2026-09-15）

故障政策：[docs/let-it-crash.md](../docs/let-it-crash.md)。活动账本：[todo.md](todo.md)。

隔离、鉴权、单写者、原子写、错误报告，以及用户主动的启动、停止、重启、安装、卸载和配置，仍有效。救援入口、检查并恢复、恢复中断任务、配置恢复、整 Home 恢复、Doctor `unlock`/`recover`/`rollback`、失败回滚、失败重试和中断续接 **已撤销**，不是延期，不勾成已完成。剩余运行时工作见账本 R1–R6（pending）。下文是当时实施与验收记录，不是现行恢复门槛。

> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。
# Workbench doctor recover/rollback（叶子交接）

日期：2026-09-12。分支：`codex/spaces-pluginization`。实例 `workbench-doctor-recovery`。

## 结论（当时实现事实；recover/rollback/unlock 作为产品能力已撤销，见文首与 R5）

独立 doctor CLI 的 `recover` / `rollback` 已接到现有 `CoordinatedUpgrade` + 进程内 `SnapshotStore` + `RuntimeStore`，不再返回 `RECOVERY_UNAVAILABLE` 完成标记。只读 `doctor` 仍不写 Home。浏览器/管理 DSH 损坏时 CLI 可离线跑，不启动 DSH 服务、监督进程或第二 controller。该接线是 2026-09-12 落地事实，不是继续建设恢复的授权。

## 产物

- `D:\0 code\dsh-spaces\packages\doctor\src\index.ts`
- `D:\0 code\dsh-spaces\packages\doctor\src\common.ts`
- `D:\0 code\dsh-spaces\packages\doctor\src\inspect.ts`
- `D:\0 code\dsh-spaces\packages\doctor\src\resources.ts`
- `D:\0 code\dsh-spaces\packages\doctor\src\recover.ts`
- `D:\0 code\dsh-spaces\packages\doctor\README.md`
- `D:\0 code\dsh-spaces\tests\spaces-doctor.test.ts`
- `D:\0 code\dsh-spaces\tests\workbench-doctor.test.ts`
- `D:\0 code\dsh-spaces\tasks\workbench-doctor-worker.md`

未改 root 清单、build、shared、Node 适配器、旧 main。

## 行为（现行合同）

- 临时控制权：`HomeController.acquire("web")` 若仍用于诊断，只表示独立 CLI 观察，不是新 kind，也不是恢复授权。
- 活/身份不明锁与子实例：拒绝，不杀 PID，不换目录，**不清锁、不 reclaim**。
- `unlock` / `recover` / `rollback` / `settleRecovery` / 整 Home 快照回滚：**已撤销**。R5 返回不支持 + 非零退出。坏 schema 保留原字节，报告无法读取。
- 插件 mutation：只报告证据。不要求整 Home 快照回滚，不还原单份 manifest。
- 诊断写路径仅观察 `0.1.5-rc.1` / `0.1.5-rc.2`。不得在检查时更新 runtime 指针。
- 资源旗标作输入读取。缺可信字段就报需补旗标，不猜 AppData。
- 工具自身不要放在会被用户数据树替换的 Home 里。不得为恢复再启 SnapshotStore worker。

2026-09-12 实现曾让 proven-dead 经 `recover`/`unlock` reclaim，并在 rollback 成功后 settle jobs。那是历史接线，不是继续建设的合同。

## 根需接线字段

`toolchain.json` 现有绑定记录不够恢复。根在监督 bootstrap 写入时请补：

```json
{
  "version": 1,
  "bin": "<absolute dsh bin>",
  "nodeExe": "<absolute node>",
  "dshVersion": "0.1.5-rc.1",
  "boundAt": "<iso>",
  "runtimeRoot": "<absolute RuntimeStore root>",
  "snapshotRoot": "<absolute SnapshotStore root>",
  "toolchainRoot": "<absolute toolchain root, optional>"
}
```

这些字段为 Node-only 私有记录，不得进入浏览器 DTO。doctor 已按该约定读取；缺省时必须显式传 `--snapshot-root` 与 `--runtime-root`。

## 审计重试

- remaining job / 不可解析记录：`ok:false` `RECOVERY_REQUIRED` 退出码 10，不打印 Offline recovery finished。
- runtime 读回失败：不结算 jobs，不标成功。
- 整 Home 恢复后同步 `toolchain.json` 的已验证 `bin`/`dshVersion`，保留 `nodeExe` 与资源根。
- plugin-mutation：upgrade preparing 不清；整 Home 后归档 journal、保留 files；只结算本次 snapshot / mutation `planId` 匹配的 job/plan。

## 验证（本叶子）

`npx tsx --test tests/spaces-doctor.test.ts tests/workbench-doctor.test.ts` — **26 pass, 0 fail**。

反例：截断 job + 无证据 plugin/running + 不同 snapshot 的 restore job → `RECOVERY_REQUIRED` 退出 10，原字节保留，不打印 finished。runtime package.json 损坏 → 不结算 queued。upgrade preparing + plugin-mutation 保留 journal。整 Home rollback 归档 mutation、只 failed 匹配 planId，其它 snapshot job 仍 recovery-required；再跑 recover 不再 `PLUGIN_MUTATION_OPEN`。toolchain `bin`/`dshVersion` 同步且 `nodeExe`/roots/`boundAt` 保留。

未跑真实 DSH / Electron / 浏览器 / 根 `build:spaces`。不改全局环境权限。
