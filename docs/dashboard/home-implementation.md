# Home 聚合与后台发布：第四批施工

日期：2026-09-25。PR [#14](https://github.com/klarkxy/dsh-spaces/pull/14)，依赖 #13 → #12 → #11 → #10。代码提交：`d04e2437dd28b1bc12983d72a034852db544a478`。活动进度只记入 [tasks/todo.md](../../tasks/todo.md)。

**本批交付 Home 聚合实现、POSIX 存储/凭据适配、HTTP 路由适配器和原生插件发布端。生产 Supervisor 的管理计划与进程生命周期尚未挂载这些适配器；默认首页、预装和 Windows ACL 不在本批完成范围。** 不合并 main、不发布、不修改真实 Home。

## 1. 已实现的执行路径

`src/core/domain/dashboard/home-backend.ts` 提供 HomeDashboard。授权策略、看板布局/回执、各来源投影分开存储，在同一 Home 服务的有界串行队列下操作。空读取不创建文件或默认看板。来源与运行代次由拥有者端口给出，不信任网页或 publish body 自报身份。

`src/adapters/node/dashboard/file-store.ts` 为显式目录提供 POSIX 适配。文件名由固定名称或来源 ID 的哈希产生；检查目录、属主、权限、常规文件、硬链接和符号链接；同卷独占临时文件写入、文件 fsync、单次 rename、目录 fsync。失败不重试、不换存储、不回滚；无法证明 Windows ACL 时明确不支持。拥有者必须仍持有真实 Home 运行权，适配器没有另造一把跨进程 Home 锁。

`gateway.ts` 和 `internal-http.ts` 是路由适配器，**不会自己监听端口**。公开查询/布局接口继续使用 Dashboard v1；Node 发布端使用独立的 bearer 入口：读取当次 grant、提交完整快照和心跳。发布凭据不能冒充网页会话；内部接口拒绝 Origin、Cookie 和浏览器 fetch 标志。公开响应在聚合服务的权限临界区内发送，防止“结果已构造、尚未发出时撤权”的窗口。

`bootstrap.ts` 为一次正常启动创建私有交接文件。只有路径通过环境变量进入子进程，bearer 不进入 argv、浏览器或持久化布局。停止/退出时先撤销该 run，再清理本次文件；清理验证 inode/device 身份，不能顺便删除其它运行实例的文件。

`packages/dashboard/src/host/home-publisher.ts` 由原生插件读取显式 `DSH_SPACES_DASHBOARD_BOOTSTRAP_FILE`。变量不存在时仍为本空间模式，不扫描目录或发现全局服务；存在但非法时拒绝该接入，不偷偷忽略。发布端只发送授权实例及其引用的类型，通过有界队列公平安排首次发送，传输超时不包括排队等待。请求从确认后计间隔，避免延迟抖动触发服务端限速；失败不会重新排队、重新获取 grant 或补传。

本批只给 LocalDashboard 增加可选 `homePublisherFor` 装配端口，沿用现有本地提交与 Home 结果分离。没有配置 Home 时，原生独立插件保持此前行为。

## 2. 授权、离线和一致性

发布默认关闭。`applyPublication` 只能由真实管理计划执行路径调用，并要求提供重新检查计划权限/epoch/revision/generation 的回调；**没有向浏览器暴露直接改授权的旁路接口**。当前回调与拥有者端口的装配责任仍属于后续 Supervisor 集成，单元测试的显式 fixture 不能充当生产鉴权。

每次正常启动冻结一份 grant，扩权或重新授权不会刷新已有进程的权限。新 run 身份不复用；旧 bearer、旧 run、旧 grant、序列倒退、相同序列不同内容均拒绝。相同已提交快照返回原确认，不增加写入，不刷新其 receivedAt。

撤销先提交新拒绝策略，再使缓存/游标失效并删除旧投影。物理清除失败会报告 storage-failed，但撤销仍生效；重新打开合法策略时也不能通过残留文件取得内容。已有 board 与旧 receipt 的来源引用按当前授权过滤；正常移除实例则保留无业务内容的摆放占位。已经发给用户的内容、截图和备份不能被远程收回。

正常停止 run 保留获准的最后结果并标 stale，另一个来源继续发布。心跳不延长内容 freshness；45 秒无通道活动会终止当次发布会话，但不能据此宣称业务进程已经死亡。布局 CAS 与管理 revision、来源 sequence 分开。布局与回执同一次提交，确认在写入完成后发出。

## 3. 验证证据

[Dashboard Home run 36097583620](https://github.com/klarkxy/dsh-spaces/actions/runs/36097583620) 的 `home` 与 `native` job 均已通过。`home` 覆盖：Node 24 strict 检查、52 项既有核心、37 项既有本地/视图/HTTP、39 项新增 Home 检查，共 **128 项 Node 测试**。同一份源码在本地 Linux Node 22.16.0 也通过这些测试；本地验证不是 Node 24 证据的替代。

39 项新增检查分为：26 项聚合/授权/并发，9 项真实磁盘/私有凭据/Node 传输及独立进程，4 项公开与内部路由权限隔离。用例覆盖未授权发布、选定实例、撤销后旧游标/摆放/回执/导航、清除失败仍拒绝读取、双来源隔离、重复确认、原子提交等待、错误凭据、符号链接、Host/Origin、布局并发和失败不重发。

两个独立 Node 发布进程的测试使用真实私有文件、HTTP 和磁盘，不使用 iframe、DOM 或前端窗口。来源 A 停止后保留最后值，B 仍可更新；撤销 A 后目录不再提供 A。该用例不是完整原生 DSH Host 安装验收。

原生双 Host 验收脚本：`scripts/test-dashboard-home-native.mjs`。它在自己的临时 Home 中用官方 CLI 安装本次 tarball，运行两个原生 DSH Host，再经真实发布模块交给 Home 服务。拥有者是明确标注的**测试装配**，不是现有 WorkbenchSupervisor，因此通过也不表示生产生命周期与授权管理界面已接通。该原生流程已通过，并下载读回 `dashboard-home-native-evidence`（artifact 10847533896）的 result.json：status=passed，五项完成记录齐全，Node v24.21.0。具体完成两 Host 无浏览器发布、同一布局引用两个空间、停止 A 后 B 保持 live、撤销 A 后目录与摆放隐藏、根数据目录指纹不变。本次证据是后台结果 JSON，没有生成多空间首页截图，也没有宣称生产 Supervisor 已挂载。

同一代码提交的 Dashboard local、Dashboard native、Dashboard core 工作流也通过；仓库级 CI 与 Desktop startup regression 记录时仍在执行，不能据此称为全仓库绿色。

全树上传前，本地 `git write-tree` 为 `031e8766737984db6cb0be51292809413a38fe6e`，与 GitHub 创建的代码树一致。初始只为取得隔离编译工具的临时 CI 步骤已被实际测试替换，编译依赖归档不进入产品。

## 4. 明确的剩余接线

后续必须在现有 Supervisor 取得 Home 运行权后创建单个 HomeDashboard，并挂到现有 HTTP 监听器。公开认证复用 Supervisor 的真实会话与角色，不能把测试中的固定 Cookie/角色复制进去。

`dashboard.publication.set` 仍须并入现有 preview → plan.execute 管道，在变更前重新检查管理 epoch/revision、源 generation、维护与锁状态；不得另起一个管理 REST 入口。改动授权不自动安装插件、重启空间或替用户开始任务。

空间正常启动时先绑定其 generation/run，再生成私有交接文件并传入 Node 环境；停止或观察到退出时先废止 run 凭据。源空间删除先撤销其全部展示授权，再走既有删除流程。Supervisor 退出须终止这些通道，旧子进程不会自动登记到新服务。

还未完成：生产 Supervisor 的上述挂载、授权 UI、默认预装轻量 provider、组件清单 schema 过渡、真正 Home 默认页、多空间浏览器/Electron 全链路与实际业务插件。Windows 当前明确不支持 Home 私有文件适配，不能以 POSIX mode 代替 Windows ACL；macOS、断电持久性、恶意同 UID 进程竞态、5000 实例负载和完整平台验收也未覆盖。

## 5. 复现

在隔离工作目录使用 Node 24：

```sh
npm ci --ignore-scripts --no-audit --no-fund
node scripts/test-dashboard-core.mjs
npx --no-install tsc -p tsconfig.dashboard-home.json
npx --no-install tsc -p tsconfig.dashboard-ui.json
node --import tsx --test tests/dashboard-local.test.ts tests/dashboard-lifetime.test.ts tests/dashboard-view.test.tsx tests/dashboard-http.test.ts
node --import tsx --test tests/dashboard-home.test.ts tests/dashboard-home-node.test.ts tests/dashboard-home-gateway.test.ts
node scripts/build-dashboard-plugin.mjs
npm install --prefix .sandbox/dashboard-sdk --ignore-scripts --no-audit --no-fund --fetch-retries=0 @deepseek-ai/dsh@0.1.7-alpha.1 pnpm@10.15.0
DSH_DASHBOARD_SDK_ROOT=.sandbox/dashboard-sdk node --import tsx scripts/test-dashboard-home-native.mjs
```

最后一行使用 POSIX shell 环境变量语法。没有任何步骤要求填写真实 Home 或 API Key；原生测试的业务内容来自合成 Host 插件，没有调用模型。
