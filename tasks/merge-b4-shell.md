# B4 桌面壳接线修正

2026-09-20。范围：桌面壳叶（`src/main/index.ts`、`view-manager`/`tray`、`desktop-shell-*`、preload/renderer、`src/shared/desktop-shell.ts`、i18n、本叶测试与本报告）。未改 Electron build、Host、共享工作台 UI。

## 改动

1. 本地 preload 改为 `../preload/index.cjs`（`shellPreloadPath`）。本地窗口与远程 view 均 `sandbox: true`、无 Node。
2. 删除平行 `DesktopWorkbenchApi/State/Plan/Job` 与宽容 parser。停空间/停服务使用 `Pick<WorkbenchApi,'state'|'preview'|'submit'|'job'>` 与 `WorkbenchJob` 全文（含 `result`/`error`）。CAS 用 `workbenchMutationContextSchema`（64 hex）。缺 plan `serviceEpoch` 拒绝。
3. 「停止全部空间」只停确认时冻结的 `managed===true && id!==web && id!==managerId` 且 running/starting 的普通工作空间；manager 与 `managed:false` 不进集合；操作中新建空间不纳入。坏 state 拒绝，不当空列表成功。停整个服务才走 `service.shutdown`。
4. 打包 payload root：`resources/spaces-payload/lib`（完整插件包根为 `resources/spaces-payload`，含 `package.json`+`cordis.patch.yml`+`lib`）。开发仍 `packages/plugin/lib`。
5. `prepare`/`start` 在清 busy 之后再 `snapshotAndEmit`；`seq` 防止旧回包覆盖；同操作 inflight 去重；`viewGeneration` 避免两次 `presentWorkbench` 消费两个 bootstrap token。renderer `aliveRef` 忽略卸载后结果。
6. 准备/启动在标题栏。首装 CliSetup 仅 idle 可安装；失败卡与连接失败卡只有详情和复制脱敏日志，无 retry/启动按钮。

## 本叶证据

- `tests/frontend-recovery.test.ts`：25 pass。新增动态回归：`coalesceInflight` 并发合并、成功后再跑、失败后再跑；`openWorkbenchSession` 未 ready 不创建；stop-all 在 epoch 变化后停住并保留先前 job；所有权变化不记入 stopped。
- `tests/write-paths.test.ts`：pass。
- `tests/i18n.test.ts`：因新增 shell 文案一并跑过。

这些是源码不变量和带真实 v2 字段的纯函数夹具，不是真实 Electron，也不是 Host HTTP 已把 context 送进 submit/preview。

## 运行时修正（review 后）

1. `session.fromPartition` 只在 `app.whenReady` 里、创建窗口/view 之前，经 `openWorkbenchSession(app.isReady(), ...)`。`ViewManager` 必须传入已有 `Session`，不再自己 `fromPartition`。
2. `coalesceInflight` 把 `holder.current` 设为 `start()` 返回的同一 promise，`finally` 按该 identity 清空。并发合并，成功或失败之后的下一次显式调用会再跑。
3. `stopOwnedSpaces` 整批绑定初始 `serviceEpoch`。epoch 变了不再对新区 stop。所有权变化或目标消失记 `failed/remaining`，不把它们算进 `stopped`。已成功的 job 留在 `job`。

## Host 仍在接线

- `createWorkbenchHttpClient` 是否把 `submit/preview` 的 context 写入请求体，由 Host/协议叶负责。壳已按 3 参调用真实 `WorkbenchApi`。
- 打包 `extraResources` 复制完整 `@dsh-spaces/plugin` 到 `resources/spaces-payload` 由主 Agent 配置。
- 真实 Electron：CJS preload + sandbox、退出不 stop 后台、双客户端，由主 Agent 验收。
- `desktop-llm` / `ProcessManager` 等已断开，清理不在本叶。
