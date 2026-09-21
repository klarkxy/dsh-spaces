# 蓝图实施记录

日期：2026-09-21。基线：`69272767787827f2c462d996ff8f800fc66842e6`。状态：实现与验收完成，后续经用户授权提交、推送，已随 0.4.0 发布。正式产物证据见[发布验收记录](release-0.4.0.md)；下文保留本地实施阶段的范围和证据。

目标：普通用户能在同一个桌面/浏览器工作台生成、复制、读取和应用 JSON / 分享码蓝图；开发者能根据根目录 [BLUEPRINT.md](../BLUEPRINT.md) 制作蓝图。插件组成、顺序、预设和本机绑定真实生效，失败保持可见。蓝图与数据备份、迁移及旧 ZIP 分享保持独立。

用户明确指定 Grok 施工，含本轮前端；主 Agent 维护合同、文档、Git 和独立验收。Grok 使用 CLI 默认模型与推理配置。实施阶段未授权提交、推送或发布；后续“提交推送打版本”授权开启发布阶段。始终未授权真实 Home 操作。

## 工作区和范围

起始未提交内容为此前编写的规范、样例和 `tasks/todo.md`；`.pnpm-store/` 是已有本地产物，保留。规范移至根目录，原文内容保留并修正相对链接。

依赖沿用项目现有 YAML、Zod 和官方 DSH 组件，npm SemVer 解释使用明确声明的 `semver`，不写另一套范围求解器。没有新后台、数据库或恢复服务。

v1 必须完成 npm 来源；GitHub 来源按规范属于可选能力，不能支持时在写入前明确拒绝，不改来源。实现不得通过缩小 JSON 码限制、丢设置、只做页面 mock 或只生成静态 JSON 来宣称完整交付。

## 分批施工和归属

| 批次 | Grok 写入范围 | 主 Agent 工作 |
| --- | --- | --- |
| B1 | `src/shared/blueprint.ts`、`src/core/domain/blueprint.ts`、`src/adapters/node/blueprint-codec.ts`、`schemas/blueprint-v1.schema.json`、对应域/codec测试 | 规范、依赖声明、后续接口与既有行为基线 |
| B2a（与 B1 独立） | `src/adapters/node/blueprint-package.ts`、`tests/blueprint-package.test.ts` | npm 归档身份、摘要与包内 patch 证据检查 |
| B2b（独立运行时证据） | `src/adapters/node/blueprint-runtime.ts`、`tests/blueprint-runtime.test.ts` | 绑定实际 DSH 安装的只读组合与模块解析合同 |
| B2 | 蓝图 Node 装配/生成模块、product 合同/校验、Supervisor 接线、HTTP 大小边界和后端测试 | 检查共享合同、权限/隔离、秘密边界和真实安装方案 |
| B3 | `packages/plugin/src/workbench` 下蓝图 UI、store 和相关测试 | 提供中英文文案，独立用户流程验收 |
| B4 | 按审查发现分配修订；验收脚本与样例 fixture | 根文档、README、验收执行、独立集成审查 |

一次只有一位 Grok 实现者拥有同一写路径；后批使用已验收的前批合同。主 Agent 不把阶段完成当作用户目标已完成。

## 应用结构约定

1. 蓝图只读内容预览走现有 `WorkbenchApi.product`，保持 Host 与 Supervisor 两层鉴权和请求/响应校验。
2. 固定来源文本、目标名称、输入、本机连接观察及控制服务 epoch/revision 后，服务端保存有 TTL 的一次性暂存计划。应用命令只携带计划 ID，不把原始内容、本机目录、连接输入或凭据放入持久 job。
3. 正常创建、插件安装、bundle 顺序装配、预设及模型绑定复用 Supervisor 和现有写入边界。发布后失败保留现场；不重试、回滚或续跑。
4. 包安装来源、版本和可选 SHA-512 摘要必须校验实际制品；最终配置检查不能悄悄启动插件或模型调用。实际启动另由用户正常发起。
5. 生成蓝图时先给出可选择的直接包、配置与 settings namespace，保留无法分享的原因。不能从 bundle 列表冒充全部已安装直接依赖。
6. 绑定来源记录留在目标空间已有本地数据范围，供重新生成时恢复占位符；它不成为第二个配置真源。绑定结构变化须报告，不猜测，也不复制源机器秘密。

