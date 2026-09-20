# B1 endpoint v2 权威校验

只改了这些路径（本轮 epoch/homeId 对齐只动 endpoint helper、测试和本报告）：

- `packages/plugin/src/host/supervisor-endpoint.ts`
- `packages/plugin/src/host/supervisor-attach.ts`
- `packages/plugin/src/host/supervisor-bootstrap.ts`
- `packages/plugin/src/host/workbench-schemas.ts`
- `tests/workbench-endpoint-v2.test.ts`
- `tasks/merge-b1-endpoint-v2.md`

未改 service-client、共享 DTO、Git。未读真实 `~/.dsh`。未跑全仓 typecheck。

## 导出

`SupervisorEndpoint` 为 `{ origin, bearer, protocolVersion: 2, homeId, serviceEpoch }`。磁盘 `endpoint.json` 写 `version: 2` + 上述字段；`writeEndpointFile` 原子写并回读校验受控 `endpoint.json`。

`readEndpointFile` 返回 `{ missing }` / `{ invalid, reasons }` / `{ endpoint }`。旧版、未知协议、损坏 JSON 都是 `invalid`，**保留原字节**。

身份与 epoch **只复用** `src/adapters/node/workbench-protocol.ts`：

- `homeId` = `digestHomeIdentity(canonicalHome(home))`（公开 wrapper `endpointHomeId`）
- `serviceEpoch` = `deriveServiceEpoch(owner.nonce)`（前缀 `dsh-spaces-epoch-v1:`；公开 wrapper `endpointServiceEpoch`）

nonce 不入库、不进 reasons。不得再对 raw nonce 做无前缀 sha256。

`attachExistingSupervisor`：无法识别的 endpoint 或任何 held lease → `blocked`；仅 **文件缺失且 inspect.held === false** → `missing`。stale / dead / foreign / unbound origin / incomplete / path alias / 错 Home / 错 epoch 都不 cold start。ping 前/后重验 lease。`bootstrapSupervisor` 在 `stale` 上直接失败，不再 spawn。

`workbench-schemas.ts`：`WorkbenchState` 严格对齐 v2 DTO（去掉 `recoveryRequired`）；命令去掉 takeover/restore；plan 增加 `serviceEpoch`/`stateRevision` 与 `service.shutdown`；view/job.product 走共享 schema。公开重导出 `mutationContextSchema` 以及 `workbenchProduct*`。

## 测试

```
npx tsx --test tests/workbench-endpoint-v2.test.ts
```

**12 pass / 0 fail。** 成功夹具用协议 `deriveServiceEpoch(owner.nonce)` 与 `digestHomeIdentity(canonicalHome(home))` 构造，并断言 wrapper 与协议函数结果相同。真实 `HomeController.acquire("web")`，不 reclaim。
