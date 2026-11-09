# 主空间空间总控插件设计（space-control）

> 状态：2026-11-09 已按修订分期实现 P1–P7（原会话代理 P4/P5 已撤销，改为界面操控；space-control 实际以宿主插件子入口 `@dsh-spaces/plugin/space-control` 分发，不是 §3 写的独立包）。实现与验收记录见 [tasks/todo.md](../tasks/todo.md) 顶部条目；本文正文保留设计原稿，未逐节改写。故障政策以 [let it crash](let-it-crash.md) 为唯一权威；角色与通道基线见 [architecture.md](architecture.md)；主空间注册与 Creator 通道实现见 §依据。官方 API 以运行时 DSH 0.2.2-rc.1 版本锁定源码为准。

## 1. 目标与非目标

### 目标

让**身份确认的可信主空间**（官方 `web` / `desktop` profile）里的 Agent 能通过一组宿主工具，查看并操作同一 DSH Home 下由 Spaces 管理的普通空间。第一版能力覆盖四类：

| 能力域 | 内容 |
| --- | --- |
| 空间生命周期 | start / stop / restart / delete（含受影响预览与忙碌保护） |
| 子空间会话 | 列表、搜索、读取（分页有界）；创建与发送（每次审批） |
| 子空间插件与模型 | 读：插件组合、模型策略、模型目录；写：插件安装/移除/启停、运行时切换、模型策略切换 |
| 日志与诊断 | 子空间诊断与脱敏日志尾部，有界返回 |

### 非目标

- 不做新 UI。现有管理工作台（spaces-hub）和主空间侧栏就是面板；本设计只交付 Agent 工具。
- 不读、不写主空间自身 profile 的会话与凭据；不授予对 `web`/`desktop`/`spaces-hub` 的管理写。
- 不做跨机器、多租户、恶意插件沙箱；隔离目标仍是单机同 OS 用户信任域（architecture.md:9）。
- 不绕过 Home 单写者：所有变更仍过 Supervisor 的 job 串行 tail 与 epoch/revision CAS。
- 不实现蓝图工作流；蓝图当前封存（architecture.md:151）。

## 2. 角色与信任边界

```text
主空间 Agent
   │ 宿主工具（spaces_overview / spaces_inspect / spaces_plan / spaces_execute / ...）
   ▼
@dsh-spaces/plugin/space-control 子入口（主空间进程内，宿主插件包内模块）
   │ inject: spacesMainChannel（dsh-spaces 宿主插件提供的 Cordis Service）
   ▼
dsh-spaces 宿主插件（主空间进程内）
   │ POST /internal/control/v1/<op>  loopback 原生请求 + control scope bearer
   ▼
Supervisor（每 Home 一个，唯一管理写者）
   ├─ 复用管理面：state / detail / product(diagnostics,logs) / jobs / plans
   ├─ 新增控制面：controlPlan（带 activity 快照）→ job
   └─ 子空间数据面代理：以已认证浏览器会话客户端调用子进程 /api Remote
        ▲                                    ▲
        │ launch token → dsh-auth-* cookie   │ sessionController / pluginManager @Remote
   子空间 DSH 进程（spawned，owned，per-generation）
```

信任要点：

- control scope 与 Creator scope 同源：由同一份主身份注册签发，仅作 `Authorization: Bearer`，不进会话、日志、端点记录（main-space-creator.ts:6-8、creator.ts:212-220）。
- 通道要求原生请求：无 Origin / Cookie / sec-fetch-site，Host 精确匹配（creator.ts:688-699）——与 Creator 同一准入，天然排除浏览器。
- 普通空间 profile 永远不会被注册为控制主体：注册断言复用 `assertMainProfile`（creator.ts:400-414）。
- 子空间会话内容回入主空间上下文时一律按不可信数据处理（见 §6）。

## 3. 包与预装

