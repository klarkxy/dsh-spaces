# Supervisor 注册、图像与 DeepSeek 集成验证

> 历史导航：本文件是 2026-10-21 的历史集成验证记录，只证明当时范围。现行架构见 [architecture.md](../../docs/architecture.md)；故障政策见 [let it crash](../let-it-crash.md)。文中与现行架构冲突的桌面壳、应用内升级、恢复、交接或旧 LLM 方案内容，仅作历史参考，不是当前合同或验收门槛。

日期：2026-10-21。按用户授权继续实际集成；官方 SDK 不改，失败证据保留，不提交、推送或发布。

当前集成案例 **31 项通过**；正式源码已增加 Supervisor 注册/委派入口及子进程 IPC 通道。Astra 三轮复核指出取消缺口和异步终结竞争，均已修复并在新 Home 复验；最终独立复核 **READY，仅限本轮有界集成**。完整仓库检查已完成，存在下述真实失败，不宣称整体验收 READY。

## 1. 实现位置

- `src/adapters/node/llm-delegation/supervisor.ts`：挂在原 Supervisor HTTP listener 的私有入口，注册、Home/实例授权、prepare/stream/cancel、图像回读能力。
- `src/adapters/node/workbench-supervisor.ts`、`workbench-http.ts`：原 HomeController 所有权、原进程管理器和 HTTP 分发的实际挂接，停止/退出先撤销实例能力。
- `src/shared/llm-delegation.ts`：内部协议名称和 bootstrap 类型。
- `packages/llm-bridge/src/delegation-channel.ts`：一次性 IPC 握手、会话授权和图像读取响应；断开即失败，不重连。
- `tests/llm-delegation.test.ts` 与 fixture：正式回归测试，已列入 `test:llm` 和 `test:llm:integration`。

默认没有已注册主服务，不自动选择在线实例、转发配置或暴露凭据。实际主模型服务与完整子空间 LLM facade 在本轮隔离验证入口中装配；尚未接入正式产品 UI 或给现有用户空间启用继承。

## 2. 可信注册与图像调用链

主服务注册复用现有 Supervisor 私有 host bearer。入口拒绝 cookie、Origin、浏览器 fetch-site 和重复认证头，校验 Home、真实 profile/manifest 路径，拒绝管理器与 Supervisor 自己启动的子进程充当主宿主。注册时向明确的 loopback 主服务发送 nonce，主服务用实际官方 `profileContext` 回答 Home/profile；同一时刻只允许一个明确注册，不自动替换。

子进程令牌经 **Supervisor 实际持有的 IPC descriptor** 签发；来源不是请求 DTO。每项绑定空间、generation、随机 instanceId、当前 serviceEpoch 和真实 ChildProcess。HTTP 请求再次检查磁盘上的 HomeController 所有者及当前运行记录，会话 ID 也必须先由同一 IPC 实例授权。prepare 句柄只对该来源、会话和主注册有效。停止与退出撤销旧实例；明确正常重开签发新令牌和代次。

每个图像 stream 另签发只给主服务的临时回读 capability。主服务不能拿子空间 bearer 冒充另一来源；回读通过 Supervisor 路由到原 ChildProcess。子空间在类型仍存在时核对会话图像授权、规范化引用元数据与真实路径，再调用官方 `LocalAttachmentStore.readImageRequest(ref, target)`。图像返回后再次核对请求仍有效；流结束或取消即撤销回读能力。没有读取失败后改用主空间 store 的路径。

准备请求在任何主服务 await 前登记并占用来源配额，以独立 requestId 关联一次性取消。客户端断开、来源退休、主注册撤销和 Supervisor 关闭都会立即撤销本地权力，并向原主服务发送一次 cancel；尚未拿到远端 lease 也能按 requestId 取消。明确 stop/unregister 等操作等待取消确认，确认失败记录 `LLM_CANCEL_UNCONFIRMED` 并阻止后续委派，不重发取消或模型请求。图像超时向原子进程发送匹配 requestId 的 image-cancel，晚回结果不再发布。这是当前调用的资源释放，不是任务恢复或重放。

