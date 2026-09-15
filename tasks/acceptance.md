> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。
# Codex 独立验收矩阵

## 2026-09-11 最终修复验收

当前版本为 0.2.0：179 项回归通过，真实版本安装、跨版本升级及分段回退复测、最终 Windows 安装后的新版页面和损坏运行时恢复通过。详细证据、失败重试及平台限制见 [本次修复验收](fix-acceptance-2026-09-11.md)。下面的阻塞和产物记录保留为历史，不能替代本次最终结果。

## 2026-09-09 续接：执行环境阻塞，未新增通过项

- 本次 `npm run typecheck` 和 `git diff --check` 通过。下面 9 月 8 日的 135/135 结果是历史证据，不代表今天重跑成功。
- 官方候选安装脚本在目录查询时报 `failed to fetch @deepseek-ai/dsh metadata: fetch failed`；临时根目录为 `spaces-runtime-install-Pl7Upg`，未进入安装，也没有新候选或版本切换。
- 沙箱外安装验收申请两次被自动审批拒绝，原因为审批服务 `stream disconnected before completion`。第二次申请已附临时目录和 npm `--prefix` 范围证据。未绕过拒绝；已请求用户批准临时目录验收，回复待定。
- 最终包界面复测使用新 Home `spaces-real-config-GjoUqs`：真实 DSH 配置预检通过；Playwright 已连接主进程调试端点，但 `electron.launch` 仍在 120 秒超时。清理输出明确包含 `taskkill ... ERROR: Access denied`。不能据此声称最终界面通过，也不能在正常进程环境复核前认定为产品回归。
- `npm test` 重跑出现多项子进程停止/退出测试失败，后续不能正常结束，已中止；本次没有完整测试总数和通过结论。未放宽产品的停止判据或测试断言。上述超时界面测试留下的两个打包程序进程已按可执行文件路径、启动时间和 PID 核对后停止。
- 安装器模板确认当前为默认 one-click 安装，完成后通常会启动应用；安装还会写卸载注册项和快捷方式。本次没有运行安装器，不以解压程序或静默安装冒充安装流程验收。
- 新增 `tasks/real-upgrade-check.mjs`，使用真实 RuntimeStore、CoordinatedUpgrade、SnapshotStore 和 ProcessManager，要求候选版本不同于基线；计划验证三空间会话在升级及恢复前后的保留与隔离、patch 字节保留、升级后保持停止、恢复前备份和最终端口关闭。脚本语法检查通过，真实流程未运行；尚不覆盖真实第三方插件或 Electron 升级交互验收。
- `tasks/real-runtime-install.mjs` 新增 `DSH_TEST_RUNTIME_VERSION` 指定候选版本，成功后记录安装源供跨版本脚本使用。两个脚本必须依次成功，不能用同版本安装替代跨版本验收。

## 2026-09-08 续接验收证据