**实现修订（2026-11-09，取代原“独立 bundle”方案）**：space-control 不再是独立 npm 包。原方案把 `@dsh-spaces/space-control` 作为 `file:lib/space-control` 嵌进宿主插件 dependencies，真实 tarball 安装时 pnpm 将该 file: 路径按**安装方 profile 根**解析而非 tarball 内部，整条安装失败（ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND）。改为宿主插件包内子入口：源码在 `packages/plugin/src/space-control/`，构建产物 `packages/plugin/lib/space-control.js`，经 package.json `exports["./space-control"]` 暴露为 `@dsh-spaces/plugin/space-control`（与 `dsh-spaces-main-images` 的 `@dsh-spaces/plugin/llm-images` 同一形态）。Cordis Loader 的 `name` 即 Node 模块 specifier，patch 行照常解析子路径（entry.ts/tree.ts 经 `import.meta.resolve` / 内部 loader）。

落地：

1. `packages/plugin/cordis.patch.yml` 行 `insert: { id: dsh-space-control, name: '@dsh-spaces/plugin/space-control' }`；id 不变，用户仍按行 id 单独禁用。
2. `packages/plugin/package.json` 不再有 `@dsh-spaces/space-control` 依赖；`packages/space-control` 目录撤销，根 `file:packages/space-control` 依赖一并移除。pack 预检硬性拒绝插件包内任何 `file:`/`link:`/`workspace:`/`portal:` 依赖与 `@dsh-spaces/*` 自依赖。
3. `packages/view-bridge` 与 `packages/llm-bridge` 的 patch **不加**此行；manager（spaces-hub）profile patch 与 Browser base 显式 `disabled: true` 该行（Browser 先例见 base-creation.ts:89）。本入口只服务于主空间。
4. `SupervisorToolchain.ensureBundledDependencies` 收敛回单一 `@klarkxy/dsh-dev-index`：space-control 随插件包本体走，开发 link 与 tarball 都不需要 profile 层补依赖。
5. `lib/space-control.js` 纳入同一不可变组件组 manager-plugin 的 payload 清单（component-payload.ts）。

## 4. 通道与认证

### 4.1 注册与 scope

Creator 通道每 service epoch 只允许一个注册（creator.ts:209-211）；space-control 不自行 issue。设计：

- `CreatorIssueResult` 语义扩展：issue 响应增 `capabilities: ['creator','control']`，并签第二份 scope；或签发单一 scope、服务端按 op 前缀区分。两种都是 wire 变更，取其一实现（待定项 D1）。推荐**单一注册 + 两个 scope**（`scopes.creator` / `scopes.control`）：能力边界显式，吊销粒度清楚，digest 存储不变。
- 宿主插件侧：现有 `MainSpaceCreatorService` 持有 endpoint、issue 与预览表；新增同构的 `MainSpaceControlService` 复用同一插件级身份监听（loopback `/identity` 回调）与 issue 结果中的 `scopes.control`。
- 宿主插件新提供 Cordis Service `spacesMainChannel`（`ctx.provide`，Service 模式参照 `SpaceMessages`：view-bridge/src/message-service.ts:4-17）。space-control 包 `inject: ["spacesMainChannel"]` 后调用其方法；scope 字符串不暴露给工具或模型，Service 只暴露操作级方法。

### 4.2 Supervisor 侧通道

新增前缀 `/internal/control/v1/`，与 Creator 完全同构的原生请求路由（建议从 `SupervisorCreator.handle` 抽出共享的 native-request 准入，避免两份校验漂移）。操作表：

| op | 鉴权 | 语义 |
| --- | --- | --- |
| `issue` / `unregister` | Host bearer | 与 Creator issue 同一注册记录；返回 `{ registrationId, scopes: { creator?, control }, serviceEpoch }` |
| `context` | control scope | epoch、revision、writable、maintenance、busy、各空间 activity 快照 |
| `read` | control scope | 只读投影：overview / space detail / diagnostics / logs tail / plugin 列表 / llm-policy / model 目录代理读 |
| `plan` | control scope | 冻结 control 计划：目标指纹 + activity 快照 + TTL + 一次性 |
| `execute` | control scope | 提交冻结计划为串行 job（requestId 幂等） |
| `session` | control scope | 子空间 sessionController 代理调用（list/search/events/create/prompt/cancel） |
| `job` | control scope | 读本注册提交的 control 作业 |