主服务用静态命名 attachments/fs 作用域将这项公开服务接给**原始官方 pi-ai 与 DeepSeek API-key 插件条目**；没有构造替代 SDK adapter、复制私有 profiles、修改 SDK 或运行中 monkeypatch。主空间普通本地图像请求仍明确使用自己的 store。

## 3. 当前完整案例

目录：`.sandbox/construction-20261021/p0-supervisor-images-deepseek-1/run-2026-10-21T13-26-02-756Z/`。

资源：`H:/Code/dsh-spaces-checktmp/supervisor-images-1792589162812`。Supervisor PID 66152；主宿主为真实官方 rc.2 CLI、`proof-main-host` profile、PID 8500。Supervisor 启动管理器就绪夹具 PID 68964，真实子 SDK 消费者 A/B 为 PID 17240/42592；A 正常停止并明确重开后为 PID 18472，generation 1→3。全部自有进程最终退出。

主要文件：`RESULT.json`、`AUDIT.json`、`pi-image-events.json`、`deepseek-image-events.json`、`deepseek-resume.json`、`deepseek-500-durable.json`、`image-timeout-evidence.json`、`SUPERVISOR-CHILD-LOGS.json`。每次运行保存全部夹具和实际产品源码副本；10 个受用官方 SDK 模块入口前后摘要一致。

| 验证项 | 实际证据 |
|---|---|
| 正式 Supervisor | 原 `createWorkbenchSupervisor`、真实磁盘 HomeController lease 和 endpoint；原 `attachExistingSupervisor` 完成私有 state ping 与 owner 前后核验。不是另一套身份 Map 代替 Supervisor。 |
| 主注册授权 | 错误 bearer、cookie/Origin、外部 Home 拒绝；只有原 host bearer 可以注册；子空间 token 不能注册主服务；重复注册拒绝。官方主 profile 的 Home/profile 与 nonce 匹配。 |
| 实例与会话 | A/B 独立 token/instance；跨会话、伪造 source 字段和混用 instance 拒绝。来源身份由 Supervisor 绑定，主服务没有采用 body 自称来源。 |
| pi-ai 图像 | A/B 相同原图得到相同内容 ID、不同真实工具路径，并发均经官方 pi-ai。请求级真实变体为 64×64，供应商字节摘要一致，路径各自属于原来源。 |
| 真正图像工具 | 供应商从 SDK 图像 handle 中提取真实只读路径，返回 `read_image`。实际官方 Agent、工具权限瀑布、`dsh-tool-fs` 和 `LocalFileSystem.readBytes` 执行；随后图像结果进入下一模型请求。 |
| DeepSeek 图像 | 原 `dsh-llm-deepseek-api-key` 注册 `deepseek-official`，原 `dsh-llm-deepseek` 经 Messages 和 Files API。红/蓝两张图保持不同摘要，成功上传两项；模型请求使用 file 引用，没有在该成功案例退到 inline。 |
| 请求级读取与授权 | 精确 target 传到原 store，返回的 variantId、尺寸与摘要进入跨进程审计。跨来源 `read_image` 在 FS 读取前拒绝。绕过子 facade 提交未授权图像仍由原来源 RPC 拒绝，供应商零新增、主 store 读取零新增。 |
| 原生 replay | DeepSeek adapter 自己产生 `deepseek-messages` envelope 与 reasoning signature，真实 Agent 保存；工具往返、第二用户轮、官方 JSONL 落盘后均保留。异源历史在原 SDK 中去掉原生签名。 |
| 正常停止重开 | 旧 bearer 和准备句柄失效；新进程通过原 Supervisor 正常启动，重读策略与附件授权，官方 `agents.resume` 保留旧事件完整前缀，仅新增 `session/end-seed`。新用户输入前没有供应商调用；随后携原图和完整签名历史调用。 |
| 取消 | DeepSeek 图像流读到 reasoning delta 后取消。锁定本次供应商索引，恰好新增一次请求，响应关闭且未正常完成；该 lease 已不可取消或再次派发，没有重放。 |
| 准备中的取消 | 实际主服务 audit 记录 requestId/state/cancelCount：客户端断开、子空间 stop、主注册 unregister 均让正在准备的请求取消，cancelCount 恰为 1，没有供应商请求或晚发布；stop 同时释放一个已准备但未派发的句柄。单独显式 cancel 也在响应前获得主服务确认。 |
| 异步终结屏障 | 主服务故意延迟两项取消确认：一项此前因客户端断开已从活动 lease 移除，一项由注销触发。此时注销尚未响应、新注册返回 MAIN_DRAINING；放行本次确认后注销才成功，两项 cancelAcknowledged 均为 1。正式回归另覆盖来源已 disconnect 后 retire 等待、过期清理 await 后不对已退休来源新发 prepare、已失败取消不被后续 close 的空集合抹掉。 |
| 图像超时 | 保持来源非空 target 读取，5 秒超时后实际 IPC 出现匹配的 image-cancel，来源活动读取数归零、abort 计数为 1；本次官方 Agent 错误落盘，供应商零新增。此证明协作 reader 的取消，不宣称 Sharp 同步原生代码可被中断。 |
| 供应商错误 | 新增 DeepSeek 500 turn 2 为 SERVER/HTTP 500 错误，供应商请求差值为 1；从官方 persistence 重新读取的本次错误后缀逐字段相等。 |
| 撤销与隔离 | 注销主注册后无法 prepare，子空间 bearer 不能使用主服务图像回读能力。受检 Home 的 `profiles/web`、根 `sessions`、根 `storages` 不存在，审计不含各项 bearer。 |

