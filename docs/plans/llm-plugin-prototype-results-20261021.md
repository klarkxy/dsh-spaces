# 主空间 LLM 继承：插件方案阻断原型结果

日期：2026-10-21。范围：用户明确要求先验证 Astra 提出的三个阻断原型，再决定后续施工。官方 SDK、node_modules、官方安装包和生产实现均未修改；未提交、推送或发布。

**结论：三个方向的有界核心可行性已获得实证，未发现必须修改 SDK 的架构阻塞。它们不是完整集成门通过；S1、G1–G4、C01–C18 和 capability 契约仍未闭合，不进入 P1。**

## 1. 最终结果

| 原型 | 已验证结果 | 尚不能据此声称 |
|---|---|---|
| 1：服务组合与来源 | 公开 Loader 挂载插件 LlmRuntime 子类；真实官方 Agent 两轮调用、主空间默认 reasoning 更新、真实 provider/model、同名 local/main 分流、显式 shared 分支与模式切换；官方标题执行器、压缩 summarize、TokenMeter 均进入插件服务；冷 seed＋独立策略重建；默认模型 A→B 时已选标题/压缩仍用 A，新聊天用 B；主 provider 允许重试时，带 active 官方 retry 的子 Agent 遇到 500 仍只派发一次。13 项具名断言。 | 完整模型目录/metadata/计量契约、官方 UI 与其他 controls 提供者兼容、正式标题 provider 注册、完整压缩提交、官方持久化后 resume、既有生产 shared settings bridge 全链路。 |
| 2：原官方适配器的来源附件隔离 | 原 pi-ai 条目读取命名隔离附件/fs 服务；两个来源的相同 session 和合法相同内容 ID 保留各自工具路径；不同有效图片保持字节区分；官方 admission、variant、128→64 缩图、元数据校验；未授权/伪造拒绝；普通主空间仍读本地；委派入口上下文缺失、丢标记、撤销均零供应商请求且零主 store 读取；取消/return 撤销作用域；子空间文件投影及 store 实读，主空间不二次投影或发送文件正文。13 项具名断言。 | 真实子空间会话/工具权限产生授权表、跨进程 manifest 验证、通过实际子空间工具执行模型看到的地址、DeepSeek 适配器覆盖。 |
| 3：官方准备与一次派发 | 原官方插件通过公开 Loader 提供 prepareCall：旧 snapshot、下一次新配置、一次性消费、参数不符与预取消零请求、500 单次、流中取消保留部分输出、return 不可复用、configure 一次。另在独立官方 CLI profile 中实跑原服务：旧端点一次、新端点一次，参数和 marker 认证正确。9＋4 项具名断言。 | 完整认证委派通道、跨实例 lease/TTL/配额、主宿主 Supervisor 注册、多实例归属、正式安装包及 Desktop/Web UI。 |

合计为四份最终机器结果中的 **39 项具名场景断言**，不是全仓测试数量，也不是 39 项互不重复的产品验收。

## 2. 不可变结果索引

原型源码与每轮快照位于 `.sandbox/construction-20261021/p0-plugin-proofs-1/`。每个结果使用新目录；旧失败与被修正的早期成功记录保留，不改写其状态。

| 证据 | 最终结果文件 |
|---|---|
| 服务与来源 | `proof1-service-origin/run-2026-10-21T11-35-48-028Z/RESULT.json` |
| 附件隔离 | `proof2-attachments/run-2026-10-21T11-36-49-777Z/RESULT.json` |
| 公开准备 API | `proof3-preparation/run-2026-10-21T11-42-29-182Z/RESULT.json` |
| 真实官方 CLI | `proof3-official-cli/run-2026-10-21T11-44-23-018Z/RESULT.json`、同目录 `CLI-RESULT.json` |
| 汇总、结果摘要、源码边界 | `SUMMARY-final.json` |

原型使用 Node 26.10.0、已安装的官方 0.2.1-rc.2 SDK 与本机 loopback 受控供应商，没有付费模型调用。准备/Agent 等测试只加载官方服务；CLI 补充案例实际启动未修改的官方 `dsh/lib/bin.js --profile proof-main-host`，由 launcher 产生真实 profileContext，再由测试插件调用原官方服务。它是专用 CLI profile，不是字面 web profile，也不是 Desktop 或已安装 Spaces 包。

每轮核对五个关键 SDK 模块的前后摘要；最终审计确认这些摘要未变。CLI 最终案例另外比较运行中执行器的 SHA-256 与启动前保存的副本：`3cc669090640526603ebcc187ba91e404d9599c12d2cb0916c8a7a6d85434154`。这不等于整份 SDK 的新包认证或供应链验证。

