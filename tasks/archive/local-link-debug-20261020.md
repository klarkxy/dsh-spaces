# 根目录本地链接调试（2026-10-20）

用户确认以仓库根目录作为本地插件安装入口。本轮仅修改开发入口和调试流程，不提交、推送或发布；保留进入本轮前的未提交改动。

## 布局与行为

- 根目录私有包使用现有 `@dsh-spaces/plugin` 身份，导出 `packages/plugin/lib` 的宿主、客户端与远程接口，复用 `packages/plugin/cordis.patch.yml`；共享宿主依赖的 peer 声明与发行包一致。
- `packages/plugin` 保留独立发行布局。Supervisor、manager plugin、view-bridge、browser、llm-bridge 和 installation worker 的六组件组、摘要校验及冷启动选组保持原有契约。
- `npm run dev:web` 构建并链接根目录，使用 `.sandbox/dsh-link-home` 的独立 `spaces-dev` profile，保留调试数据；重复启动验证原链接并复用，不打包或重新安装。`npm run dev:link` 只准备链接。
- 不存在 Home 时按需创建；自定义 profile 首次从官方 Web 模板创建，后续不重新应用模板。拒绝真实 Home、共享测试 Home、重定向的 Home/profile，以及已安装其它来源或未登记的同名插件。
- Windows 下通过 Node 运行 npm 入口查询全局安装位置，避免直接把 `.cmd` 传给 `spawnSync`。
- 修改后需要重新构建和显式重启宿主；服务组件变更还需正常停止 Spaces 服务后再进入。没有自动重启、热替换、失败重试或恢复流程。

## 验收

目标为 Node 26.10.0 与官方 DSH 0.2.1-rc.2。官方契约参照[对应 tag 的插件安装说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/user/develop/basic/publish.md)。

- 全新仓库隔离 Home 中，官方 CLI 将根目录登记为 `link:H:/Code/dsh-spaces`；配置层包含 `dsh-spaces`，实际目录链接指向仓库根目录。
- `root-plugin-link.test.mjs` 验证宿主、客户端、远程接口和 patch 的实际链接解析，检查根目录与发行包身份和共享依赖声明；不将拷贝包误判为开发链接。受限环境无法创建链接时明确跳过；本次非受限验证两项均通过。
- 真实官方 Web 启动后，在 Chromium 中打开工作台，初始化入口可用，未观察到页面异常或插件资源失败；没有执行初始化、模型调用或空间生命周期测试。宿主与浏览器已关闭，监听端口关闭。
- 本轮隔离 Home 不含 `profiles/web`，没有访问真实 `~/.dsh`。浏览器证据和机器结果在 `.sandbox/root-link-20261020/linked-workbench.png`、`live-result.json`。
- 规定的清单、三组类型检查、完整构建、八组测试全部通过：合计 1,587 通过、7 项现有平台权限条件跳过，0 失败。发行包预检也通过。完整输出在 `.sandbox/root-link-20261020/check-*.log`，退出码在 `checks.ndjson`。
- 隔离 Home 中实跑了根目录 `add .`；随后不指定测试 CLI，`npm run dev:link` 正确发现本机全局官方 0.2.1-rc.2。重复准备链接后，profile manifest 摘要、目录链接时间及开发者数据标记不变；重新构建的客户端文件通过同一链接可见，未重新安装或应用模板。结果在 `repeat-result.json`、`manual-add-dot.log` 和 `repeat-dev-link.log`。
- 最后对最终脚本重跑两项链接检查，均通过；源码空白检查通过。本轮只验证官方 Web 的加载入口，没有宣称安装版 Desktop 或完整初始化/空间生命周期验收。