### B2 接线审阅后固定的要求

- 新下载与缓存命中都验证实际制品，安装同一个已经验证的 tarball；不能校验后又按包名重新下载。安装后读回实际身份。
- 计划复核与消费在同一串行边界、首次变更之前完成。同一 requestId 返回原任务，不同 requestId 竞争同一计划最多执行一次。暂存有 TTL 和总量限制，消费后释放内容，不跨重启续跑。
- 现有 state revision 不覆盖所有文件。另固定本次依赖的实际运行时、基础配置、Home patch及LLM catalog观察；生成读取 dependencies、bundles、patch、settings、provenance 时发现前后变化就拒绝，不做全Home版本系统。
- 在已获写入权的内部LLM路径完成绑定及桥接，不再次排入自身等待的独占队列；最终bundle装配保留受管桥接层，后写用户预设不得覆盖刚写入的受管模型配置。
- Host与Supervisor双层请求/响应限制均覆盖大蓝图。部分失败先保存经过验证的四阶段公开结果，再使任务failed；本机目录、模型输入与原始预设不写入公开job或错误。

## 验收证据

### 最终真实流程与独立复核（2026-09-21）

最终构建在 `.sandbox/blueprint-acceptance/live/run-pmV3U3` 完整通过，进程退出码 0；`results.json` 为 `pass`，无 `cleanupError`，`pageErrors` 为空，模型调用数为 0。真实 DSH 为 `0.1.5-rc.2`，本地 Spaces 组件为 `0.3.1`。该版本号沿用工作区基线，不表示功能已经发布。

| 流程 | 当前证据 |
| --- | --- |
| 只读预览与本机输入 | 预览不创建空间；缺少输入阻止应用；版本范围诊断保留，不冒充运行兼容保证 |
| 实际插件与预设 | 通过官方 CLI 安装 `dsh-theme-plugin@0.3.3`、`is-number@7.0.0`，读回身份、bundle 区别、patch/settings 和本机模型绑定；创建后不自动启动 |
| 重新生成与重复应用 | 实际 npm 包可再次选择和分享；本机目录/连接/测试秘密不进入分享内容；同一已消费计划的第二次应用失败 |
| 实际运行 | 另行正常启动成功；官方 `session/modelCatalog` 确认绑定模型可路由且为默认选择；竹青主题 CSS 在真实页面生效；正常停止成功 |
| 浏览器 | 粘贴、查看、预览、创建、生成、复制分享码、保存 JSON、读取文件通过；失效预览和 BOM 输入拒绝；成功后没有错误的过期提示或重复创建按钮 |
| Electron | 同一后台服务上创建停止状态空间；关闭桌面后服务仍可访问；最后正常关闭服务 |
| 隔离 | 每轮新建测试 Home；`profiles/web`、默认 `sessions` / `storages` 均未创建；桌面使用独立用户数据和工具目录 |

原始证据包括 `applied.json`、`generated.json`、`actual-model-catalog.json`、`results.json` 及主题、浏览器生成和桌面创建截图；已人工检查截图。测试脚本为 `.sandbox/blueprint-acceptance/live-current.mjs`，它只在测试进程中附加输出观察，不修改被测产品行为。

蓝图集成 v3 独立审查为 PASS / READY。真实启动暴露的模型桥兼容问题已一并修订：官方 bundle patch 格式、服务依赖声明、避免重复注册凭据服务、已注册消费者的共享模型投影、保留用户消费者的注册归属、正常卸载时撤下投影，以及保留名称冲突的请求拒绝。共享 provider 不写进空间用户设置。模型桥针对当前官方 SettingsProvider 的内存注册/提交接口做明确能力检查；不支持的实现失败，不切换替代实现。

