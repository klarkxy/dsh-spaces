# B4 桌面服务连接器（DesktopServiceClient）

叶子范围只写了这三个文件：

- `src/adapters/desktop/service-client.ts`
- `tests/desktop-service-client.test.ts`
- `tasks/merge-b4-desktop-connector.md`

未改 Git、tsconfig、`src/adapters/desktop/index.ts`、helpers、Electron 主进程。未读真实 `~/.dsh`，未委派 Bridge，未跑全套测试或重装依赖。

现行故障政策仍是 [let it crash](../docs/let-it-crash.md)。协议合同：[merge-contract-v2.md](merge-contract-v2.md)。

## 结论

纯 Node 的 `DesktopServiceClient` 只连接**已经存在或由用户显式 start 拉起的唯一 Supervisor**。它不实例化 registry / processManager / runtimeStore / LLM，不写 Home 业务或锁，不发 `service.shutdown`，不中止后台 job。权威校验全部走现有 helpers；本叶没有第二套租约/endpoint/协议实现。

## 实际接线的 helpers

| 用途 | 实际导出 | 路径 |
|---|---|---|
| 附着已有服务 | `attachExistingSupervisor` | `packages/plugin/src/host/supervisor-attach.ts` |
| 用户显式冷启动 | `bootstrapSupervisor` | `packages/plugin/src/host/supervisor-bootstrap.ts` |
| Node-only API | `createWorkbenchHttpClient` | `packages/plugin/src/host/workbench-http.ts` |
| 一次性入口 | `mintSupervisorHandoff`（不是 `requestSupervisorHandoff`） | `packages/plugin/src/host/workbench-http.ts` |
| 入口 URL 再校验 | `parseLoopbackOrigin`、`parseSupervisorHandoffPath` | `packages/plugin/src/host/loopback.ts` |

`bootstrapSupervisor` 的默认 `spawn` 已经是 `execPath + argv 数组`、`shell: false`、`windowsHide: true`。本客户端不传 `spawn`，不复制启动器。

## 精确 API（给主 Agent shell brief）

```ts
new DesktopServiceClient({
  home: string,                 // 必填；隔离 Home，不是真实 ~/.dsh
  payloadRoot: string,          // 必填；受控 supervisor payload，不默认插件模块目录
  toolsRoot?: string,
  snapshotRoot?: string,
  allowRealHome?: boolean,      // 默认 false
  fetch?: WorkbenchHttpFetch,   // 测试/注入
  attach?: DesktopAttachFn,     // 默认 attachExistingSupervisor
  bootstrap?: DesktopBootstrapFn, // 默认 bootstrapSupervisor
  handoff?: DesktopHandoffFn,   // 默认 mintSupervisorHandoff
})

connect(): Promise<DesktopServicePublicState>
start({ nodeExe, cliBin }): Promise<DesktopServicePublicState>
getApi(): WorkbenchApi          // 仅 connected；createWorkbenchHttpClient 的原对象
entryUrl(): Promise<string>     // 仅主进程；一次性 http://127.0.0.1/bootstrap/<token>
publicState(): { status, reasons }
dispose(): void
```

`DesktopServicePublicState.status` 只有 `'idle' | 'connecting' | 'connected' | 'unavailable'`。JSON 只有这两个字段。

`getApi()` / `entryUrl()` 在未连接或已 dispose 时抛 `DesktopServiceClientError`。`connect` / `start` 的 helper 失败不抛，把客户端标 `unavailable` 并留下脱敏 `reasons`。

未导出到 `src/adapters/desktop/index.ts`。主进程请直接：

```ts
import { DesktopServiceClient } from "../adapters/desktop/service-client";
```

## 生命周期

1. **`connect()`** 只调用 `attach`。健康 `endpoint` → `connected`。`missing` → `unavailable`（文案与 bootstrap 的 “No running workbench was found…” 相同），**不** cold start。`blocked` / `stale` / 未知形态 → 原样拒绝，不 bootstrap。
2. **`start({ nodeExe, cliBin })`** 先 attach。已有健康服务则直接连接、不 spawn。`blocked`/`stale`/未知形态不调用 bootstrap（现有 `bootstrapSupervisor` 在 `allowColdStart: true` 时会对 **stale** 冷启动，所以本客户端必须在调用前拦住）。仅 `{ missing: true }` 才 bootstrap，且只一次：`argv: [nodeExe, cliBin]`，`execPath: nodeExe`，`payloadRoot` 用构造器受控值，`allowColdStart: true`。调用方必须传入已经验证过的 Node/CLI；本叶没有 installer。
3. 同实例并发 `start`/`connect` 共用一个 inflight Promise。后到的 `start` 可以把进行中的 connect **升级**为允许 bootstrap，但不会第二次 spawn。
4. **`dispose()`** 增加 generation、丢掉 endpoint/API 引用、状态回到 `idle`。不发停止服务/空间命令。晚到的 attach/bootstrap 成功不能重新标 `connected`。`entryUrl()` 在 `await handoff` 之后必须仍是同一 generation/endpoint；dispose 后的 handoff 成功只抛原有 `ENTRY_UNAVAILABLE`，不返回带 token 的 URL。dispose 后的实例不再复活。
5. 已 `connected` 时再 `connect`/`start` 是空操作，不 spawn、不重试。失败后用户再次 `connect`/`start` 是新的主动操作，不是自动恢复。

