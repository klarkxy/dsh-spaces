# Workbench doctor recover/rollback（叶子交接）

日期：2026-09-12。分支：`codex/spaces-pluginization`。实例 `workbench-doctor-recovery`。

## 结论

独立 doctor CLI 的 `recover` / `rollback` 已接到现有 `CoordinatedUpgrade` + 进程内 `SnapshotStore` + `RuntimeStore`，不再返回 `RECOVERY_UNAVAILABLE` 完成标记。只读 `doctor` 仍不写 Home。浏览器/管理 DSH 损坏时 CLI 可离线跑，不启动 DSH 服务、监督进程或第二 controller。

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

## 行为

- 临时控制权：`HomeController.acquire("web")`，表示独立 CLI 控制，不是新 kind。
- 活/身份不明锁与子实例：拒绝，不杀 PID，不换目录。proven-dead 仅 `recover`/`unlock` 可 `reclaimDead`/`unlockDead` 且二次检查。
- 只回收明确 dead 的本 Home 实例记录；给定 PID 不会 kill。
- `WorkbenchJobStore` 仅在持有 lease 后实例化。queued 未开始可 cancelled；running 的未知 space/plugin 不自动清。`settleRecovery` 拒绝不可读记录。坏 schema 保留原字节。
- 插件 mutation：报告并要求整 Home 快照回滚，不还原单份 manifest。整 Home rollback 证明成功后可为被覆盖的相关变更结算 failed，审计文件保留。
- 写路径仅验证 `0.1.5-rc.1`。`0.1.5-rc.2` 仍只允许 `verify`。
- 资源：`--cli` / `--snapshot-root` / `--runtime-root` 优先，否则读 `.dsh-spaces-control/toolchain.json`。已读 `version,bin,nodeExe,dshVersion,boundAt`，并约定读取后续 Node-only `runtimeRoot`/`snapshotRoot`/`toolchainRoot`。缺可信字段就报需补旗标，不猜 AppData、不把空目录当旧快照。
- 工具自身不得位于被恢复替换的 Home。SnapshotStore 进程内同步，无第二 worker。

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