模型桥补充审查最终也为 PASS / READY。三个独立脚本直接加载官方 Context、FileSettingsProvider、LocalCredentialProvider、PiAi 和 AgentDefaultModel，退出码均为 0；覆盖既有/后加载消费者、两种卸载顺序、初始/运行中冲突、整段修改绕过、本地凭据委派和共享只读。证据位于 `.sandbox/blueprint-review-current/bridge-final-direct-results.json`、`bridge-boundary-final-results.json`、`bridge-lifecycle-conflict-final-results.json`。最终源码与 manifest 哈希在审查前后保持一致。

限制：本轮验证的是 Windows 上本地构建的 Electron 和实际打包组件，不是新 NSIS 安装包的安装/卸载验收；没有验证其他操作系统、长期运行或真实模型推理。四项文件符号链接用例因 Windows 权限限制跳过，不记为通过。没有提交、推送或发布，也没有读写真实 DSH Home。

最终独立执行结果：

- `npm run test:blueprints`：200 项，196 通过、4 项上述权限限制跳过，0 失败。完整输出位于 `.sandbox/blueprint-acceptance/final-blueprints.log`。
- 模型桥的三组真实官方服务回归已归档到 `tests/fixtures/llm-bridge-runtime/`，由 `tests/llm-packaging.test.ts` 启动；不依赖审查目录，每项使用独立临时 Home。该文件 5 项测试全部通过，并已包含在蓝图测试命令内。
- 最终源码的凭据、秘密不落入任务记录、既有模型设置及 LLM gates 合跑 12 项通过。本轮早期的旧分享、模板、工作台与接口阶段回归为 78 项通过，保留为阶段证据。
- `npm run typecheck:spaces`、`npm run typecheck`、`npm run build` 通过；最终 `git diff --check` 通过。

实现由 Grok 完成，主 Agent 独立核对实际变更、运行测试与双端流程；模型及推理配置沿用 CLI 默认值。逐任务自动调度遥测曾受本机写入权限限制，最终自动收尾报告仍不完整，不能据此声称完整成本或容量审计；上述产品验收不依赖该遥测。所有本轮外部执行会话已结束，独立审查任务已完成。

下面保留施工中的阶段证据和失败现场；其中“待验”“正在修订”均指当时状态，不替代本节的最终结论。

### 本线程接续（2026-09-21）

用户审查范围后确认继续施工，并明确要求不再在旧任务中推进。旧任务最后一批前端、后台和运行时适配器均已结束；当前任务统一接收结果、安排修订和验收。已纠正的前后端测试文件归属冲突不再沿用：`workbench-blueprint.test.ts` 属后台，`workbench-blueprint-file.test.ts` 属前端文件读取测试。

