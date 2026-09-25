# 本空间看板与共享视图：第二批施工记录

日期：2026-09-25。实现 PR：[#12](https://github.com/klarkxy/dsh-spaces/pull/12)，依赖核心 PR #11 和设计 PR #10。唯一活动进度仍在 [tasks/todo.md](../../tasks/todo.md)。本记录提供证据和边界，不建立第二份活动任务账本。

验证代码提交：`2ee3160dcaf0ac06f82533b046fbca941c530b9d`。本批代码没有替换现有默认聊天首页，没有改变主分支、运行时版本、锁文件、组件清单、蓝图格式或用户 Home。尚未发布或交付可安装的独立插件包。

## 1. 实现增量

### 当前 Host 的完整查询与写入服务

[`LocalDashboard`](../../src/core/domain/dashboard/local-backend.ts) 将上批纯 reducer 装配成可运行的本空间服务，提供 overview、catalog、instances、board、receipt 和逻辑 navigation。local 模式拒绝 publications 管理；无法通过请求中的 spaceId 越过当前 Host。

store 是必需端口，没有静默的内存持久化替代。首次读取明确区分“尚无记录”和“读失败/记录损坏”。布局、请求回执和本地 provider 快照作为同一文档串行提交；写入完成之前不返回成功，提交异常后服务进入存储失败终态，不把旧缓存当作当前权威状态。跨进程所有权仍由宿主的现有 profile/运行权机制负责，本服务不是第二个锁管理器。

目录分页使用有界的短期 opaque cursor，绑定主体、筛选、页大小和当前目录 revision。业务进度值更新不使目录游标失效；标题、类型、实例组成或来源状态变化会失效。授权在入队前、执行阶段和异步结果返回前复查。

布局 revision 不被进度快照推进。旧运行实例的缓存始终按 stale/unknown 展示，即使同名 provider 已在新运行实例登记，也须等它实际发布后才能显示为当前来源。移除固定位置不删除业务实例；正常 provider 卸载也不删除源业务文件。

### 官方 domain 存储适配

[`domain-store.ts`](../../packages/dashboard/src/host/domain-store.ts) 使用官方 DomainFacility 的 `open` / `global.get` / `global.set` / `close` 语义。域名为 **`dsh_dashboard_local`**，version=1、single 布局、无表、一个严格校验且不接受 null 的 global。

此适配不启用 per-record、backup-and-skip、版本迁移或存储切换。官方显式 open 初始化空目录是正常初始化；从这个初始化边界开始，readonly overview/board 不产生记录文件，不写入默认看板。首次明确发布/布局变更才写入文档。

### 共享界面

[`DashboardApp` / `DashboardView`](../../packages/dashboard/src/view.tsx) 与 [`model.ts`](../../packages/dashboard/src/model.ts) 不依赖 Electron，接受宿主提供的认证 backend。提供组件目录、固定/移除、位置与尺寸编辑、已有看板选择、来源状态、更新时间和窄屏布局。

四类内置 renderer 不接受生成脚本。Markdown 当前作为纯文本显示，不请求外部资源或激活链接。来源打开仍是宿主能力，必须经 navigation 检查，不把 opaque ID 当作路径或 URL。

每一读取帧验证协议和一致的 backendEpoch，实例查询拆成不超过 50 个引用的批次，重复引用只读一次。正常读取成功后继续轮询；失败终止，不用刷新数据作为重新执行命令的借口。读和写的 401/403 都立即清除来源内容；布局回执有本地写版本栅栏，防止先发出的旧轮询覆盖新布局。超时写入显示结果未确认，不自动重发。

## 2. 实际验证

[Dashboard local run 36080088285](https://github.com/klarkxy/dsh-spaces/actions/runs/36080088285) 对代码提交 `2ee3160...` 的两个 job 均成功；[Dashboard core run 36080088333](https://github.com/klarkxy/dsh-spaces/actions/runs/36080088333) 也成功。

| 检查 | 结果 | 证据含义 |
| --- | --- | --- |
| 上批核心测试 | 52/52，通过 | JSON、投影、布局、发布/读取状态机回归 |
| 本地服务测试 | 18/18，通过 | 实际 LocalDashboard，内存 store fixture，两个客户端并发、分页、认证、提交失败 |
| 生命周期补充 | 2/2，通过 | 最大合法 epoch ID、旧快照不会被新登记伪装为 live |
| 视图和 frame 测试 | 10/10，通过 | SSR 安全输出、真实服务查询装配、位置命令、引用/epoch/abort 校验 |
| 官方 SDK / 实际磁盘 | 9/9，通过 | 实际 Cordis 与官方存储 facility/backend、写入后重新打开、损坏/重复/版本/无记录写入边界 |
| Strict TypeScript | 通过 | 核心、共享视图、本地后端和测试类型检查 |
| Chromium 多步骤交互 | 通过 | 真实浏览器操作，但使用合成业务数据和浏览器内存 store，不是原生 DSH 安装 |

共 **91 项 Node 测试**，不含重复运行的同一批核心测试；另有一条 Chromium 多步骤流程。测试环境为 GitHub Actions Ubuntu、Node **24.21.0**；本轮不是在此前无法联网的本地 Node 22 环境运行。

Chromium 流程覆盖：首次打开不隐式创建看板；固定写作进度、清单和笔记；来源更新后数值变化；调整位置；390px 窄屏无横向溢出；移除固定但保留源实例；原始脚本和链接不成为 DOM 能力；读、写权限失效立即清屏并停止轮询；拒绝写入不重发。流程要求无 pageerror、无非本地网络请求。

该 run 的 `dashboard-browser-evidence` artifact 保存 `desktop.png` 和 `narrow.png`，保留期七天。截图是**合成数据的共享界面测试截图**，不是产品默认首页或原生 DSH / Electron 的完成证据。

官方磁盘测试在 `.sandbox/dashboard-storage-*` 的独占临时目录进行：实际保存的文件同时包含布局、回执与 provider 记录；关闭并重新打开后可读，旧 run 结果标 stale。损坏 JSON、合法 envelope 中非法业务记录和不兼容版本均拒绝并保留原字节。重复打开同一 facility 域拒绝。没有执行断电/fsync 验收、跨进程锁攻击或 Windows ACL 测试。

## 3. 精确 SDK 发现

本轮在隔离 CI 中安装了固定 CLI **`@deepseek-ai/dsh@0.1.7-alpha.1`**。因此“本地 DNS EAI_AGAIN 无法取得 SDK”不再阻断这组验证，旧记录保留为先前阶段事实。

但固定 CLI 版本不意味着所有传递依赖都有相同版本。本次实际解析到：

| 包 | 实际版本 |
| --- | --- |
| `@deepseek-ai/cordis` | `4.0.4` |
| `@deepseek-ai/dsh-storage` / `dsh-storage-json` / `dsh-storage-domain` | `0.1.7-rc.2` |
| `@deepseek-ai/dsh-fs` / `dsh-home-paths` / `dsh-atomic-write` / `dsh-host-webserver` | `0.1.7-rc.2` |

项目原锁文件没有因此改变。不能把这组结果写成“项目锁定的全部 alpha SDK 已验收”，也不能把上游 master 的接口当作该安装版本。`probe-dashboard-sdk.mjs` 输出解析后的身份，SDK 测试通过该安装目录解析模块，避免混用不同 Cordis 实例。

正常 domain open 实测会创建空目录，而不会写入默认 global。测试据此区分初始化和 readonly query；没有为了通过测试增加回退，也没有把首次错误当作 SDK 不兼容。实际 storage unit 名称必须是小写字母/数字/下划线，源码已改为 `dsh_dashboard_local`，并保持故障测试使用合法域名以到达真正的数据错误。

## 4. 仍未完成的产品边界

**P0 仅部分通过，P1 也不是完整可安装插件。** 已落实实际 SDK 存储及可选服务探针、本地 backend、共享视图与各自测试；原生 DSH 认证/代理、共享 React loader、真实插件上下文身份绑定、正常 profile 安装入口和卸载仍需接线与实测。

尚未实现：Home 聚合的持久化与权限服务、各空间的真实后台发布通道、默认预装 provider、组件清单过渡、主工作台首页路由替换、多空间双端真实流程、业务插件真实接入、公开包发布。没有为了显示 UI 而把测试 fixture 装进现有首页。

界面当前采用位置表单，不宣称拖拽已完成；目录只显示前 100 个组件，完整分页 UI 未接；Markdown 为纯文本；中文文案尚未完成双语集成。

## 5. 仓库级 CI 限制

在本批之前的核心提交 `9865a088...`，主 CI run **36040006653** 的 Windows workbench job 有 **10 项失败**：9 项位于工作台升级包处理，主要错误 `tarball entry could not be read`，另有一项升级交接断言失败。Dashboard core 和 Desktop startup regression 当时通过。

因此看板专项绿色不表示仓库全量 CI 绿色，也没有证明上述问题是 main 上原有问题。本批未修改这些升级实现、未跳过其测试；后续合并门槛必须单独处理和核对仓库级回归。

## 6. 复现

先使用项目要求的 Node 24，在隔离工作目录安装锁定依赖。以下命令只运行测试，不改变实际 DSH Home：

```sh
npm ci --ignore-scripts --no-audit --no-fund
node scripts/test-dashboard-core.mjs
npx --no-install tsc -p tsconfig.dashboard-ui.json
node --import tsx --test tests/dashboard-local.test.ts tests/dashboard-lifetime.test.ts tests/dashboard-view.test.tsx
npx --no-install playwright install --with-deps chromium
node scripts/test-dashboard-browser.mjs
npm install --prefix .sandbox/dashboard-sdk --ignore-scripts --no-audit --no-fund --fetch-retries=0 @deepseek-ai/dsh@0.1.7-alpha.1
DSH_DASHBOARD_SDK_ROOT=.sandbox/dashboard-sdk node scripts/probe-dashboard-sdk.mjs
DSH_DASHBOARD_SDK_ROOT=.sandbox/dashboard-sdk node --import tsx --test tests/dashboard-sdk.test.ts
```

上面环境变量语法为 POSIX shell。Windows 应设置同名进程环境变量；不把 Linux 上的实际通过记录延伸成 Windows SDK / 浏览器已通过。
