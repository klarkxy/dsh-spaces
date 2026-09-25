# Supervisor 接线：第五批施工

日期：2026-09-25。PR [#15](https://github.com/klarkxy/dsh-spaces/pull/15)，依赖 #14 → #13 → #12 → #11 → #10。运行代码：`559cd0641a92443d088f25bb0e56837bcfe4ac32`。唯一活动账本：[tasks/todo.md](../../tasks/todo.md)。

本批把 Home 看板接入**实际 WorkbenchSupervisorRuntime** 的运行权、认证、管理计划和空间生命周期。没有创建第二个管理器、监听端口或独立授权执行通道。尚未合并 main、发布版本或改动用户真实 Home；默认首页和授权界面仍待施工。

## 1. 装配与运行权

`src/adapters/node/dashboard/supervisor.ts` 是现有 Supervisor 拥有的组合模块。Supervisor 正常取得 HomeController 运行权后才创建它，绑定当前 serviceEpoch、现有端口、现有会话 Cookie、受管理空间清单与 generation。读写前检查磁盘上的真实 owner 身份、存活状态和交接状态，不能只凭缓存的 handle 继续持有权限。

公开与内部 Dashboard 路由挂在 `workbench-http.ts` 已有监听器上。浏览器只有 Supervisor 自身的有效 operator Cookie 才能进入；Host bearer、子空间 Cookie 和发布 bearer 都不是替代登录方式。布局和授权能力还受现有维护状态与 Home mutation lock 限制。

Windows 当前不装配 POSIX Home 文件适配，Dashboard 请求明确返回 unsupported。既有 Windows 工作台路径不因此被强制套用 chmod。Windows ACL、其它平台和嵌入式启动方式仍须独立实现与验收。

## 2. 授权进入现有计划体系

`WorkbenchPlanRequest` 新增 `dashboard.publication.set`。它使用既有 `preview`、持久化计划、`plan.execute`、任务状态与 HomeOperationLock，不增加一个直接修改授权的 Dashboard HTTP 入口。

预览与执行均检查当前 Home 运行权、serviceEpoch/管理 revision、来源是否受管理、根 web/管理空间保护、维护和未归属进程状态。计划指纹包含来源 generation。实际提交授权前再次检查这些条件，并由 HomeDashboard 校验 expectedGrantRevision。相同旧授权预览出的两个计划不会同时提交成功；过期、旧代次、旧 epoch 与已消费计划都拒绝。

授权计划只改变发布策略，不安装插件、不启动/重启来源，也不执行业务任务。扩权在下一次正常启动取得新 grant 时生效；撤权立即阻断该来源的旧展示内容，不为了清理看板而杀掉来源进程。

## 3. 真实空间生命周期

普通空间正常启动时，只有 package 声明与 bundle 列表均包含 `@dsh-spaces/dashboard`，且存在启用的发布授权，才签发该 generation 独有的 run 与私有交接文件。没有安装看板插件的空间保持原启动路径，不自动补装。管理 profile 不获得发布凭据。

私有文件路径只进入对应子进程的环境变量。底层 toolchainEnv 会再次合并父进程环境，因此无授权来源返回一个显式 undefined 字段遮蔽旧路径；单纯 delete 会使父进程路径重新出现。新增了投毒父环境的测试，确认管理器和普通无授权空间不会读取外来交接文件。

正常停止先同步废止 run，然后清理本次交接文件，再请求进程停止。已观察到的子进程退出也立即撤销对应 generation，不等待心跳过期。失败启动只废止本次新签发的凭据，不重放启动。旧进程的迟到退出事件不得废止后来 generation 的 run。

空间删除在原有删除计划内先撤销该来源全部发布策略，再执行停止和 profile/数据删除。中途出错保持真实失败，不回滚旧授权。Supervisor 正常关闭、释放运行权和组件交接时关闭看板通道；不接管旧子进程，也不把失败通道重新登记。

## 4. 验证与边界

最终源码的 Node 24 验证见 [Dashboard Supervisor run 36101272269](https://github.com/klarkxy/dsh-spaces/actions/runs/36101272269)。`supervisor` 与 `native` 两个 job 均通过：141 项 Node 检查、严格类型检查、完整 Spaces/独立看板构建和原生双 Host 流程。该工作流直接检查提交源码，不再应用临时补丁；只保留 contents:read 权限。

本地 Linux Node 22.16.0 已通过 52 项核心、76 项 Home/本地/视图/HTTP 回归和 13 项新增 Supervisor 接线测试，共 141 项；node/web/dashboard 严格类型检查通过。本地结果不是 Node 24 或其它平台结果的替代。CI 环境为 Ubuntu 24.04 / Node 24.21.0。新增测试使用真实 Supervisor、网络、任务与计划流程，但 CLI 和子进程使用明确标注的受控 fixture。

新增 13 项覆盖：真实会话与 bearer 区别、预览不落授权/不启动进程、计划单次执行、受保护来源、grant CAS、逐空间私有文件、停止前撤权、进程退出撤权、失败启动清理、在线撤权不重启、删除前全量撤权、旧代次/过期/维护/外部锁拒绝，以及父环境凭据隔离。

另一条 `scripts/test-dashboard-supervisor-native.mjs` 使用**真实 Supervisor 和两个实际安装插件的 DSH Host**。没有模拟 Home 拥有者、计划检查、认证或 processRuntime。测试通过真实 HTTP 执行授权预览/确认、启动、布局保存、停止、撤销和删除，并检查正常关闭后的运行权释放、私有文件清空与根 web/session/storage 指纹。

已下载读回该 run 的 `dashboard-supervisor-native-evidence`（artifact ID `10849119851`）：result.json 为 passed，六项记录分别对应实际运行权/认证、授权不启动来源、两个实际受管 Host 汇总、停止立即撤权、授权与删除计划、正常关闭清理与根数据保护。

原生来源中的业务内容仍是测试专用合成插件，不是用户数据；没有模型调用。本次验证后台和管理链路，没有生成首页截图，也不能据此宣称跨空间首页 UI、Electron 安装包或所有原生工作区功能已验收。

仓库级 CI、组件升级和桌面回归是独立门槛。本批不跳过旧测试，不把看板专项成功写成全仓库绿色；最终状态以对应提交的 Actions 为准。

## 5. 发布与平台尚未完成

剩余：授权管理 UI、Home 默认首页路由、默认预装和组件清单版本过渡、真实业务插件接入、Windows ACL、完整跨平台/跨端产品验收。当前没有将看板包静默写入任何旧空间，现有五组件清单和根依赖/锁文件保持不变。

独立 dashboard 插件继续可以只服务当前 Host；跨空间能力依赖 Supervisor 提供的可选发布授权与私有启动上下文，不依赖 Electron。公开管理协议仍为 v2，看板协议仍为 v1，本次仅增加计划类型，不改旧请求含义。

## 6. 复现

在隔离工作目录使用 Node 24：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npx --no-install tsc --noEmit -p tsconfig.node.json
npx --no-install tsc --noEmit -p tsconfig.web.json
npx --no-install tsc -p tsconfig.dashboard-ui.json
node scripts/test-dashboard-core.mjs
node --import tsx --test tests/dashboard-home.test.ts tests/dashboard-home-node.test.ts tests/dashboard-home-gateway.test.ts tests/dashboard-local.test.ts tests/dashboard-lifetime.test.ts tests/dashboard-view.test.tsx tests/dashboard-http.test.ts
node --import tsx --test tests/dashboard-supervisor.test.ts
npm install --prefix .sandbox/dashboard-sdk --ignore-scripts --no-audit --no-fund --fetch-retries=0 @deepseek-ai/dsh@0.1.7-alpha.1 pnpm@10.15.0
node scripts/build-spaces.mjs && node scripts/build-dashboard-plugin.mjs
DSH_DASHBOARD_SDK_ROOT=.sandbox/dashboard-sdk node --import tsx scripts/test-dashboard-supervisor-native.mjs
```

环境变量语法为 POSIX shell。脚本自己建立 `.sandbox/dashboard-supervisor-native-*`，不要求提供真实 Home 或 API Key。来源插件、临时 Home 和认证材料不进入正式包或公开证据附件。