错误码沿用 `creator/*` 风格新增 `control/*` 封闭集合（invalid-input / not-found / conflict / unregistered / request-conflict / plan-expired / plan-consumed / read-only / unavailable / unsupported / busy / failed），透传规则与 `creatorError` 一致（creator.ts:104-123）。

### 4.3 子空间认证凭据（关键查证结论）

**Supervisor 可以从 Node 侧以已认证浏览器客户端身份调用子空间 `/api`。**

- 子进程 spawn 携带 `--no-open --host 127.0.0.1 --port`，stdout 宣告含 token 的 launch URL；`waitForDshEndpoint` 只截取 endpoint（process-manager.ts:440-465、dsh-endpoint.ts:6-39）。
- `dshSessionCookie(url, fetch, signal)` 已把 launch token 换成 `dsh-auth-*` 会话 cookie（dsh-endpoint.ts:42-56）；启动链路 `auth → api` 阶段即用该 cookie 调 `session.list`/`session/list` 探活（process-manager.ts:465-469、dsh-endpoint.ts:59-77）。
- launch URL 保存在 `instance.url`，经 `urlOf()` 提供但注释明确“main-process-only；不入 status IPC 与日志”（process-manager.ts:293-296）。`viewEntry` 已按次重新交换 cookie 再下发浏览器（workbench-supervisor.ts:695-738），证明**同一 launch token 可重复交换新 cookie**（启动时一次 + 每次视图入口一次）。
- 结论：无需凭据转发、无服务账号需求。新增 `ChildSessionClient`：按 (spaceId, generation, epoch) 取 `urlOf` 重换一个 control 专用 cookie，再以 `cookie` + `Origin: http://127.0.0.1:<port>` + `connection: close` 的 native fetch 调 `POST http://127.0.0.1:<port>/api/<method>`（transport 形态同 dshSessionList：`{type:'client-request', rpcId, method, payload:{args:...}}`；remote.mux 走法以 0.2.2-rc.1 源码核对为准）。cookie 只存在于 Supervisor 内存，绑定当前 (generation, epoch)，进程停即废；不落盘、不回应给主空间。
- 注意：会话读经由 `sessionController.events`（分页）；官方 `sessionQuery` 无 `@Remote`，不可依赖（见待决问题）。

## 5. 工具契约

工具注册参照 `installMainSpaceTools`（main-space-tools.ts:202-362）：space-control 在可信主空间条件下经 `ctx.inject(["spacesMainChannel","tools","sandboxPolicy","profileContext","agentPresets","approval"])` 注册；参数对象封闭（additionalProperties:false + `closedArgs`），输出 `output.render` 为 JSON 文本。`ToolSchema` 无 permission 字段；审批由工具 execute 内调 `approveEscalation`（`@deepseek-ai/dsh-sandbox`），approval.request 不带参数，**审批文案必须自带目标与操作细节**。

### 只读工具（无审批；读操作在主空间任意会话可用）

**spaces_overview** — 参数 `{}`。返回：serviceEpoch、revision、writable、maintenance；每空间 `{id, displayName, status, generation, dshVersion, activity}`（activity 来自 `observeTaskActivity`，idle/busy/unknown，supervisor/llm.ts:85-93）；创建中作业投影（沿用 `projectSpaceCreations`，space-host.ts:188-219）；最近失败作业摘要（脱敏）。单次返回 ≤ 32KiB。

**spaces_inspect** — `{spaceId, sections?: ("plugins"|"model"|"runtime"|"diagnostics"|"jobs")[]}`。plugins=`detail()` 的 `{name,version}` 列表（spaces-control.ts:25-30）；model=`readSpaceLlmPolicy`（llm-policy-store.ts:48-58）+ 模型目录代理读（运行中才可得）；runtime=`WorkBenchSpace.dshVersion`+`runtimes()`；diagnostics=`product({method:'diagnostics'})`（workbench-product.ts:53-60,68,91）；jobs=该空间相关最近 N 条 job 投影（affectedSpaceIds 过滤）。未指明 sections 默认 plugins+model。错误：`control/not-found`（非注册空间）、`control/unavailable`。