## 4. 原始失败

所有失败结果、源码快照与资源根保持不变；修正后在新的 Home 验证，没有清理失败证据或重启原现场。

- `12-42-11-883Z`：Windows 测试启动器 `--import` 误传绝对文件路径，Node 拒绝 `h:` URL；改为 file URL。
- `12-42-38-585Z`：管理器就绪夹具 cookie 名不符合实际私有握手，Supervisor 未进入可写状态；修正为原 `expectedAuthCookieName`，不弱化产品就绪判据。
- `12-43-25-552Z`：新注册入口误用只列已注册 Spaces 的 profile 清单，拒绝普通主 profile。产品检查改为 Home 内实际 profile/manifest 的常规文件与无 symlink/junction 校验，保留管理器/子进程拒绝。
- `12-44-24-222Z`：19 项之后，异源签名对照将缺失字段统计为 `[null]` 而误判。保存的真实 Messages 请求确实没有 signature；改为仅统计实际字符串，不改 SDK 的来源过滤。
- `12-46-46-345Z`：23 项通过；之后补充本轮正式链路的图像取消与回读能力负例，形成当前 25 项案例。
- `12-50-55-115Z`：25 项通过，保留原始结果。Astra 随后指出准备中未受控、远端准备句柄未取消、图像超时未通知来源三项真实缺口；不能用这些正向案例宣称资源生命周期已完备。修复后新增 5 项有界断言，在 `13-11-54-646Z` 新 Home 获得当前 30 项结果，没有改写旧结果。
- `13-16-28-962Z`：补强精确 SERVER/500/turn 2 和图像超时持久化，30 项通过；Astra 第二轮继续 REVISE：已经脱离活动表的清理未被终结操作等待、过期清理等待后来源可能失效、失败清理被空集合掩盖。增加独立按空间清理索引、注销屏障与重新准入检查、持久失败状态，以及三项正式回归。`13-20-03-120Z` 31 项通过；随后补充 IPC 已断开时不再发送图像取消，形成当前冻结源码和 `13-21-20-326Z` 最终 31 项结果。
- Astra 第三轮指出相邻窗口：等待旧 lease 取消时客户端已经断开，新请求尚未安装 close listener。现于等待结束后、新 lease 占位之前检查 `res.destroyed`；新增延迟门负例等待真实响应 close 和 handler 结束，确认上游 prepare 不增加。最终源码以 `13-26-02-756Z` 的 31 项结果和快照为准，先前目录继续保留。

## 5. 验证范围与剩余边界

