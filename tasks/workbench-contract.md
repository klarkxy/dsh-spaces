# 工作台接口与所有权合同

现行固定合同是 [merge-contract-v2.md](merge-contract-v2.md)，细化 [合并计划](../docs/plans/spaces-merge-convergence.md)。`src/shared/workbench.ts` 仍由主 Agent 协调。本文件是现行公开行为摘要，不是第二套协议。

故障政策：[docs/let-it-crash.md](../docs/let-it-crash.md)。历史恢复要求见 [history-recovery.md](history-recovery.md) 与下方历史段，不是现行门槛。

## 通信

- 浏览器以 `WorkbenchApi` 为准。监督 HTTP：`POST /api/workbench/<method>`，JSON，查询也 POST。方法白名单和逐方法校验；精确校验管理 Origin。普通子空间不得调用管理 API。
- 成功 `{ok:true,value}`，失败 `{ok:false,error:{code,message}}`。不得增加 `recoveryPlan`、`suggestedFix`、`autoRetry`。
- 协议版本 **2**。`WorkbenchState` 含 `protocolVersion`、`serviceEpoch`、`revision`、`availability`。`submit(command, requestId, context)` 与 `preview(request, context)` 的 `context` 为 `{ serviceEpoch, expectedRevision }`。缺失、多余字段或 epoch/revision 不符明确拒绝。比较在串行执行边界完成。
- 同 `requestId` 同命令读同一 job；同 ID 不同命令拒绝。刷新只读该 job，不重放。
- 危险或停机动作先 preview 再 `plan.execute`。公开 `WorkbenchPlan` 带 `serviceEpoch` 与 `stateRevision`。过期 epoch 的计划不能执行。
- `product(request)` 是类型化读/预览；写入走同一队列。`llm(request)` 与 `llmCredential` 仍是独立通道，凭据不进通用 job。
- `view(spaceId)` 只为监督已启动且通过就绪检查的实例签发引导路径。`entryOrigin` 是监督 origin；`origin` 是子 DSH origin，只做消息校验。实例身份为 `serviceEpoch + spaceId + generation`。
- 安装只接受目录 `catalogId` 和精确版本。不得让客户端传本地 file:/git/shell spec。读不到实际版本显示未知，不改用 `latest`。

公开命令没有 `controller.acquire`、`controller.release`、`recovery.resume`、`snapshot.restore`、`config.restore`。正常停服务使用 `service.shutdown` 预览。旧调用只在兼容拒绝边界返回 unsupported。

## 拓扑

独立 Supervisor 是唯一管理执行器：运行权、进程监督、任务执行、稳定 HTTP。桌面壳不创建第二套 ProfileRegistry / ProcessManager / RuntimeStore / CoordinatedUpgrade / DesktopLlmHost。管理页是 spaces-hub 的原生工作台；Host 只作受信任转接。工作空间独立 origin；view-bridge 不含管理能力。

入口在管理 profile 停机后若 Supervisor 仍在线，显示真实失败。Supervisor 不随管理 profile 停机。桌面退出销毁客户端，不停止服务。浏览器和桌面打开现存健康服务是附着，不是恢复；失联后不自动重启或重发管理请求。

客户端之间没有业务控制权交接。Home 锁由 Supervisor 持有。另一端只读查询。活着或身份不明的锁只诊断，不清锁、不接管。

## 任务状态

```text
queued → running → succeeded / failed / cancelled
```

进程中断后重开：读取原任务，展示中断失败或结果无法确认，保留最后阶段和证据。不重放，不对账修补。损坏或未知格式的任务文件保留原字节。

没有 `recovery-required`、恢复冻结或 `recovery.resume` 产品入口。

## 已选行为

- 保留已访问 iframe；停止或重启其目标才销毁。失败的新启动保留上一视图，并标明本次切换失败。
- `managed=false` 的外部实例只能查看。
- 删除工作空间先预览。`removeData` 默认 false；web 和 manager 受保护。
- 插件安装到空间 / 从空间移除需要时重启，不是热开关。
- UI 不提供修改管理环境的任意插件或主题。管理器自身包更新是用户主动的维护。
- 轮询不触发启动、停机或重放。
- 快照 API 只有创建、查看、删除。`--snapshot-worker` 服务正常快照与剩余安装 IO；运行时安装已抽出。没有恢复链。
- 通用 Node 模块在 `src/adapters/node`（从 `src/main` 迁出）。Electron 壳留在桌面进程。

构建清单覆盖 Supervisor、管理插件、view-bridge、llm-bridge、安装 worker。冷启动与 pack 使用同一组制品和 `--component-payload`。组件升级的一次性启动器交接是合同目标；实现与双端验收仍由 Supervisor/launcher 写者完成，本文不把它写成已通过。

## 模块边界（现行）

- Home 运行权：`src/adapters/node/home-controller.ts`。Supervisor 消费该锁，客户端不公开 acquire/release。
- 任务：`src/adapters/node/workbench-jobs.ts`。调用者必须已在 Supervisor 串行边界内。
- 维护端口：`src/adapters/node/workbench-maintenance-ports.ts`。维护层不另造 ProcessManager。停服务走 `service.shutdown`。
- 产品读/写：`src/adapters/node/workbench-products.ts` 与配方 `src/core/application/space-recipe.ts`。
- 桌面连接：只附着已有 Supervisor 或用户显式 start；`dispose` 不停止服务。

公共合同、依赖和最终构建整合仍由主 Agent 单写。

> 历史：早期合同曾把稳定入口写成恢复页，并把 `controller.acquire` / `controller.release` 写成双端交接。那些要求已由 2026-09-15 let it crash 与 2026-09-20 合同 v2 取代。当时实现痕迹见源码与 [workbench-jobs-worker.md](workbench-jobs-worker.md)，不要当成现行 API。