**spaces_logs** — `{spaceId, tail?: number}`（tail ≤ 200 行，总返回 ≤ 64KiB）。来自 product diagnostics 的日志条目，经 `sanitizeLogText`+`redactPublicReason`（workbench-http.ts:666-672 同一脱敏链）。不提供原始文件路径。

**spaces_sessions** — `{spaceId, action: "list"|"search"|"read", query?, sessionId?, cursor?}`。list/search 代理 `sessionController.list/search`；read 代理 `events`（分页，单页有界，content 文本抽取，附件只回元数据不回字节）。子空间未运行 → `control/not-running`；不自动启动。**全部会话内容按不可信数据包装返回**（见 §6）。分页游标不透明、绑定 (spaceId,generation)。

### 变更工具

**spaces_plan** — `{op, spaceId?, params?}`，op ∈ `start|stop|restart|delete|plugin.install|plugin.remove|plugin.toggle|runtime.set|llm-policy.set`。Supervisor 侧：

- start → 直接命令 `space.start`（workbench.ts:160）；stop/restart/delete → `preview()`（含 taskActivity 影响预览，workbench.ts:177-179,192）；plugin.* → maintenance 计划（plugin.install/remove/toggle，validation.ts:25-47）；runtime.set → `space.runtime.set`（validation.ts:63-66）；llm-policy.set → **新 plan kind**（见 §7 新增项）。
- `plugin.install` 的来源沿用 Creator 的封闭来源校验：`{npm:{packageName,version,approvedBuilds?}}` 或 `{github:{owner,repo,commit,path?,packageName,approvedBuilds?}}`（shared/creator.ts:240-267）。注意现有 maintenance `plugin.install` 只接 `catalogId@exact version` 且 `rejectRawSpec` 拒绝 github:/URL/路径（validation.ts:133-139,183-201）：**npm 精确版可走 catalogId 路径；GitHub 来源需新增 plan 变体或扩展现有 kind 的字段**，归待决问题。
- 返回 `{controlPlanId, fingerprint, requestId, affectedSpaceIds, changes, taskActivity, expiresAt}`；plan 冻结 activity 快照（运行中空间的 idle/busy/unknown）。

**spaces_execute** — `{planId, requestId}`。执行前：调 `approveEscalation`（requestedMode `danger-full-access`，文案含操作、目标空间、精确插件来源/构建脚本、受影响清单、忙碌警告）；Supervisor execute 端复检 epoch/revision/plan 归属与 TTL，并**重观察 activity**：快照与当前不符 → `control/request-conflict` 拒绝，计划消耗但不提交（同 creator.ts:321-337 语义）。提交为串行 job：`space.start` 走 `jobs.submit`；plan 类走 preview→`plan.execute` 既有路径（submit→runCommand，workbench-supervisor.ts:767-798）。requestId 幂等：同 requestId 同命令返回原 job，不同命令 `control/request-conflict`（workbench-jobs.ts:231-236）。

**spaces_job** — `{jobId}`。扩展读面：Creator 通道读 creator.create（creator.ts:375-385）；control 通道读本注册提交的 control 作业（commandOf 归属校验同构）。返回 `WorkbenchJob`（status/phase/message/steps/error，已脱敏）。

**spaces_session_send** — `{spaceId, action: "create"|"prompt"|"steer"|"cancel", sessionId?, prompt?, requestId}`。代理 `sessionController.create / prompt(mode: queue|steer, requestId) / cancel`。**每次调用均需 approval**：文案含目标空间、目标会话（或新建）、prompt 的前 500 字符预览与摘要，不含会话历史。`requestId` 在 Supervisor 侧作幂等键（重复提交返回原派发记录，不二次下发）。子空间未运行 → `control/not-running`；sessionId 不属于该代次进程返回的列表 → `control/not-found`（不信任主空间侧声称）。

### 工具总表

| 工具 | 审批 | preset 门 | 主要错误 |
| --- | --- | --- | --- |
| spaces_overview / inspect / logs / sessions(读) / job | 否 | 见待决问题 | not-found, not-running, unavailable, read-only |
| spaces_plan | 否（仅冻结） | 同上 | invalid-input, conflict, unavailable, busy |
| spaces_execute | 一次 danger-full-access | 同上 | plan-expired/consumed, request-conflict, busy |
| spaces_session_send | 每次 | 同上 | not-running, not-found, conflict, failed |