- 使用原 Supervisor 产品代码和所有权/认证/生命周期；进程启动仍经其 `processRuntime.spawn` 验证入口替换为隔离子 SDK 消费者，管理器是就绪夹具，profile 安装/patch 的部分端口为 fixture。没有运行正式管理器 UI，也没有证明正式插件包在 Desktop/Web 完整激活。
- 主服务运行在真实官方 CLI 和其 profile 之中；其注册与图像服务入口属于本轮 fixture 插件。它证明现有公开 SDK 可承载这条链路，不代表完整主服务和 facade 已交付到产品 UI。当前普通用户空间没有被自动改写。
- 本地供应商只实现合成 Messages/Files 协议，不使用实际 DeepSeek/Anthropic 账户，不访问用户凭据。签名是测试字符串；不宣称外部供应商兼容性、密码学签名有效性或实际模型视觉效果。
- DeepSeek 本轮只强制了 Messages 500 和流取消；Files 正常上传成功。官方 SDK 内部存在 Files 失败转 inline、无效 file 引用重解析和 quota cleanup 等分支，本轮没有强制这些失败，也没有宣称已关闭这些 SDK 内部行为。严格失败政策的这部分仍须在插件公开边界另行证明，不能据本轮冻结生产契约。
- 名称仅作显示信息；图像授权校验内容 ID/媒体类型/尺寸/字节事实，允许同一规范化图像在官方工具结果中产生不同 name。该放宽不改变真实来源或文件路径授权。
- 配额、超时和流控只按当前实现与具名负例验证；所有竞争、内存压力、TOCTOU、TTL 清理及长期运行未穷尽。完整发现/UI controls、标题、完整压缩和普通创建路径仍待。
- S1 全量通过、正式包及 Desktop 四项门槛保持；不因新增链路结果将 P0/P1 标记完成。

## 6. 完整检查与独立复核

完整检查目录为原型根下 `checks-1/`，使用既有授权的仓库外临时根及已安装 rc.2 SDK，15 项已执行，整体为 failed，未宣称全绿。结果如下：

| 检查 | 本轮结果 |
|---|---|
| 测试清单、typecheck、typecheck:spaces、typecheck:tests、build | 全部 exit 0 |
| `test` / `test:spaces` | 268 通过；148 通过、1 条件跳过 |
| `test:llm` | 101 通过，含新增真实 IPC 注册/能力撤销回归；该新增回归单独执行也通过 |
| `test:blueprints` / `test:browser` | 94＋239 通过、4 条件跳过；13 通过 |
| `test:dashboard` / `test:workbench:browser` | 52＋152 通过、1 条件跳过；12 通过 |
| `test:workbench` | 545 通过、8 失败、2 条件跳过；7 个来自原生 esbuild 写外部 worker 的 `Access is denied`，1 个为既有 payload/attach 测试 3 秒握手超时 |
| `test:workbench:recovery` | 26 通过、5 失败；原生 worker 输出 `Access is denied` |
| `check:plugin-package` | exit 1；原生 esbuild 临时 validator 输出 `Access is denied` |

握手超时另用一个新外部临时目录单独诊断一次：`attach-diagnostic.log` 1 通过（测试本体约 690ms），没有修改超时、SDK、ACL 或产品判据。单独未复现不能抹掉原全组失败，也不足以确定其根因。原生输出错误已有先前 S1 同类证据；本轮仍如实失败，不无限重跑。

取消修复后，三组类型检查和 build 再次 exit 0；最后一次断开检查修正后，`typecheck:spaces`、`typecheck:tests` 与 build 再次通过，定向正式测试 **6/6**（含父测试），`test:llm` **106/106**，日志 `llm-client-close-final.log`。Supervisor、HTTP、endpoint、正常重开定向回归 **97/97**，日志 `supervisor-final.log`；测试清单再次通过。`SOURCE-AUDIT-client-close-final.json` 绑定当前五项产品源码与运行快照一致，814 个不属本轮的 S0 产品文件无变化，HEAD 保持 `26aab5d`。

Astra 前三轮为 **REVISE**，上述各项均作为本阶段生命周期缺陷修复。最终指定 Astra 只读独立复核为 **READY，仅限本轮正式 Supervisor／图像／DeepSeek 有界集成阶段**，未发现新的具体阻断；保存回复见原型根 `ASTRA-FINAL-REVIEW.md`。复核检查最终源码、运行快照、延迟门断言和原始结果，未自行运行测试或修改源码。正式包/UI、完整 P0/P1、Files 失败政策与全量检查三组失败保持原边界，不由本结论放行。
