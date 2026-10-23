# 正式插件主服务与子空间 facade：Agent / UI 集成验证

日期：2026-10-21。用户授权本阶段接入正式插件、模型发现、默认值与 controls，并验证普通创建后的真实 Agent / UI；不修改官方 SDK，不提交或推送。本报告仅针对本阶段，不关闭 S1、完整 P0、契约冻结或完整 P1 / Desktop 产品验收。

## 实现范围

- 主插件通过现有 WorkbenchHostRuntime 的 Supervisor 附着事件注册 MainLlmService，使用原官方 `llm`、`agentDefaultModel` 和公开 prepare/stream；私有监听地址与认证信息不进入子空间配置。注册失败释放监听资源，同一实例不重新注册或自动重连。
- 子空间 bundle 禁用原 `llm` 条目，插入插件子类 facade，保留原本地 adapter。普通 `space.create` 新空间默认持久化 schemaVersion 2 / inheritMain；明确选共享或本地仍支持，旧 v1 / 无策略不自动迁移。蓝图与模板内部创建的旧默认语义保留。
- 模型目录提供“跟随主空间默认”和带 `spaces-main:` 命名空间的明确模型；本地同名路由独立。主空间目录刷新使用官方已有 `llm/adapters-updated` 通知。采用官方 `agent/request` 已装配 proposal，保留 selection 快照与 middleware controls，再在冻结前物化主默认；主 reasoning 来源写入 request/header。UI Default 清除显式值，下一轮读取实时默认。
- 单次 prepared lease 绑定来源会话与目标；委派重试策略为零。来源文件在子空间类型信息仍在时校验授权、路径和内容摘要后投影。图像留在各自来源 store，主空间原 adapter 的静态公开服务组合通过请求级回读取得图像；没有运行中切换全局 store。
- 子空间持久化的 replay 带插件目标封装；主空间还原原始官方 replay 后，仍交由真实 adapter 进行来源过滤。原始异源或同名本地 replay 不提升为主空间 replay。请求头使用 facade 的可见路由，原始 provider/model 保存在封装中；不把虚拟路由伪装成原生来源。

## 验证装配与证据边界

证据根：`.sandbox/construction-20261021/plugin-main-facade-1/`。本轮基线 `BASELINE.json` 固定 829 个文件及既有删除状态，HEAD 为 `26aab5dc095bd97f132f5748aa727b800bb42916`。此前阶段的 817 / 814 文件摘要不替代本轮基线。

`run.mjs` 用真实 `createWorkbenchSupervisor`、官方 CLI manager/main/child 与正式插件构建；不传 processRuntime/runCli/dumpConfig/patchWriter 替代实现。主宿主为独立 proof-main Web profile 的仓库根链接，manager 与子空间从本轮 tar 安装，运行后比对安装产物摘要。浏览器执行正常新建、进入、模型选择、推理等级、消息与附件流程；控制观察器只使用公开 configEditor/default/session 接口。

供应商为本地受控 Anthropic / DeepSeek Messages / Files 服务；密钥为本次随机值，仅注入主进程。真实官方 Agent、工具、权限、JSONL zstd 会话和 SDK adapter 参与调用，但这不等于真实供应商账号可用性、计费认证或安装版 Desktop 已验收。子空间模型对话产生的原始合成 wire 留在本地，不在报告复制系统上下文。

最终运行：`run-2026-10-21T15-32-02-483Z/RESULT.json`，14 项具名断言全部通过：真实 Supervisor/manager、正式主插件、普通创建主继承策略、真实 Agent 主模型调用、同一 Agent 跟随默认变化、原生 reasoning 控件、明确模型选择、持久化头与 replay、UI 图像与真实 read_image、DeepSeek 图片、DeepSeek 多轮 replay、Default 清除与 provenance、运行中新增 provider、500 单次失败。500 案例启用主侧 maxRetries 2，但供应商只有一次失败调用；错误留在真实 UI 和会话，不自动再发。修复前的 `15-11-28-600Z` 与中间 `15-27-53-890Z` 成功目录保留，不替代最终源版本。

运行结果同时确认 manager/facade 安装摘要匹配、运行期间源码不变、10 个官方模块入口摘要不变、所有本轮受控进程退出，Home 根 `profiles/web` / `sessions` / `storages` 始终未创建。运行目录含源码副本、harness、截图、脱敏日志与持久化请求头；来源 Home 在报告 root 中保留。该运行无启动 fixture，不把本地受控供应商写成真实账号认证通过。

Astra 首轮独立复核为 REVISE，原文在阶段根 `ASTRA-REVIEW-1.md`：R1 丢弃官方已装配 proposal，R2 stream 派发前取消未释放 lease，R3 首次 describe 拒绝时 IPC 未清理。已修复为保留 next() 的路由/controls、失败派发一次性精确 cancel（确认失败保留原错误和清理错误）、通道建立后立即登记清理并在初始化失败时 dispose。R2 又补齐 prepare 返回后完全不迭代 stream 的取消窗口：拿到 lease 即绑定 prepare signal 并检查已 abort，实际迭代才交接到 stream，投影与派发共享一次取消句柄。新增公开 waterfall/官方 installModelSelection 暂停切换组件验证、五次真实 Supervisor 预取消、prepare signal 取消且不调用 stream、发送失败/取消失败及首次 describe 拒绝测试，16/16 专项通过。组件测试的 Agent registry 为精确身份测试对象，不单独声称真实 Agent loop；最终 UI 提供真实 loop 组合证据。

