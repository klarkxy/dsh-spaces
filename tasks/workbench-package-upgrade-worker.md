# 工作台管理包升级模块（审计重试交接）

日期：2026-09-13。分支 `codex/spaces-pluginization`。只改三个指定文件。未 Git / 发布 / 真实 DSH / 浏览器。

## 1. 结论及完成状态

**审计六条已在本模块落地，fixture 17 项 PASS。不是产品闭环。**

`recover` 现返回 `WorkbenchPackageRecovery`，`abandoned` 与 `succeeded` 可区分。回滚先 `stopAll` 再 `upgrades.recover({receiptPlanId})`，仅在尚未完成本快照时才 `restore`。坏 receipt / 路径身份 / junction 拒绝并留证据。`hasEvidence` 不把目录、junction、不可读节点当成没有。候选/已装读回含 `lib/supervisor/{manifest.json,index.js,snapshot-worker.mjs}`。冷恢复不自行启动 manager。

## 2. 产物（绝对路径）

- `D:\0 code\dsh-spaces\src\adapters\node\workbench-package-upgrade.ts`
- `D:\0 code\dsh-spaces\tests\workbench-package-upgrade.test.ts`
- `D:\0 code\dsh-spaces\tasks\workbench-package-upgrade-worker.md`

## 3. 接口（root 接线）

```ts
export interface WorkbenchPackageRecovery {
  planId: string;
  rolledBack: boolean;
  outcome: "succeeded" | "rolled-back" | "abandoned";
  snapshotId?: string;
}

upgrades: Pick<CoordinatedUpgrade, "restore" | "recover">
recover(ctx, planId?: string): Promise<WorkbenchPackageRecovery | undefined>
```

- `recover(ctx, planId)` 只读/消费这一个 exact plan，不返回全部旧 receipt。root 用 `unfinishedPlanIds` 选择消费。
- 冷恢复成功或放弃 **不** 调用 `reinitializeManager`；由 root 最终统一恢复 manager。
- 本模块只在 `execute` 成功路径和 **execute 进程内 rollback** 各启动 manager 一次。
- 活动标记：`.dsh-spaces-control/workbench-upgrade.json`
- 结算：`.dsh-spaces-control/workbench-upgrade-receipts/<planId>.json`；先落盘再删 marker。已存在 receipt 必须与拟写 `planId/snapshotId/outcome` 一致，否则拒绝。
- 读回关键文件另含实际 payload：`lib/supervisor/manifest.json`、`lib/supervisor/index.js`、`lib/supervisor/snapshot-worker.mjs`（`packages/plugin/lib/supervisor`，build 从 `packages/supervisor/lib` 拷入）。
- tar 读取仍为 async spawn/`execFile`，有超时和 16MiB 条目上限。

## 4. 本叶子验证

```
npx tsx --test tests/workbench-package-upgrade.test.ts
```

**17 passed / 0 failed**，约 17s。新增/区分回归：

- `outcome: abandoned` 可与 `succeeded` 区分（stopAll 失败结算 abandoned，execute 仍 throw）
- 第一次 restore 中断留下 journal 后，第二次 recover 先 `upgrades.recover` 完成，不再二次 restore
- 坏 JSON / 未来 schema / planId 或 snapshotId 不匹配的 receipt 保留，不能当成本次成功
- 同版本仅 supervisor payload 字节变化 → `updateAvailable`
- 目录/junction 占 marker 路径时 `hasEvidence()===true`
- receipts 目录 junction 拒绝写入，marker 保留
- `ProcessTerminationError`（含 snapshot 前 stopAll）保留证据、不 rollback

## 5. 未实际验收 / 风险

- 未跑真实 `dsh plugin add` / 真实 SnapshotStore journal
- 未接 doctor 结算、未冷启动新监督 payload
- 未真实 DSH / 浏览器 / 正式 build
- Windows 无管理员权限时 file symlink 未测；junction 回归已跑过
- persist 失败路径用 junction/非文件占位模拟，不是磁盘满

root 继续真实安装与冷启动验收。不要把本模块测试当成工作台自升级产品完成。