- 集成修订后的蓝图测试为 193 通过、4 跳过；跳过项均为 Windows 文件符号链接权限限制，正常进程权限下仍无法创建该类链接。目录 junction 和 tar 内链接成员检查实际执行。相关旧分享、模板和工作台回归 78 项通过，LLM gates 5 项通过。Spaces、桌面 Node/Web 类型检查与构建通过。最后的模型桥启动修订仍需追加检查。
- 专用管理空间由官方 CLI 在新的测试 Home 创建，未创建 `profiles/web` 或默认 `sessions` / `storages`。预览保持只读，缺少输入不能应用，作者版本范围不符保留为诊断。
- 首次应用因模型策略 CAS revision 使用错误失败，现场保留在 `.sandbox/blueprint-acceptance/live/run-6thSjX`。修订后，在 `run-4q9jFc` 通过真实 npm 安装 `dsh-theme-plugin@0.3.3` 与 `is-number@7.0.0`，读回 bundle 区别、patch/settings、本地模型桥和四阶段成功结果；空间保持停止，模型调用数为 0。随后重新生成被来源识别错误挡住，整轮不记为通过。
- `run-hM5y6n` 使用本地构建并打包的组件，通过真实浏览器粘贴、预览、创建、生成、复制、保存与文件读取，以及失效预览和 BOM 拒绝。真实 Electron 接入同一服务并创建停止状态空间；关闭桌面后服务仍可用。该轮为界面专项，不代替插件与模型的完整往返。
- Chromium 自动化使用临时测试权限，并先访问管理源以取得剪贴板写权限。产品只在受控管理 iframe 声明 `clipboard-write`，未增加剪贴板读取或全局权限头。桌面验收使用隔离 Home、用户数据和工具目录；受限环境的启动失败保留记录，正常进程权限下的上述桌面专项通过。
- 制品模块的独立审查通过。集成审查曾要求修订 Home settings 隔离覆盖、无 name overlay 跳过组合、合法宿主模块被误拒、显式重选绑定无法生效、官方相对 file 来源无法重新生成，以及来源不确定时误放行和重复宿主探测的问题。修订后的 v3 独立审查为 PASS / READY；实际官方组合器与隔离探测 42 项通过，包含持久失败记录和模型绑定后的最终组合检查。该审查使用安装/模型 fixture，不替代真实启动。
- 创建成功后错误显示“预览已失效”的界面问题已修订：已消费计划保留归属信息，但不再显示过期提示和重复创建操作；后来新建的预览不受旧任务结果影响。
- `run-hRF4kM` / `run-Hi476l` / `run-r6fdnm` 的真实安装、模型绑定、预设、重新生成与重复应用拒绝均通过，后续用户式启动失败。已先修正模型桥 bundle YAML 的官方格式；`run-r6fdnm/child-output.log` 进一步确认官方 Cordis 拒绝模型桥未声明的 `credentials` 服务访问，当前正补齐依赖声明。每轮失败均保留，不改记成功。

`npm run test:blueprints` 已纳入生命周期、公共接口边界、真实双源剪贴板和模型桥打包检查。完整启动及最终双端流程仍待完成。每次验收使用新测试 Home，不续跑此前失败的任务。

### 施工前基线

- 独立运行 `tests/workbench-products.test.ts`、`tests/space-recipe.test.ts`、`tests/workbench-protocol.test.ts`、`tests/llm-share.test.ts`：59 项通过。该结果仅覆盖施工前既有功能。
- 前期规范阶段已核对两份样例 JSON 和 J/Z 编码往返；不作为蓝图运行时实现通过的证据。
- 本机可用官方 CLI 为 `0.1.5-rc.2`，从其安装代码核对了 Cordis patch 的 `insert` / whole-config 替换，以及 Loader 对 `__jsExpr` 对象的求值行为。蓝图必须拒绝该动态标记，不能只检查 YAML 标签。未触碰真实 DSH Home。

### 界面文案合同

共享工作台增加独立“蓝图 / Blueprints”入口；粘贴/读取与生成同属该页，旧分享和数据导入入口不复用名称。源空间菜单提供“生成蓝图 / Create blueprint”。正文尽量用控件和结果表达，不增加解释性卡片堆叠。

| 位置 | 中文 | English |
| --- | --- | --- |
| 输入 | 粘贴分享码或 JSON | Paste a share code or JSON |
| 文件入口 | 读取蓝图文件 | Open blueprint file |
| 初次解析 | 查看蓝图 | View blueprint |
| 应用前 | 预览创建 | Preview creation |
| 最终操作 | 创建空间 | Create space |
| 安装提示 | 将安装所列第三方插件，安装过程可能执行包内脚本。完成后不会自动启动空间。 | Installs the listed third-party plugins and may run their package scripts. The space will not start automatically. |
| 生成 | 生成蓝图 | Create blueprint |
| 输出 | 复制分享码 / 保存 JSON | Copy share code / Save JSON |
| 内容选择 | 插件 / 配置预设 / 设置 | Packages / Configuration presets / Settings |
| 结果阶段 | 空间创建 / 插件安装 / 预设写入 / 空间启动 | Space creation / Package installation / Presets / Space start |
| 成功但未启动 | 已创建，尚未启动 | Created, not started |
| 失效预览 | 预览已失效，请重新预览。 | This preview is no longer valid. Preview again. |
| 不支持来源 | 当前版本不能应用 GitHub 来源的蓝图。 | This version cannot apply blueprints with GitHub sources. |

