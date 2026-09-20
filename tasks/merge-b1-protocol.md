# B1 协议合同叶（共享合同批次）

日期：2026-09-20。本叶只落地共享合同、纯函数与产品 schema。Supervisor / Host / UI 由后续串行叶接入。主 Agent 继续编排。

## 本叶写入

| 路径 | 作用 |
|---|---|
| `src/shared/workbench.ts` | 协议 v2 状态、MutationContext、submit/preview context、product()、job.result.product、plan epoch+stateRevision、view/事件 serviceEpoch；去掉公开恢复与 acquire/release；`controller.shutdown` → `service.shutdown` |
| `src/shared/llm-api.ts` | `LlmSpaceObservation.serviceEpoch`（定义在此文件，不在 `core/ports/llm-runtime`） |
| `src/adapters/node/workbench-protocol.ts` | Node 纯函数：`WORKBENCH_PROTOCOL_VERSION=2`、Home digest、nonce→epoch、确定性 revision（保留 spaces 顺序）、context 解析与冲突。不放在 `src/shared`，避免 `node:crypto` 进入浏览器合同 |
| `src/shared/workbench-product-schemas.ts` | 全部 product request/command/outcome/result 的封闭 zod |
| `tests/workbench-protocol.test.ts` | 确定性 / 输入变化 / nonce 不泄漏 / 旧 epoch / 严格 schema |
| `tasks/merge-b1-protocol.md` | 本报告 |

未改：`src/shared/workbench-product.ts`（主 Agent 固定）、`src/shared/spaces-control.ts`（该文件没有 `recoveryRequired` 字段）。

## 导出接口

### `src/shared/workbench.ts`

- `WorkbenchProtocolVersion` / `WorkbenchAvailability` / 公开 `ControllerKind = 'web' \| 'desktop'`（Supervisor 内部 owner 仍是 `web`，不做 supervisor 重命名）
- `WorkbenchMutationContext = { serviceEpoch, expectedRevision }`
- `WorkbenchState`：`protocolVersion: 2`、`serviceEpoch`、`revision`、`availability`；去掉 `recoveryRequired`；`owner` 只读 `{ kind, since }`，不含 nonce
- `WorkbenchView` / `WorkbenchViewMessage`：`serviceEpoch`
- `WorkbenchJobResult.product?: WorkbenchProductOutcome`
- `WorkbenchCommand`：去掉 `controller.acquire` / `recovery.resume`，并入 `WorkbenchProductCommand`
- `WorkbenchPlanRequest`：去掉 `snapshot.restore` / `config.restore` / `controller.release` / `controller.shutdown`，新增 `service.shutdown`；`snapshot.create` / `snapshot.delete` 仍在
- `WorkbenchPlan`：`serviceEpoch`、`stateRevision`
- `WorkbenchApi.submit(command, requestId, context)`、`preview(request, context)`、`product(request)`

### `src/adapters/node/workbench-protocol.ts`

- `WORKBENCH_PROTOCOL_VERSION = 2`
- `digestHomeIdentity(canonicalHome)`：sha256，不回传路径
- `deriveServiceEpoch(ownerNonce)`：sha256 前缀派生，不回传 nonce
- `computeWorkbenchRevision({ spaces, settings })`：覆盖空间 metadata/generation/status、**输入 spaces 数组顺序**与 Home settings；对象字段顺序规范化所以同值拷贝/key 排列不变；`[A,B]` 与 `[B,A]` 必须不同；不接受 jobs/时间/log；无 `Math.random`、不调用 `state()`
- `parseMutationContext` → `workbench/invalid-input`
- `assertMutationContext` → 稳定 `workbench/conflict`（`WorkbenchProtocolConflictError`）

真正的队列比较仍留给后续 Supervisor 叶。

### `src/shared/workbench-product-schemas.ts`

- `workbenchProductRequestSchema` / `Command` / `Outcome` / `Result` 及 `parse*` 函数
- `workbenchMutationContextSchema`
- `.strict()` 封闭 union；未知 key 拒绝；无 `z.any()` / passthrough / 无界 `record`
- 本地路径、URL userinfo、`latest`/`next`、非精确版本、归档超过 `MAX_WORKBENCH_SHARE_BASE64`（8MiB）拒绝

## 验证

```text
npx tsx --test tests/workbench-protocol.test.ts
11 pass / 0 fail
```

覆盖：版本常量、Home digest 不泄漏路径、epoch 不泄漏 nonce、同序拷贝/对象 key 排列 revision 不变、`[A,B]→[B,A]` 与 generation/settings 变化会变、多余 jobs/log 字段不影响 revision、旧 epoch/过期 revision 冲突码、缺 context、产品未知 key、路径 spec、URL 凭据、`latest` 版本、超大归档、result 必须带 observation。

本叶文件在 `tsconfig.node.json` 中无自身错误。全仓 typecheck 未作为通过条件；调用方未迁移，预期暂态失败。

已记录的 node 调用方缺口文件（未修）：

- `src/adapters/node/workbench-supervisor.ts`、`workbench-jobs.ts`、`workbench-maintenance.ts`
- `packages/plugin/src/host/runtime.ts`、`workbench-http.ts`、`workbench-manager.ts`
- `src/core/application/global-llm-host.ts`
- `src/main/desktop-llm.ts`（observation 缺 `serviceEpoch`）
- `src/main/index.ts` 另有既有 ViewManager 报错，不全是本叶合同变更

web/UI 缺口（未修）：`packages/plugin/src/workbench/store.ts`、`components.tsx`、`view-session.ts`、`llm/space-binding.tsx`。

## 明确未完成（主 Agent 继续）

- Supervisor submit/preview 尚未接 context、epoch、revision、endpoint v2、serial CAS
- Host schema / Remote / HTTP client 仍是旧签名
- UI store/view-bridge 仍用旧 state 与 acquire
- JobStore 尚未复用 product schema；maintenance 失败链未改
- `src/shared/spaces-control.ts` **没有** `recoveryRequired`。现有 `SpacesMode` 含 `"recovery-only"`（能力枚举，不是 WorkbenchState 字段）。请主 Agent 决定是否改名或保留
- `LlmSpaceObservation` 已在 `src/shared/llm-api.ts` 增加 `serviceEpoch`。`src/core/ports/llm-runtime.ts` 的 `LlmInstanceRecord` 是交叉类型，不在本叶 write_paths；构造点会暂态缺字段

## 跨合同点

- 公开 `owner.kind` 保持 `web | desktop`。Supervisor 内部仍是 `web` owner，不做 supervisor 重命名
- `WorkbenchPlan.scope` 仍含 `'controller'`，供 `service.shutdown` 使用，不是 acquire/release
- product 业务与桌面壳不在本叶