附件与 CLI 涉及官方存储发布/硬链接的案例使用先前已授权的 `H:/Code/dsh-spaces-checktmp`，普通非管理员进程，新建独立 Home。未改 ACL、未换 SDK、未修改旧现场。受检 Home 的 `profiles/web`、根 `sessions`、根 `storages` 均不存在；官方 CLI 子进程最终已退出。实际资源目录见各结果的 `resourceRoot`，保留未删除。

## 3. 实际发现及修正

1. **Astra 最初关于 patch 改名的推论不成立。** `applyEntryPatches` 将 `name` 作为匹配条件，不能用它替换条目实现；首次原型被实际拒绝。已改用公开组合：在子空间配置层禁用原 llm/token-meter/compaction 条目，再插入不同 ID、提供相同服务名的插件子类条目。官方代码没有改动，也没有运行中 monkeypatch。
2. **主空间继承不能无条件重解析全部辅助调用目标。** 只有聊天请求入口读取本次主空间默认，随后 facade 尊重已选 provider/model。标题、压缩的明确真实目标保持；模型 A→B 的新增负例已证明记录与执行一致。
3. **零重试必须由继承路径独立控制。** facade 的 prepared retryPolicy 明确为零，不继承主 provider 的重试次数。最终真实 Agent 测试把主 policy 设为 2，并确认子空间官方 retry fiber active；500 仍只有一次供应商请求。
4. **旧 proof3 的 retry 声明撤回。** `run-2026-10-21T11-22-33-929Z` 中 `officialRetryPlugin500SingleSupplierCall` 超过证据：当时主 fixture 缺该插件依赖，且直接 stream 不触发 Agent 错误处理。最终 proof3 改为 `directPrepared500SingleSupplierCall`；真正的 retry 证据归 proof1，不能引用旧结果关闭 C14。
5. **来源状态不能从旧请求值猜测。** 原型曾在 local→main 后冷重建时沿用旧 high reasoning；现由明确的插件模式与显式 controls 状态处理。它只证明这一自有策略模型，不能推定已经兼容官方 UI/其他 waterfall 提供者的显式值。
6. **附件入口必须与普通本地入口区分。** 不能将“标记不见了”解释成普通主空间请求。最终原型用独立委派身份标记与已签发的进程内上下文能力检查；三种上下文失效负例都有主 store 同名对象作为对照。

其他早期 harness 失败也保留：异步流中间件误写为同步 generator、把 GenerateOptions 的 signal 带入仅供配置的准备参数、断言漏掉官方 `sha256:` 内容 ID 前缀；CLI 首轮误写会被启动器重建的 cordis.yml，随后误用未限定的子树条目 ID。分别修正测试代码后建立新案例，未修改 SDK 或重启原失败环境。仓库内官方附件发布失败的具体底层错误未取得，不将其猜测成已确定的 ACL 根因；新普通进程/外部 Home 案例通过。

## 4. Astra 独立复核

已由实际 `gpt-6-astra` 子代理只读核对源码快照、结果与必要官方实现。首轮指出 retry 证据错误、零重试策略遗漏、辅助目标漂移和入口上下文负例不足；主代理修正后，Astra 接受三个方向为“有界核心原型成立”，未发现需要修改 SDK 的架构否决点。

Astra 还接受独立官方 CLI 的补充证据，但明确它不能关闭完整 G1。其最后指出的执行器未绑定运行时摘要问题，主代理另建 `11-44-23-018Z` 案例完成前后摘要校验；该最后的摘要补强由主代理核验，不冒称 Astra 又独立运行了一轮。

## 5. 决策边界

本轮已经执行验证，不再停留于候选 API 文字。原“必须新增官方接口”的阻塞假设不再成立；可以据此讨论插件集成验证的下一阶段。

但三个原型仍通过可信的进程内对象连接主/子服务，不提供生产认证协议。完整 facade 查询契约、模型目录、UI controls、正式标题与压缩、持久化 resume、实际工具路径、真实会话授权、DeepSeek、HTTP/实例/lease/配额、多轮工具/replay、正式包及 Desktop/Web 均需后续明确范围和证据。

当前 817 个非协调文档产品文件仍与 S0 一致。生产源码未改；本轮只新增隔离原型与本报告、同步既有计划和账本。S1 普通终端全量结果与 Desktop 四项仍待，P0 不闭合、capability 不冻结、P1 不启动。用户要求“验证结果出来再决定后续施工”，本轮止于该结果交付。