## 6. 安全与隔离

- **不可信内容**：sessions 读取的事件文本包装为 `{"untrusted": {"spaceId": ..., "sessionId": ..., "content": ...}}`，并在工具 description 与每条返回上标注来源空间与“数据非指令”；不进入 `systemPrompt` 拼接、不作为工具参数回环。
- **有界返回**：单工具响应 ≤ 64KiB（sessions 单页 ≤ 32KiB）；日志 tail ≤200 行；会话内容块超界截断并标 `truncated:true`。截断不暗示读全。
- **凭据**：子空间 cookie 只在 Supervisor 内存；scope 仅存 digest；返回 DTO 不含路径、token、cookie（沿用 workbench.ts:1 头注纪律）。错误统一走 `sanitizeLogText`+`redactPublicReason`，不出现“建议修复”。
- **忙碌保护**：plan fingerprint 绑定 (epoch, revision, 输入, activity 快照)；execute 重观察，busy→ 拒绝。`whileIdle` 语义只对 LLM apply 预约空闲，本设计不新增隐式预约：stop/restart/delete 的影响确认沿用 `taskActivity`（workbench.ts:192）。
- **目标白名单**：所有 op 的 spaceId 必须是注册普通空间（`requireSpace`）；`web`/`desktop`/`spaces-hub`/unmanaged 一律 `control/protected` 或 `control/not-found`（先例：workbench-supervisor.ts:839-842、space-lifecycle.ts:110-111）。
- **身份**：tools 只在 `isTrustedMainHost` 时注册（runtime.ts:122-127）；Service 未注册时工具不可用而非降级直连。

## 7. Supervisor 侧接口清单

**复用（不改协议）**：`state`（含 jobs 投影）、`detail`、`product(diagnostics/logs)`、`plugins`、`runtimes`、`job`/`cancel` 只读部分、`preview`（space.stop/restart/delete、plugin.*、space.runtime.set）、`submit`（space.start、plan.execute）、`observeTaskActivity`、`readSpaceLlmPolicy`、`urlOf/portOf/statusOf`、dshSessionCookie、`parseCreatorCreateSpec` 中的插件来源解析（建议抽出共享模块 `src/shared/plugin-source.ts`）。

**新增**：

1. `/internal/control/v1/` 路由 + `SupervisorControl` 类（issue 共享注册、scope 校验、op 分发、controlPlan 存取）——主体可复用 `SupervisorCreator` 的注册/计划骨架。
2. `ChildSessionClient`：launch-token→cookie 交换、`/api` Remote 代理（方法白名单：sessionController.list/search/events/state/create/prompt/cancel、pluginManager.listPlugins/listBundles/modelCatalog），输入输出 bounded、非 JSON/越权如实失败。
3. 新 plan kind `space.llm-policy.set`：`{spaceId, inheritMain: boolean}`。写 `hub/<id>/llm-policy.json` 走 `writeSpaceLlmPolicy` 原子写（llm-policy-store.ts:60-65）；语义：仅停止空间可写策略（运行中空间的 `DSH_SPACES_LLM_INHERIT_MAIN` 在 spawn env 时生效，tasks/todo.md:48）；计划含“需要停止/重启”的 changes 文案；执行在写锁内，先停（若计划含 restart）→ 原子写 → 可选重启；失败保留现场不回滚。是否并入 maintenance plans 或 Supervisor 本地 plans 视写权边界定。
4. `plugin.install` 的 GitHub 精确来源变体（若采纳）：installSpec 生成与读回校验复用 Creator 的 `installSpecFor`/`gitResolutionFor`（creator.ts:441-449,859-921）；allowBuilds 写 `pnpm-workspace.yaml` 复用 `writeBuildPolicy`（creator.ts:792-812）。
5. `spaces_context`/`spaces_job` 工具的读面扩展（context 增 `controlBusy`；job 识别 control 作业归属）。

## 8. 失败语义