## Attach 判别（给协议 worker）

本客户端不解释、也不认证 `serviceEpoch` / `protocol` / `homeId`。判别只转发 helper 标签。当前测试只覆盖 **`blocked` / `stale` 原样拒绝**（含一条手工 `blocked` 文案夹具）；**真实 v2 endpoint helper 仍在后续迁移**，手工往 endpoint 上挂 extras 不是 v2 认证证明，接口也不为此改动。

| helper 结果 | connect | start |
|---|---|---|
| `{ endpoint }` | 连接 | 连接，不 spawn |
| `{ missing: true }` | 不启动 | 允许 bootstrap |
| `{ blocked: true, reasons }` | 原样拒绝 | 原样拒绝，不 bootstrap |
| `{ stale: true, reasons }` | 原样拒绝 | 原样拒绝，不 bootstrap |
| 其它形状（例如 identity unknown、无 missing） | 当 blocked | 当 blocked，不 bootstrap |

请把持锁、身份不明、死租约写成 **`blocked`（或 `stale`）+ reasons**，不要写成 `missing`。旧协议拒绝属于后续 v2 helper 的职责，本叶只保证收到 `blocked`/`stale` 时不 bootstrap。`missing` 只表示没有可附着的 endpoint。

## 入口 URL

`entryUrl()` 供桌面主进程加载 WebContentsView，**不要经 preload/IPC 回给 renderer**。流程：

1. 必须已 `connected`。调用时抓取 `generation` 与当时的 `endpoint`，且 `parseLoopbackOrigin(endpoint.origin)` 成功。
2. 调用 `mintSupervisorHandoff`（或注入的 `handoff`），使用抓取到的 endpoint。
3. `await` 之后若已 dispose、generation 变化、或 endpoint 不再是同一对象：抛原有 `The workbench entry is not available yet.`，**不返回 URL**。
4. 相对路径拼到该 origin；完整 URL 必须通过 `parseSupervisorHandoffPath(candidate, origin)`。
5. 只返回 `http://127.0.0.1…/bootstrap/<token>`。异 origin、非 `/bootstrap/`、query/hash/凭据一律拒绝。handoff 失败不把客户端从 `connected` 打成 `unavailable`（服务仍在，只是这次入口作废）；dispose 后的晚到成功同样不导航。

## 明确不做

- 不导入 Electron。
- 不自动故障重试、不 fallback、不清锁、不杀 Supervisor。
- 不安装 Node/pnpm/CLI。
- 不把 bearer、token、原始路径、payload 目录放进 `publicState()`。
- 不为测 `getApi()` 提供跳过 schema 的假客户端；`getApi()` 返回 `createWorkbenchHttpClient` 的结果。当前 state 夹具仍按现行 `workbenchStateSchema`（含 `recoveryRequired`）。协议 worker 把 schema 改成 v2 必填字段后，主 Agent 只需改该测试夹具，不必改连接器。

## 验证

```
npx tsx --test tests/desktop-service-client.test.ts
```

**17 pass / 0 fail**（2026-09-20，本工作树）。覆盖：健康 attach 不 spawn；无服务 connect 不 spawn；显式 start 一次且 argv/execPath/payloadRoot 受控；两个并发 start 一次 bootstrap；**helper `blocked`/`stale` 原样转发、不 bootstrap**（不是 v2 endpoint 认证）；身份不明不 bootstrap；attach/bootstrap 异常不 fallback；dispose 期间晚到 bootstrap 成功不重新激活、不发 shutdown；deferred `entryUrl` handoff 在 dispose 后 resolve 被拒绝且不返回 token URL、无 stop/shutdown；`publicState` JSON 无 bearer/token/原始 path；`entryUrl` 拒绝任意导航；`getApi` 走真实 HTTP 客户端。endpoint 上的手工 extras 只证明透传，不证明 v2。

未做：真实 DSH、模型、Electron 窗口、`npm run typecheck` 全量、装包。

## 主 Agent 接线时注意

1. **tsconfig.node.json 是 composite**，未 include `packages/plugin`。本叶默认导入 plugin host helpers，因此 `tsc -p tsconfig.node.json` 会报 TS6307。`tsconfig.spaces.json` 已同时包含 adapters 与 `packages/*/src`，本叶在该项目里没有新的类型错误。接线主进程前请任选：把 plugin host 纳入 node include、从 `src/adapters/node` 再导出 helpers、或在主进程装配时传入 `attach`/`bootstrap`/`handoff`。本叶按合同保留了真实 helper 默认值，不能改 tsconfig。
2. 当前 `typecheck:spaces` 另有一个既有错误：`src/adapters/node/workbench-products.ts:482`（其它叶子的 product 合同，与本连接器无关）。
3. 退出桌面 = `dispose()`，不等于停止服务。停止服务仍走工作台 `service.shutdown` 预览，不在本客户端。
4. 首次准备 Node/pnpm/CLI 仍在桌面壳；本客户端只接收已验证的 `nodeExe`/`cliBin`。
