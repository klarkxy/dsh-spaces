# Desktop 首次后台启动

日期：2026-11-02。本任务包含原始错误保留与只读状态、宿主/Home 后台启动、界面与回归。三批实现和独立回归已完成。完整检查首轮 12/14 组通过，两组打包失败使用独立缓存复查通过。最终构建已在官方 Desktop 的开发链接和发行包两条路径实测；后台启动、复用、停止、手动启动、子空间保持停止和受控故障显示通过，但前两次首次打开管理页面超时仍未查明，整体验收不能标记为全绿。早期独立证据见 `.sandbox/desktop-autostart-20261101/ACCEPTANCE-MATRIX.md`。

## 实现边界

官方 Desktop 打开应用时，宿主按当前 Home 在后台初始化并启动管理服务，主界面保留。宿主进程保存该次终态；界面刷新只是重新加入同一记录。失败或正常停止不自动重启，也不自动启动子空间。正常再次打开应用是一份新启动。已有的确认式手动服务入口建立一份新操作。

设置和新建只保留最后一次导航意图，回到主空间取消跳转。原始错误、随后的停止结果、进程记录是否保留分开显示并脱敏。健康的旧服务可以连接。缺少启动观察接口是明确的兼容失败，不能据此断定服务没有启动。普通 Web 仍是用户点击的一次初始化。没有增加自动恢复。

集成收尾未改生产代码，先前两阶段实现已接受。

## 本叶改动

- `tests/native/native-desktop-startup.test.ts`：epoch/manager 变体保持 operationId `first-operation`，只改被测字段。手动重启的新记录是 `launch-two` 和新的 service epoch，目录与之匹配，旧 controller 保持 failed。stopped 增加第二个 controller，确认没有 directory、portal、initialize、child。终态和首次目录拆成独立测试，每个测试一份 harness。
- `tests/fixtures/portable-host/native-startup.tsx`：补 ready 启动记录，epoch 为 `aa` 重复 32 次，manager 为 hub。原有 spaceAction、失败原因、手动取消/确认和主空间 DOM 路径保留。
- `tests/ui/portable-host-dom.test.ts`：注册失败的详情精确文本为“失败原因”加换行加完整 `MAIN_REGISTRATION_REFUSED:404`。
- `tests/fixtures/portable-host/native-background-startup.tsx` 与 `tests/ui/native-background-startup-dom.test.ts`：生产 React shell 和 controller，受控 host 状态，headless Chromium。覆盖 zh/en 成功/失败的主输入身份、文字、焦点和非 inert，阶段提示的可访问名称和 72px rail，点击后才显示三类失败，create→settings、settings→create、create→Main，以及 stopped 记录的重复挂载。测试说明该夹具不证明真实宿主去重。
- `package.json`：新 DOM 测试只加入 `test:workbench:browser`，原列表保留。
- 现行文档：`README.md`、`docs/architecture.md`、`docs/workbench.md`、`docs/plugin-standard-install.md`、`docs/host/embedding.md`、`docs/workbench-api-surface.md`、`packages/plugin/README.md`。Guide 的 `beginDesktopLaunch` 和 `desktopLaunchState` 不带参数；已认证只读 `startupStatus` 不改变 canonical `state`。

## 本叶检查

日志在 `.sandbox/desktop-autostart-20261101/phase3/`。临时目录只用于这些进程，为 `H:/Code/dsh-spaces-checktmp`。

| 命令 | 结果 |
| --- | --- |
| `node --import tsx --test tests/native/native-desktop-startup.test.ts` | 19/19，退出码 0。`native-startup-split.log` |
| 两份 DOM 首次并行 | 12 项里 11 通过、1 失败。`native-dom-first.log`。失败是既有 stale rail 测试等待嵌套 iframe 的 Space draft，Playwright 动作超时 30 秒。该测试使用 `client.tsx`，不是本叶的启动夹具 |
| 单独重跑 stale rail | 1/1，退出码 0。`native-dom-stale-isolated.log` |
| 两份 DOM，`--test-concurrency=1` | 12/12，退出码 0。`native-dom-rerun.log` |
| `npm run typecheck:tests` | 退出码 0。`typecheck-tests-closeout.log` |
| `npm run check:test-lists` | 119 个引用全部解析，退出码 0。`check-test-lists-closeout.log` |

## 集成完整检查

根代理日志：`.sandbox/desktop-autostart-20261101/checks-final-1/`。使用仓库外临时目录与隔离 Home，支持的 Node 26.10.0 执行。没有在真实 Desktop 验收期间修改生产代码或重建产物。

| 检查 | 首轮结果 |
| --- | --- |
| 测试清单、三套类型检查、完整构建 | 全部通过 |
| 基础、spaces、workbench、recovery | 通过；分别 287、149（1 跳过）、699（2 跳过）、31 项通过 |
| blueprints、browser、workbench:browser | 通过；blueprints 221（4 跳过），Chromium 23 项通过 |
| `test:llm`、`check:plugin-package` | 打包步骤失败；其中 LLM 日志明确为共享 npm 缓存冲突 |

只复查两组失败项，使用本次验收专用缓存，未清理共享缓存：`checks-pack-isolated/result.json` 记录 LLM 131 项与包预检均通过。保留首轮失败，不改写为一次 14/14 的完整通过。

## 最终构建的真实 Desktop 验收