- 不重试、不重连、不自动启动子空间、不续跑中断作业；issue 失败对当前 endpoint 终态（main-space-creator.ts:103-108 同构）；cookie 交换失败即 `control/unavailable`，不做第二次交换。
- 批量语义：A 成功、B 失败、C 未执行；`plugin.install` 多空间沿用 `runBatch`（plugin-batch.ts:41-54）。中断 job 保留 failed 与现场，读面如实展示。
- 计划语义：预览消耗后拒绝重复执行；提交失败记录 submissionFailed；requestId 重放只返回原 job。
- 会话发送：超时≠未送达（bus 同原则，view-bridge README:13）；工具如实返回 `control/failed` + 状态，不代为“确认成功”。
- 浏览器刷新/模型重述：刷新只重新读取同一 job；不产生第二个 execute。

## 9. 分期与验收

每期交付前必须跑：`npm run check:test-lists`、`npm run typecheck`、受影响组定向测试；提交前完整 `npm run check:all`（含 browser 需 Playwright Chromium；Windows rename 检查需仓库外可写临时目录，`--temp-root`，拒绝仓库内 temp）。禁止读写真实 `~/.dsh`；全部验收在 `.sandbox` Home。

| 期 | 范围 | 验收标准 |
| --- | --- | --- |
| P1 只读 | 包骨架 + spacesMainChannel + /internal/control/v1 的 issue/context/read/job + spaces_overview/inspect/logs/job | 隔离 Home：web profile 加载后四工具注册、hub/子空间无注册；read-only Supervisor 下只读可用、变更工具报 read-only；伪造 Origin/Cookie 的请求 403；scope 不出现在日志 |
| P2 生命周期 | controlPlan + spaces_plan/execute（start/stop/restart/delete） | 审批文案含目标/操作/忙碌；fingerprint 变更拒绝；requestId 幂等；中断留证不重放；stop 含 taskActivity 影响预览 |
| P3 插件与模型 | plugin.install/remove/toggle、runtime.set、llm-policy.set；model 读 | npm/GitHub 精确来源读回校验；protected 包拒绝；策略原子写、运行中语义如实；allowBuilds 白名单原样持久 |
| ~~P4 会话只读~~ | **2026-11-09 用户否决，已撤销**：不同组合的空间可能没有会话功能 | — |
| ~~P5 会话发送~~ | **已撤销**，由界面操控取代 | — |
| P4 界面操控 | 见 [space-control-ui-automation.md](space-control-ui-automation.md)：Supervisor 内 playwright-core（系统 Chrome/Edge，不下载浏览器）+ spaces_ui_open/snapshot/act/close | 已定：引擎 playwright-core；`spaces_ui_open` 审批一次，授权绑定 (spaceId, generation, 页面)，关闭/空间重启即失效，act 不逐次弹窗；截图经 attachments 返回图片；凭据不进模型上下文 |
| P5 安装扩展 | 见 [space-control-extensions.md](space-control-extensions.md)：停机 Supervisor 写 / 运行中子空间 pluginManager 写，二者互斥 | 并入 P3 的部分随 P3 验收 |
| P6 导入 / P7 插件条目启停 | 见 space-control-extensions.md | 插件顺序调整不做（官方无 reorder），只读展示顺序 |

> §4.3 子空间认证结论仍有效，改由界面操控（向自动化浏览器注入 cookie）使用；`spaces_sessions` / `spaces_session_send` 不再实现。

## 10. 待决问题