最终 Astra 独立复核 **READY，仅本阶段正式插件 / Web Agent / UI 范围**，原文 `ASTRA-REVIEW-2.md` 保留；R1–R3 已关闭，独立核对最终 14/14、安装/源码/SDK/退出/保护树证据、PROCESS-AUDIT 无存活，以及当前 facade/transport/fixture/test 四项摘要与最终源副本一致。首轮 REVISE、所有旧失败和全仓四项失败均保留；不放行 S1/P0/契约冻结/完整 P1/Desktop。

## 仓库检查

Node 26.10.0，固定 rc.2 SDK，授权外部临时根 `H:/Code/dsh-spaces-checktmp`。`checks-1` 在普通 typecheck 发现 main 服务缺少 profileContext 的公开类型导入后停止；修正类型导入，原失败保留。`checks-2` 完整执行全部 15 项，11 项 exit 0、4 项 exit 1，不能称全仓通过。

| 检查 | 结果 |
| --- | --- |
| 清单、三组 typecheck、build | 全部通过 |
| npm test | 267 pass / 1 fail：不同空间并行启动的 API ready 超时；相关测试与 ProcessManager 源码本轮未改，根因未确定 |
| spaces | 148 pass / 1 skip |
| workbench | 547 pass / 7 fail / 2 skip；7 项为外部原生构建 snapshot-worker 写入 Access is denied |
| recovery | 26 pass / 5 fail；同类原生构建写入拒绝 |
| llm | 113 pass / 0 fail |
| blueprints | 239 pass / 4 skip |
| browser | 13 pass |
| dashboard | 152 pass / 1 skip |
| 包预检 | exit 1，外部原生构建 validator.mjs 写入 Access is denied |
| workbench Chromium | 12 pass |

八组规定测试合计 1,505 pass / 13 fail / 8 skip，额外工作台 Chromium 12/12。没有修改 ACL、提权为管理员或放宽断言；原生写入拒绝与前阶段同现象，但本轮结果仍是失败。UI 验证中真实 tar 安装与摘要匹配不等于全仓包预检通过。此完整轮为 Astra 修复前版本；修复后没有重跑无关测试组或将旧失败清零。

另执行 `test:llm:integration` 17/17 与 `test:llm:browser` 1/1；不同空间并行启动在单独诊断进程 1/1 通过（约 3.9 秒），只能说明该次未复现，不确定根因，也不撤回全量组的超时失败。对应三份 `*-final.log` / `process-manager-diagnostic.log` 留在阶段根。

Astra 修复后最终执行清单、三组类型、build、LLM 117/117、LLM integration 21/21 和 LLM browser 1/1，全过，日志为 `repair-2-final-*.log`；最终 14 项真实 UI 绑定这一构建。只对受影响项重新验证，不把修复前全仓检查说成最终版本全部通过。

最终 `SOURCE-AUDIT.json`：829 个基线文件中 795 个未变、34 个本轮修改，新增 5 个产品源码、1 个测试 fixture 和本报告；变化均在本轮归属表内，既有删除保持不变，HEAD 未变。运行证据绑定的是当时的源副本；报告和账本后续只增补结果。

## 已保留的失败与修正

| 运行目录时间后缀 | 观察与处理 |
| --- | --- |
| 13-50-02 | 真实 UI 提交被 Supervisor 手写命令解析器拒绝 modelSource；补齐解析，不放宽校验。 |
| 13-54-28 | 驱动在 create job 完成前读策略；改为等待真实成功事件。 |
| 13-56-06 | 正式 facade 缺少 agents 注入，真实 Agent 报错；补齐公开依赖。 |
| 14-06-21 | 旧驱动对 High 作出不充分成功声明，实际界面有 no adapter 提示；该声明撤回。补上 native advisory controls，并检查 UI、供应商与落盘头。 |
| 14-09-26 | 只读取 Agent.options 漏掉官方 model/selection；改为采用会话中的真实显式选择。 |
| 14-20-35 | user/message 事件结构解析错误导致图像未获授权；按官方直接 Message 结构读取。 |
| 14-35-58 | 驱动未等模型选择异步确认就发下一消息；持久化事件显示 step/start 早于 model/selection，按旧配置冻结符合行为。修正驱动等待 UI 确认，不重放旧场景。 |
| 14-48-58 | 新模型配置驱动误用未限定的 loader id；改用公开 Entry.id，不修改 SDK。 |
| 14-53-46 / 15-06-39 | 目录新模型等待超时。进一步主进程审计发现 loader 更新被正式配置层覆盖，主目录也没有新 provider，因此不能单凭这两轮归因通知失败。驱动改为公开 configEditor.edit，并断言主目录先提交成功；源码同时补上认证的 catalog-updated → 现有来源 IPC → 官方 UI 目录事件，不轮询、不重启。 |

所有旧目录和失败 Home 保留。早期运行保留日志、截图与真实会话，但未全部保存不可变源副本；后续运行增加源副本、摘要与 harness 快照，不反推早期已冻结。

## 未闭合范围

完整 C01–C18、配额与流控、Files 失败政策、TOCTOU 强保证、正式辅助标题/压缩 configure 的端到端组合、多空间长期并发、安装版 Desktop 和真实供应商账号仍需其各自证据。当前“凭据不下发”是配置与传输协议边界；现有工具链继承 ambient process.env，本轮不证明恶意子进程对同一 OS 用户的环境/文件秘密具有完整隔离，也未改变该基线机制。本阶段的正式 Web 路径不关闭历史 UI 持续调查。失败不重试、不恢复、不改 SDK，也不清理失败证据。