调试入口说明见[本地链接调试](../../docs/plugin-standard-install.md#local-linked-development)。旧 `dev:web` 曾清空调试 Home 和安装 tarball 的历史记录不代表现行行为。

## 追加：软链接完整生命周期验收

2026-10-20，按用户追加要求，在全新隔离 Home 中通过浏览器按钮完整测试。目标为官方 DSH **0.2.1-rc.2**、Node **26.10.0**、Chromium。产品源码未改动；没有模型调用，没有提交、推送或发布。

**正常路径通过，导航边界仍有问题。** 最终 `run-7` 在侧栏收到新运行态后执行单次选择，完成下列步骤；此通过不覆盖前轮实际观察到的导航失败。

| 步骤 | 结果与证据 |
| --- | --- |
| 根目录安装 | `npm run dev:link` 构建后登记 `link:H:/Code/dsh-spaces`，实际目录链接指向仓库根目录；安装后尚无管理器。 |
| UI 初始化 | 点击“初始化 Spaces”，显示真实管理工作台；仅创建 `spaces-hub`。manager PID 20972，Supervisor PID 55696。 |
| UI 创建 | 创建 `coding` / “链接调试”，登记为 `space-coding`，初始为 stopped；安装轻量 view-bridge，不安装完整管理插件。 |
| UI 启动 | 点击“进入空间”，作业 succeeded；PID 60876、generation 1、端口 3133。完成该空间自己的官方首次使用引导，显示原生 DSH 页面。 |
| UI 重启 | 设置→空间→重启→确认，作业 succeeded；等待侧栏同步到新运行态后重新选择空间，原生页面可见。PID 60876→65252，generation 1→3，旧进程退出。manager、Supervisor、serviceEpoch 和注册 createdAt 均未变化。 |
| 重建与宿主重开 | 正常关闭入口宿主，`npm run build`，再启动并进入既有工作台和空间。同一 manager、同一空间进程、同一 serviceEpoch；根目录链接保留，构建产物字节未变化。没有重新安装入口插件。 |
| 正常停机 | `service.shutdown` 的持久化作业 succeeded，Supervisor、manager 和空间进程退出；入口宿主另行关闭。端口 4911 / 3133 / 3132 / 6992 / 1937 无监听，独立进程检查未发现本轮 Home 对应的遗留 Node 进程。没有强制清理。 |

最终证据位于 `.sandbox/root-link-lifecycle-20261020/run-7/`：`result.json`、`02-initialized.png`、`03-create-form.png`、`05-started.png`、`06-restart-confirmation.png`、`07-restarted.png`、`08-host-reopened.png`、各阶段 state、原生页 ARIA、跨窗口消息记录。`cleanup-audit.json` 位于其父目录。停止服务时 HTTP 连接中断，成功判断依据是持久化作业、进程退出和端口关闭，不把连接中断本身当成成功。

隔离 Home 的默认 sessions/storages 由官方宿主首次打开时创建；初始化前取目录与 SHA-256 基线，Spaces 初始化、创建和重启期间未改变该基线。宿主重开会更新自己的缓存，重开后另取基线再检查进入 Spaces。所有测试 Home 均未创建 `profiles/web`，没有访问真实 `~/.dsh`。

### 前轮导航问题记录（修复结果见下节）

1. **重启完成与侧栏状态同步有窗口。** `run-6` 后端已显示 running / generation 3，磁盘实例记录 PID 36452；紧接着点击侧栏时，宿主却提示“该空间尚未运行”。消息记录没有发出该空间的选择消息，与 `HostShellController.select` 使用缓存 inventory 拒绝选择的分支一致。`run-6/07-restarted-before-selection-state.json`、`restarted-process-observed.json` 和 `failure.png` 保留了相互冲突的状态。最终轮只在实际侧栏接收 running / 新 generation 后点击，没有修改产品来绕过检查。此窗口未修复。
2. **首次进入期间相邻点选曾握手失败。** `run-2` 在“进入空间”后紧接着点击宿主侧栏，后端启动 succeeded，但宿主页报告“空间视图未能完成认证或握手”，未显示空间页面。证据为 `run-2/failure.png`、`result.json` 和持久化作业。尚未证明该失败由软链接布局导致，也未完成根因定位。
3. **正常重启会卸载旧页面并出现空白间隙。** 最终轮通过正常侧栏重新选择新 generation 后完成显示；本轮没有将其描述为无缝重启或热替换。

中间轮次的驱动错误单独保留，不计为产品失败：首轮将官方宿主启动前的目录“不存在”误作初始化基线；后续补齐空间内首次使用引导、区分“新会话”显示文字与“新建会话”可访问名称，并处理确认计划后设置窗口已关闭的行为。每轮使用新的 Home，没有修补旧 Home 或重放失败作业。最终成功轮与实际边界失败均保留，未用最后一次通过覆盖之前的证据。

## 追加：两处导航修复与软链接复验

2026-10-20，用户授权修复上述两处导航问题。**两处已修复，新的完整软链接 UI 验收通过；规定测试中的维护组仍有 Windows `EPERM` 失败，不能声明全套全绿。** 前轮失败与成功现场均保留。

### 实现与针对性回归

- 宿主侧栏和 portal 只用缓存确认可见成员，不再凭缓存中的 stopped / starting 拒绝进入；每次正常点击仍由 manager 单次读取当前权威状态，确认空间真实 running、具备 Web 应用、不是 manager 或 Host、serviceEpoch 相同。真实停止的空间不会被侧栏隐式启动；来源、窗口、channel、generation 与成员身份校验保留。
- manager 将用户导航意图与视图加载 token 分开。首次启动被状态查询或后台轮询推进时，不再误取消同一用户选择；随后选择首页或其他目标仍会使旧请求失效。同一空间、同一 generation 正在加载的认证请求和握手沿用，不重复申请视图。没有增加重试、重连或恢复流程。
- 新增/调整的五个用例分别覆盖宿主缓存、portal 转发、首次启动相邻选择、同目标在途认证、轮询抢先推进。修改前均复现失败，最终相关两文件 **102/102** 通过；保留真正 stopped 拒绝、后续 Home 选择取消旧请求、旧服务和错误通道校验。`store.ts` 为既有超长文件，本次仅改导航状态与局部选择逻辑，不作无关拆分。
- 真实浏览器回归 **11/11**：包含 stopped 缓存下立即双击已运行空间、只为该空间申请一次视图、原生 DOM / 草稿保留，以及原有认证失败不重连用例。初次新增断言误把 Home 看板对 manager 的正常视图查询也计入，失败日志保留；按目标空间计数后通过，没有修改产品绕过断言。

### 全新 Home 实测结果

证据根目录：`.sandbox/link-navigation-fix-20261020/`，最终完整轮次 `run-1/`。使用未修改的官方 **DSH 0.2.1-rc.2**、Node **26.10.0** 和 Chromium；`npm run dev:link` 将 `spaces-dev` 的实际目录链接安装到仓库根目录。没有等待侧栏运行态或 generation 同步的保护步骤，没有网络响应替换或模型调用。

| 步骤 | 结果 |
| --- | --- |
| 初始化、创建 | 浏览器按钮初始化唯一 `spaces-hub`，创建 `space-coding`，初始 stopped；只装轻量 view-bridge。manager PID 64056、Supervisor PID 39464。 |
| 首次启动与快速选择 | 点击“进入空间”，启动 succeeded 后立即双击宿主侧栏，真实原生 DSH 页面显示。空间 PID 44912、generation 1。 |
| 重启后立即选择 | 设置→空间→重启→确认。后端完成观测与选择记录相差 4 ms（不代表实际点击延迟）；当时宿主缓存仍是 **starting / generation 3**，随即双击成功显示新原生页。空间 PID 44912→36200、generation 1→3，旧进程退出；manager、Supervisor、serviceEpoch、注册 createdAt 不变。 |
| 重建、宿主重开 | 关闭普通入口宿主后构建，再启动进入同一工作台和空间。同一 manager、同一空间进程和 serviceEpoch；链接保留，所核对构建产物字节不变，没有重装入口插件。 |
| 正常停机 | `service.shutdown` 持久化作业 `5748d6ad-a058-4837-89f9-8b3777051301` 为 succeeded，manager、空间和 Supervisor 退出。独立只读检查确认 4564 / 3133 / 3132 / 7444 / 13888 无监听，本轮 PID / Home 无遗留 Node 进程。 |

`run-1/result.json`、`messages.ndjson`、各阶段截图/ARIA/state、冻结驱动保留完整证据；`07-restarted.png` 与 `08-host-reopened.png` 已人工查看，真实 DSH 页面可见。`cleanup-audit.json` 为独立停机核对；`final-summary.json` 汇总检查与失败边界。生命周期期间六个修改源码/测试文件的 SHA-256 未变。

初始化前记录普通宿主的 sessions/storages 目录及哈希，Spaces 操作未改变基线；普通宿主重开后另取基线再核对进入 Spaces。未创建 `profiles/web`，未访问真实 `~/.dsh`。停止服务时出现预期的 HTTP/SSE 中断，判断成功依赖持久化作业、进程和端口；页面异常、HTTP 错误响应及支持层 RPC 错误均为空。此结论覆盖官方 Web 软链接调试，不代替安装版 Desktop 验收，也不声称重启过程无空白间隙。

### 规定检查与保留失败

清单、最终三组类型检查、构建和包预检通过。八组规定测试合计 **1,590 通过、1 失败、7 条件跳过**；额外浏览器 **11/11**。

唯一失败组为 `test:workbench:recovery`：首次在 `maintenance-responsiveness.test.ts` 的大目录发布用例中，`RuntimeStore.installOnce` 单次异步 rename 报 Windows `EPERM`（30/31）；新的隔离临时目录复验时，另一运行时安装用例同一 rename 位置也报 `EPERM`（30/31）。本次没有改动该运行时安装路径，也没有加重试或覆盖失败；根因未判定。完整日志为 `check-test-workbench-recovery.log` 与 `fresh-test-workbench-recovery.log`，不能将软链接 UI 通过写成全部测试通过。

原有未提交工作保留；没有提交、推送、发布或写入记忆。

## 追加：维护 EPERM 根因与完整检查结项

2026-10-20 后续已通过管理员级文件跟踪确认上述 EPERM 的根因：仓库内临时 staging 的后代被当前 Codex 应用并发打开，阻止 Windows 整目录改名。检查入口改用并验证仓库外临时目录，没有修改运行时单次发布或增加重试；普通用户外部目录对照 32/32 通过。经另行授权的管理员完整轮 15 项全部通过，规定八组 **1,601 通过 / 0 失败 / 0 跳过**，额外浏览器 11/11、包预检通过。上节数字是修复前历史结果，失败现场保留。详细系统事件、对照、权限边界与最终日志见[根因与验收记录](runtime-eperm-20261020.md)。本次检查没有替代或扩大前述真实软链接 UI 验收范围。