| # | 问题 | 证据/影响 |
| --- | --- | --- |
| D1 | **已定（2026-11-09）：双 scope** `scopes:{creator,control}`，同一注册记录签发；旧版 Supervisor 无 control 路由时如实报 `control/unsupported`，不降级 | creator.ts:157-221 |
| D2 | **已定：变更工具（plan/execute/session_send）与 Creator 一样要求 `cordis` preset**；只读工具在可信主空间任意会话可用。理由：danger-full-access 会话的审批策略为 never，审批不能单独兜底 | main-space-tools.ts:95-100 |
| D3 | `sessionController` 各 `@Remote` 在 0.2.2-rc.1 的确切方法名/参数形状（`prompt(mode queue|steer)`、events 分页协议、remote.mux 帧格式）须以版本锁定源码二次核对后再冻结 wire；`sessionQuery` 无 @Remote，read 只能走 events | 本仓库无引用；dsh-endpoint.ts:59-77 的 client-request 形态是现存先例 |
| D4 | **已定并实现（P3）**：不放宽 `rejectRawSpec`；新增 maintenance 计划 `plugin.install.spec`，npm 精确版与 GitHub 40 位 commit 共用 `src/shared/plugin-source.ts` 与 `products/plugin-exact-source.ts`（Creator 同源）。原问题：GitHub 来源扩展现有 maintenance kind 字段，还是新增 `plugin.install.spec`？现有 `rejectRawSpec` 明确拒绝 github:/URL（validation.ts:183-201），需新校验路径 + maintenance journal 投影 | creator.ts:441-449,859-921 |
| D5 | **已定并实现（P3）**：Supervisor 本地计划，只允许已停止或已崩溃的空间，plan 与 execute 两阶段都检查；不自动停止或启动空间，原子写入。原问题：Supervisor 本地 plan（如 space.delete）还是 maintenance plan？涉及停止空间 + 原子写 + 可选重启的组合语义 | space-lifecycle.ts:127-145、llm-policy-store.ts:60-65 |
| D6 | 会话事件分页游标与 generation/epoch 的绑定强度（严格绑定 vs 接受并标注代次） | space-runs.ts:19-45 |
| D7 | **已定：不合并**。`spacesMainChannel` 只承载 control；Creator 现有传输不动，两者只共享身份监听与 issue | main-space-creator.ts 与新增服务 |
| D8 | spaces_inspect 的 model 目录读取：经子空间 sessionController.modelCatalog（需运行中）还是仅 llm-policy + WorkbenchRuntime？未运行时如实返回“运行中可得” | — |

## 11. 依据

官方接口（父代理已由 cordis_inspect 与版本锁定源码核对，运行时 DSH 0.2.2-rc.1）：`ctx.tools.register` 与 ToolSchema 无 permission；审批 `approveEscalation` + `ctx.approval.request` 不带参数；子空间 `sessionController`（list/search/create/prompt/cancel/events/state/follow/modelCatalog/selectModel）与 `pluginManager`（listPlugins/listBundles/installBundle/setBundleEnabled/setPluginEnabled/removeBundle/updateBundle）为 `@Remote`，以该 profile 的已认证 Web 客户端身份调用；无跨 profile API、无服务账号、`sessionQuery` 无 @Remote。

仓库证据：

- 主身份判定：packages/plugin/src/host/runtime.ts:122-127、identity.ts:45-113。
- Creator 通道契约与校验：src/shared/creator.ts:11-40,146-165,240-357；Supervisor 侧：src/adapters/node/supervisor/creator.ts:144-221,298-385,660-775,792-812。
- 宿主侧注册/scope/工具：packages/plugin/src/host/main-space-creator.ts:97-241,288-404；main-space-tools.ts:155-189,202-362；main-space-guidance.ts:12-58；plugin.ts:56-83。
- 管理 API 单一事实源与 wire：src/shared/workbench.ts:156-314；dispatch：src/adapters/node/workbench-supervisor.ts:609-672,767-850；job 幂等/串行：src/adapters/node/maintenance/workbench-jobs.ts:125-276。
- plan/命令校验：src/shared/workbench.ts:177-188；src/adapters/node/maintenance/workbench-maintenance/validation.ts:11-84,133-201；插件批量：plugin-batch.ts:16-194。
- 子空间认证与 spawn：process-manager.ts:285-296,440-469；dsh-endpoint.ts:6-92；viewEntry 再交换：workbench-supervisor.ts:695-738。
- LLM 活动观察：src/shared/llm-activity.ts；src/adapters/node/supervisor/llm.ts:43-168；llm-policy：src/adapters/node/llm/llm-policy-store.ts:7-65。
- 组件预装：packages/plugin/cordis.patch.yml:5-29、package.json:117-119；view-bridge/cordis.patch.yml:10-17；toolchain.ts:34,231-334；base-creation.ts:89。
- 展示投影：src/shared/space-host.ts:39-51,135-185,188-233。
- 政策：docs/let-it-crash.md:9-33,76-88；docs/architecture.md:15-32,111-153。