- `npm test`：135/135 通过，0 跳过；`npm run typecheck` 通过。`git diff --check` 通过（仅行尾转换提示）。
- `node --import tsx tasks/real-lifecycle-check.mjs`：真实 DSH 0.1.1-rc.2 三空间并发启动、不同端口、会话互相不可见；重启 coding 后原会话仍在且其他空间可用；错误隔离路径拒绝启动；stopAll 取消待启动操作；结束后所有所属 API 端口关闭。独立 Home：`spaces-real-config-KtjHua`，位于系统临时目录。
- `node --import tsx tasks/real-diagnostics-check.mjs`：配置预览、恢复、真实 dump-config 校验、无效备份原样回滚、日志脱敏通过。独立 Home：`spaces-real-config-wFRImK`。
- Electron 开发构建：已实际通过三空间启动与会话隔离、关闭进入托盘、第二实例退出并唤回原窗口，且 webContents ID 和选中空间不变；诊断入口和日志界面可用。真实依赖快照创建、恢复确认、恢复前备份、凭据保留、恢复后指向快照运行时均通过。
- 恢复最终验收分段完成：完整脚本最后取端口时遇到测试等待竞态，已改为读取同一份就绪记录；随后 `restored-start-check.mjs` 直接启动恢复环境并读回原测试会话，`restored-electron-check.mjs` 重开同一临时应用、从界面启动 coding、读回相同会话、显式退出并检查端口关闭，全部通过。临时 Home：`spaces-real-config-wzIoOO`，应用目录：`spaces-electron-check-Z0VB6D`，会话：`session-7b369690-b1e3-411e-85af-f496edfa8ced`。测试会话未调用模型；不声称验证过真实模型生成内容。
- `node --import tsx tasks/packaged-acceptance.mjs`：Windows `win-unpacked` 程序实际启动；确认 `app.isPackaged`、独立 Home、preload、快照 worker 加载、真实 DSH 启动、版本恢复界面及设置页 Quit 退出均通过。测试目录：`spaces-packaged-check-yjOVwR`。这不等于安装向导验收。
- 已检查本轮 `tasks/artifacts/diagnostics.png` 和 `packaged-app.png`，界面内容可读，无裁切。旧截图不能作为本轮恢复通过证据。
- 自动化环境：30 秒 Electron 调试连接上限曾超时，且后台窗口动画使点击稳定性检查停滞；验收脚本使用 120 秒启动上限及仅测试进程的后台节流禁用参数，未修改产品的安全或窗口运行选项。
- 联网版本安装：官方目录查询成功（16 个版本），下载依赖反复出现 TLS `ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC`，10 分钟后有界超时。仅测试进程采用 TLS 1.2 的第二次尝试仍出现 TLS/ECONNRESET 错误并超时；两次临时安装目录均已由失败清理流程清空，未发布候选或改变当前版本。真实候选安装及跨版本协调升级尚不能标为通过；单元测试覆盖不能替代该证据。
- 来源显示修复前曾生成 `release/acceptance/DSH Spaces Setup 0.1.0.exe`；该文件不作为最终交付。修复后最终安装包为 `release/DSH-Spaces-Acceptance-0.1.0.exe`，SHA-256 `8049A6EFA8D3A3FFBE83323D50E935E05BDF0FB490E72922668B32299458DAB4`。未执行安装向导，不把生成安装包等同实际安装通过。
- 最终包的 Playwright 界面复测在调试连接阶段达到 120 秒超时；修复前打包界面通过、修复后开发构建界面通过的证据不能冒充这次最终包界面复测成功。
- 最终包的独立启动证据：`node --import tsx tasks/packaged-smoke.mjs` 使用新临时 Home，实际启动 `release/win-unpacked/DSH Spaces.exe`，输出 `SMOKE A3`、`SMOKE A9`、`SMOKE: PASS`，退出码 0；三个真实空间 API 可用，重启 coding 保持其余空间不变并全停退出。测试目录 `spaces-packaged-smoke-6IEeqs`。该检查不依赖 Playwright 调试连接，也不替代界面复测或安装向导。
- 续接发现并修复：恢复运行时的来源曾显示 `system`，现增加 `snapshot` 来源与中英文说明，并兼容旧指针。`tests/runtime-store.test.ts` 14/14 通过，新增测试覆盖快照目录识别及相似目录不误判；修复后类型检查、最终构建及 Electron 恢复环境重开验收通过，实际 IPC 来源为 `snapshot`。
- macOS/Linux、真实模型调用均未验收。所有测试均使用临时 Home，未使用真实用户 Home 或现有 `.sandbox`。

基线提交：307dd6cfcb52970b414f0560095432dd23d35f85。
派发前工作树干净；tasks/ 下计划材料由协调者添加。

## 必须检验的用户行为

| 领域 | 场景 | 通过条件 |
| --- | --- | --- |
| 配置 | !!js、注释、自定义字段、重复应用 | 无表达式执行、无用户字段丢失、无重复隔离 row |
| 隔离 | 缺 row、root 在后续 row、近似路径、恢复旧备份 | 不误判通过；失败恢复操作前配置；web 隔离 patch 不变 |
| 并发 | 同空间连续启动/停止/重启，多空间同时启动 | 无重复实例和端口碰撞；停止后无所属进程残留 |
| 单实例 | 第二次打开应用 | 唤回原窗口，不启动第二个管理器 |
| 诊断 | spawn 失败、提前退出、API 超时、插件失败 | 原因可区分、界面有恢复入口、日志有界且脱敏 |
| 托盘 | 关闭、恢复、退出、无托盘 | 关闭后继续运行；恢复同一视图与选择；退出全停；无托盘不失联 |
| 升级 | 下载/安装/快照/校验/提交失败 | 不把失败显示为成功，旧版本可恢复 |
| 升级 | 存在运行中空间和插件操作 | 不并发修改；维护态同时约束 IPC 与 UI |
| 升级 | 正常协调升级 | 基础插件匹配，第三方版本/顺序/patch 保留，成功后不自动运行任务 |
| 快照 | 新版新增聊天后恢复旧快照 | 旧环境/聊天恢复，新增状态可从恢复前快照找回，凭据与外部源码不被覆盖 |
| 快照 | 断网、空间不足、复制失败、中断 | 断网能恢复完整依赖；失败不损坏当前数据；下次启动先恢复检查 |
| 边界 | 越界标识、快照所属 Home 不匹配、目录链接 | 不读写范围外目标，不把其他 Home 的快照误恢复到当前 Home |

## 证据规则

- 查看 git diff 和所有新增文件，不能只读施工总结。
- 自行执行适用测试，记录实际命令、结果和限制。
- 不能用 mock 测试替代真实 Electron/DSH 流程。
- smoke 必须使用新的临时 Home，不清理当前 .sandbox 或真实用户数据。
- 缺少 macOS/Linux 环境时明确未验收，不把交叉构建当作平台通过。
- 核查恢复路径的完整性、权限和依赖链接，不以文件数量断言替代可启动验证。
- 不需要真实 API Key 的检查不调用模型；不自动上传日志或反馈。

## 施工约束

首批完整范围见 plan.md；不要实现后续路线。优先复用现有接口和队列，不引入新后台服务、通用插件框架或无消费者的基础设施。Git、最终验收及发布由协调者负责。
