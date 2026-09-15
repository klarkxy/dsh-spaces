> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。
# 插件化验收记录

续接：2026-09-12 的中文界面、正式安装/替换/卸载、真实未知版本与 Windows 安装包载荷验收见 [可分发试用验收](pluginization-trial-acceptance.md)。下文保留 2026-09-11 的首批记录。

日期：2026-09-11。分支：`codex/spaces-pluginization`，基线 `dfe9ae0ed760ee1e6fe9e9d9e5d057e9451981b7`。

本次完成引用方案的 Phase 0 + Phase 1：共享核心、保留既有功能的桌面适配器、DSH Host/Web 原生插件，以及独立 doctor。Grok 承担通用实现、测试和运行验收，Kimi 承担前端，Codex 负责接口、编排、集成审计与独立复测。未提交、推送或发布。

## 交付内容

- `src/core`：隔离与注册表规则、维护门禁；桌面与 Host 共同使用，提供 `@dsh-spaces/core` 包。当时一并抽出的恢复流程及端口是 2026-09-11 实现事实，作为产品能力 **已撤销**（R4）。
- `src/adapters`：Node 文件/进程适配、跨进程 Home 锁、桌面调用入口、Host 能力与身份判断。失败操作保留日志。损坏或无法读取时 fail closed、说明无法读取并保留原字节；**不**进入 recovery-only，也不得要求先恢复再允许其他写入。
- `@dsh-spaces/plugin`：在 DSH 侧栏追加 Spaces，独立主面板提供列表、详情、诊断、插件元数据、非宿主 Space 创建与隔离验证。当前宿主拒绝写入，未知版本只读，浏览器接口不接受任意路径或命令。快照恢复不是现行面板能力。
- `@dsh-spaces/doctor`：独立诊断与受锁保护的验证。不会自动抢锁。显式回收死锁、`recover` / `rollback` 以及“完整恢复由桌面执行”均 **已撤销**（R5：旧命令须返回不支持和非零退出）。

## 验证结果

| 验证 | 结果及证据 |
| --- | --- |
| 原有回归测试 | 180 通过，0 失败/跳过；`.sandbox/pluginization-final-desktop-tests.log` |
| 新增核心、锁、Host、前端、doctor 测试 | 83 通过，0 失败/跳过；`.sandbox/pluginization-all-spaces-tests.log` |
| 桌面及插件 TypeScript 检查 | 通过；插件最终检查 `.sandbox/pluginization-final-spaces-typecheck.log` |
| 桌面及三个新包构建 | 通过；`.sandbox/pluginization-desktop-build.log`、`.sandbox/pluginization-final-spaces-build.log` |
| 真实 DSH Web 插件 | 打包产物在临时 coding profile 实际加载；RPC 创建/验证、宿主拒绝、非法路径拒绝、浏览器创建/验证、原生新会话入口均通过，页面错误为 0 |
| Windows Electron 运行 | 独立临时 Home、userData、工具链；启动、认证后的嵌入视图、重启、元数据保存读回、停止与退出通过；两个子进程端口均关闭 |
| 独立包入口 | core 构建产物可导入并执行隔离/门禁逻辑；doctor 构建入口可对临时 Home 输出诊断 |

真实插件环境为 CLI `0.1.5-rc.1` 与已安装 SDK `0.1.5-rc.2`。验收使用本地 tarball 解包和真实 SDK 依赖链接，并记录产物哈希；没有替代 Host、RPC 或浏览器模块加载器。没有运行模型或接触生产 DSH 数据。

运行证据：`.sandbox/spaces-plugin-acceptance/{results.json,sdk-provenance.json,spaces-sidebar.png}`、`.sandbox/spaces-desktop-acceptance/{results.json,coding.png}`。复现入口为 `npm run validate:plugin` 和 `node --import tsx scripts/verify-spaces-desktop.mjs`，需提供脚本记录的实际 CLI/工具链 fixture。桌面截图停留在 DSH 首次使用介绍页；该验收验证了认证与生命周期，不声称已完成聊天操作。

## 集成审计中修正的问题

- 按实际 DSH SDK 接入 Slots、RemoteError 和 Typert 描述；浏览器使用宿主模块加载器及 React，Node ESM 包补齐依赖所需的 `createRequire`。
- Home 锁接入桌面实际写入入口、启动和退出；补齐回收竞争、释放失败、未完成操作和全量恢复后的日志处理。
- Host 自有操作权限改为异步调用上下文隔离，外部观察请求不能继承写入权限；损坏注册表与不合法文件名在写入前拦截。
- 安装后的 Host 使用实例级生产目录许可，不通过修改进程环境解除其他组件的目录保护。
- 前端修复同一选择的旧响应覆盖新响应问题；验证结果显示为“最近一次检查”，不会冒充持续监控。

## 保留边界

- Phase 2 若继续，只含 Web 启停、插件变更、运行时安装/升级（无快照恢复、无失败回滚）。**快照恢复 已撤销**（2026-09-15），不是未开放的后续阶段。Phase 3 多实例浏览器嵌入仍是独立设计。
- standalone `unlock` / `recover` / `rollback`：**已撤销**。R5 要求明确返回不支持和非零退出，不得改成桌面恢复指引或隐藏旧实现。doctor 默认保护生产目录；现行目标只诊断，见 [packages/doctor/README.md](../packages/doctor/README.md)。
- 真实验收仅 Windows、未打包 Electron 和上述 CLI/SDK 组合。未知版本只读由单元测试覆盖，未另启未知版本进行现场验证；macOS/Linux、安装器未验收。
- 插件管理器的安装命令和公共包仓库发布未执行；已验证的是交付 tarball 的实际加载与使用。
- 当时快照目录需要 Host 显式配置、未配置时界面说明不可用，是 2026-09-11 事实；快照恢复不再是现行能力。前端首版英文。直接运行的外部 DSH 命令不参与 Spaces 锁协议。
