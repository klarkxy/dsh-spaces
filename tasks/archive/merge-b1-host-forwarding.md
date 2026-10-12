# B1 Host 转发 + 轻量 view-bridge

本叶不改 endpoint/schema/bootstrap、UI `packages/plugin/src/workbench`、Node Supervisor/jobs/LLM/maintenance。

## 转发

`createWorkbenchHttpClient`：

- `submit(command, requestId, context)` → `{ command, requestId, context }`，`context` 经 `mutationContextSchema`
- `preview(request, context)` → `{ request, context }`
- `product(request)` 只读，shared product request/result schema
- 缺 context / 旧 recovery 与 takeover 命令：`workbench/invalid-input`，不补 observation、不 fallback
- bearer 只留在 Node HTTP；llm/llmCredential 仍是独立通道

体积：

- 普通方法：`WORKBENCH_HTTP_BODY_LIMIT` = `MAX_SPACE_ICON_FILE_BYTES`（2MiB），按 **UTF-8 字节**，有界 `getReader`，超限 cancel
- `product` `share.previewImport` **请求** 与 `share.export` **响应**：`WORKBENCH_PRODUCT_SHARE_BODY_LIMIT` = `MAX_WORKBENCH_SHARE_BASE64` + 64KiB
- 大 archive 只在该次请求内存里，不进日志/job

**主 Agent 对齐 Node HTTP `bodyLimit`：** 至少 `WORKBENCH_PRODUCT_SHARE_BODY_LIMIT`（`packages/plugin/src/host/workbench-http.ts`）。普通路由可继续 2MiB。`expectedAuthCookieName` 若 Supervisor 从 workbench-http 再导出，本叶未发明该符号。

`WorkbenchManagerHost` / `typert.host` / `typert.remote-client` / `createWorkbenchRemote` 同步第三/第二 context 与 `product`。manager-only `guard` 未改。

Host runtime：`waitForManager` 看 `state.availability !== "unavailable"`；`managerApi` 失联只 attach，**不**因轮询/重连 cold start。initialize/guide 仍不调用旧接管。

## view-bridge

与 Supervisor `VIEW_ENV.epoch` **同一名字**：`DSH_SPACES_VIEW_SERVICE_EPOCH`。handshake/postMessage/ping 带 64hex `serviceEpoch` + 原 spaceId/generation/channel/source。缺 epoch 或旧 epoch 视为无效。bridge 仍无管理 API、无 secret。

## 测试

```
npx tsx --test tests/workbench-plugin.test.ts tests/workbench-forwarding-v2.test.ts
```

**28 pass / 0 fail。** plugin 夹具改为真实 `HomeController.acquire("web")` + `deriveServiceEpoch`/`digestHomeIdentity` 写 v2 endpoint + v2 state。forwarding 用 fake fetch/remote 断言 body。手工 endpoint extras 不当成身份认证。

## 暂态缺口（不抢修）

- `workbenchHostHintSchema` / guide DTO 仍要 `recoveryRequired`；shared `ControllerKind` 为 `web|desktop`，Host state schema 为 `supervisor|desktop`
- UI store / Node Supervisor HTTP bodyLimit / jobs 执行器尚未接本叶转发
- `packages/plugin/src/workbench` 与 Node 装配的 type 错由对应 worker 处理