全部使用官方已安装程序 **Desktop 0.2.1-rc.2 / Electron 44.7.0 / Node 24.21.0**，只替换进程的隔离 Home、工具目录、缓存和用户数据目录。没有复制日常凭据；测试模型目录使用无监听的本机占位端点，没有发起模型请求。开发链接及发行包实际加载的 `client.js`、`index.js`、Supervisor 和 manifest 均与最终仓库构建摘要一致。官方 EXE 与 `app.asar` 前后摘要一致。

实测目录前缀为 `H:/Code/dsh-spaces-checktmp/desktop-autostart-20261101/`：

| 代号 | 目录 |
| --- | --- |
| D | `dev-2026-11-02T00-58-55-189Z` |
| P | `pack-2026-11-02T01-02-36-835Z` |
| C | `pack-2026-11-02T01-34-35-639Z` |
| R | `dev-2026-11-02T01-47-09-461Z` |
| F | `dev-2026-11-02T01-54-08-210Z` |

| 场景 | 实际结果与主要证据 |
| --- | --- |
| 全新 Home 打开即后台启动 | D、P 都无需点击初始化，各启动一个 Supervisor、注册一次主模型，只有管理空间运行。`first-inspection.json` / `first-first-ready.json`、启动日志和截图 |
| 主界面可用与保留 | D、P 实际输入成功。首次导航失败后 D 的输入节点身份、内容和非 inert 状态保留；P 确认重启后原输入保留。`first-create-readiness-failure.json`、`first-main-input.json`、`first-manual-main-retained.json` |
| 健康服务复用 | D 正常退出 Desktop 后重新打开，仍为同一服务 PID、纪元和一次启动；新宿主注册一次，设置页实际打开成功。`attached-attached-settings-state.json` 及配套截图 |
| 预览并确认手动重启 | P 真实 UI 完成预览、确认。旧服务正常退出 0，新服务只启动一次、注册一次。`first-manual-restart-result.json` |
| 正常停止与同宿主重载 | P 经正常计划停止所有测试空间，作业 succeeded；实际重载 renderer 后端点仍不存在，启动/注册计数未增加。`first-normal-stop.json`、`first-stopped-remount.json` |
| 停止后的确认式手动启动 | P 已通过真实新建流程创建并运行 `space-startup-child`。停止后，真实 UI 确认只启动管理服务，子空间保持 stopped / generation 0；只增加一次启动和注册。`first-manual-start-from-stopped.json` 及截图 |
| 完全退出后的新启动 | P 正常停止、退出后重新打开，新的管理服务启动一次、注册一次，已有子空间仍 stopped / generation 0。`cold-reopen-cold-ready-final.json`、`cold-reopen-ready-child-stopped.png` |
| 受保护的存活所有者 | R 中存活的完整 desktop 租约阻止启动。主界面保留，点击设置后显示实际拒绝原因；重载后仍零 Supervisor 启动、零注册，租约由夹具最终释放。`refused-owner-refusal-after-reload.json`、`refused-owner-error-details.png` |
| 原始错误、停止失败、记录保留 | F 使用最终构建的真实 HTTP Supervisor 与内存中的故障管理子进程。真实 Desktop 分开显示三个字段，token/路径已脱敏。主输入可编辑且保持焦点；重载前后只有一次 spawn、一次正常 term 尝试，没有 initialize 或额外启动。`dual-failure-dual-ui-assertions.json`、`dual-failure-dual-error-details.png`、`dual-failure-main-after-failure.json`、`controlled-failure.json`。这不等同于无法终止的真实 OS 子进程实验 |

实际 Desktop 使用中文；启动期间的精确焦点/节点身份、中英文布局、快速连续点击顺序和迟到响应，另由实际生产 React 组件的受控 Chromium 与 Native 回归覆盖，不能冒称这些全部在真实宿主上完成。

### 尚未通过：首次管理页面导航

D、P 的第一次新建导航均未完成。D 明确报 `The manager view did not complete readiness before the deadline.`；P 的帧记录停在 `/view/spaces-hub/1` 的“正在进入工作空间…”页面，管理服务本身保持 ready，启动与注册次数均未增加，错误终态没有自动重试。

同一构建随后在 P 的确认式新服务和 D 的重新打开中成功进入设置/新建。第三个全新发行包 Home C 的第一次新建也成功：`timed-cold-network-trace.json` 从 guest 创建 `01:42:36.823Z` 到选择完成 `01:42:38.524Z` 约 1.7 秒，管理 iframe 的跳转未被宿主拒绝。记录没有证明前两次超时的根因，也没有证明它们已经修复。没有为通过验收修改导航权限、延长截止时间或添加重试。后续需要针对首次导航补充复现与定位；本项保持未通过。

### 收尾与范围

正常服务都通过 `service.shutdown` 计划停止，五次验收停机作业均 succeeded；故障夹具由其所有者显式结束。七次官方 Desktop 启动实例均正常退出 0，五个最终验收 Home 的端点均已释放。汇总校验见 `.sandbox/desktop-autostart-20261101/REAL-DESKTOP-RESULT.json`。保留所有 Home、失败记录、日志和测试空间，没有删除证据。双重错误夹具首轮因辅助脚本漏 await 状态接口而退出，使用新的 Home 修正后验证；未把夹具错误算作产品缺陷。

各 Home 均未出现 `profiles/web` 或默认 `sessions` / `storages`。未读写真实 `~/.dsh`，未改官方程序文件、SDK、全局设置或日常插件安装；未提交、推送或发布。原始用户截图中的实例没有被更新或宣称已修好。工作树相对任务开始前的精确清单见 `task-diff.json`，Git HEAD 保持 `c7f6fdeea7c5d1703d53ff980975351c5ab3c13d`。