上述字段和文案由主 Agent 负责；Grok 按合同接入现有 i18n 与组件。额外错误保持简短、可定位，不包含本机路径或秘密。

### 制品校验第一轮

- Grok 的 B2a 首轮交付后，主 Agent 独立运行 `tests/blueprint-package.test.ts`：22 项通过，无跳过。该轮使用本地归档和注入 registry 响应，不能冒充真实公网安装验收。
- 独立审查要求继续修订实际 manifest 身份的原文比较、归档成员为普通文件的检查，以及读取期间取消；正在原范围内施工。
- 实际验收 Home 已通过官方 CLI 创建专用管理 profile，并补入现有隔离配置。`profiles/web`、默认 `sessions` / `storages` 均不存在。后续在该专用管理环境中验证；不把这次准备视为 Supervisor 首次初始化流程已验。

### 数据层第一轮

- 主 Agent 独立运行域与 codec 测试：47 项通过。
- 另行探测发现分享码中的 UTF-8 BOM 被 `TextDecoder` 去掉而误收；代码审查发现指定组插入、同 id 有序修改，以及非对象 JSON 配置的官方语义未完整覆盖。已将这些差异及绑定值、模块子路径边界交给原 Grok 任务修订，不把首轮通过当作 B1 验收完成。

### 数据层与归档修订后

- 主 Agent 独立合跑域、codec、制品校验：84 项通过（56 + 28），无跳过。独立 PAX 长文件名探测通过。
- 对实际 npm 发布的 `dsh-theme-plugin@0.3.3` 执行了下载、SHA-512、身份和 bundle 声明校验；随后禁用 fetch 验证缓存命中仍核对实际字节。通过，但这一步尚未安装或启动插件。
- 制品读取使用项目已有的 `tar@7.5.22`，已明确声明为生产依赖；移除手写 tar 头/PAX 扫描与系统 tar 子进程。仅流式读取校验后的字节，保留解压总量、成员、正文及时间限制。

### 后台候选审查

首轮独立审查为 REVISE。隔离探测复现了秘密边界、目录父级别名、无效本机输入延后失败、来源记录覆盖当前内容、无法重新生成已验证 npm 安装，以及组合被跳过却报告成功等问题；修订前均不能视为通过。审查还检查了持久结果脱敏与部分完成记录。探测未执行真实安装、启动或模型请求。

实际官方 `@deepseek-ai/dsh-app-boot` 提供只读 `loadProfileDirectory`、`resolveBundleDir`、`composeEntries` 等接口。B2b 从绑定的 CLI 解析这些能力，取得真正的宿主版本、层文件观察、组合警告及模块出口；不调用初始化、boot 或修复接口，不另写 patch 解释器。注意官方 bundle 解析以 DSH 安装位置优先，不能把 profile 中存在同名包当作实际采用该版本的证明。

### 本轮待验

- 域/编码：重复键、严格 UTF-8/数值、大小和深度限制、截断与尾随压缩数据、输入绑定、版本关系、Schema 与例子一致。
- 后台：纯预览无写入，暂存计划过期/复用/epoch和状态变化，输入映射与目录保护，摘要和身份不符，首失败终止与配置写入失败，无自动启动。
- 生成：直接依赖与激活层分离，命名空间选择，静态禁用状态，动态表达式和本地来源明示，本机绑定重新生成不泄露。
- 真实环境：独立非真实 Home，经实际 DSH/安装器创建蓝图空间，读回包、bundle顺序、patch/settings和四阶段结果，必要时用户式独立启动验证。
- 界面：在真实共享工作台完成粘贴/文件读取、预览、填写、应用、生成/复制/保存；错误、取消、失效预览与无意自动启动也要检查。
- 回归：相关工作台、模型、旧分享/模板、类型检查和打包构建；根据实际差异确定范围。

所有尚未执行的项目保持待验，不用 worker 自述或 mock 通过替代当前最终位置上的证据。
