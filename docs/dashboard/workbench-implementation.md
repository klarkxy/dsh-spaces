# Home 首页与发布授权界面：第六批施工

日期：2026-09-25。PR [#16](https://github.com/klarkxy/dsh-spaces/pull/16)，依赖 #15 → #14 → #13 → #12 → #11 → #10。运行代码：`b54131a856116b6e97fa91597819613cf974cbee`。活动进度只记入 [tasks/todo.md](../../tasks/todo.md)。

本批把共享工作台的默认 Home 接成可操作看板，并接入发布授权表单。真实浏览器已经通过现有 Supervisor 和两个原生 DSH Host 的授权、固定、撤权流程。**尚未合并 main、发布、迁移用户 Home 或完成默认预装；本批变更的默认首页属于该 PR 分支构建，不代表用户已安装客户端已更新。**

## 1. 首页、聊天与自由组合

`packages/plugin/src/workbench/dashboard-home.tsx` 提供 Home 看板、聊天与发布授权三个视图。默认进入看板；不因打开 Home 就创建聊天 iframe、创建默认布局、启动空间、执行任务或生成测试数据。点击聊天后才创建原生聊天 iframe，之后在看板、空间和设置间切换会保留该实例。

看板复用独立 `packages/dashboard` 的 DashboardApp，不引入 Electron API。空间仍各自执行工作，Home 只组织已发布组件。原生独立插件仍可只服务本空间；管理器组合能力不变成业务插件的强制依赖。新的卡片目录显示来源空间和 providerId，避免两个相同标题混淆。

当前可固定、移除、修改网格位置和尺寸；本批未增加拖拽、完整目录分页、任意脚本组件或业务执行按钮。现有设置窗口、来源空间视图和聊天入口保留。

## 2. 发布授权走既有管理计划

用户选择受管理的普通空间，填写插件文档声明的 providerId，然后选择停用、指定实例或全部实例。全部实例选项明确包含未来新增内容；指定实例不接受空白、重复、超量标识。默认选择停用，不会靠猜测插件名称扫描未授权业务数据。

表单调用 WorkbenchController.preview，继续使用现有计划确认窗口和 plan.execute。预览、取消不更改权限；确认后由真实 Supervisor 再检查管理 epoch/revision、空间 generation、grant CAS、维护与运行权。授权本身不安装插件、不启动空间；新授权在下次正常启动分配。撤销隐藏已发布内容但不删除来源任务或停止进程。

原生 Remote 的请求与响应 Zod schema 都补入 `dashboard.publication.set`。该遗漏是在实际浏览器调用中发现的，单测和直接 Supervisor HTTP 测试不能替代这两层验证。补充沿用严格 identifier/selection 合同，未改成宽松 any 或添加直接授权 REST 捷径。

表单保留编辑所依据的 grant revision。服务端状态变化时不会静默覆盖草稿或以最新 revision 偷偷提交；用户须显式采用当前配置。读取失败终止该页面的读取流程，认证失效会清空看板和授权视图内容。

## 3. 管理空间跨端口接口补充

原生工作台页面位于管理 Host 端口，Home API 位于 Supervisor 端口，两者是不同 Origin。本批对 Home gateway 增加一个有界的管理来源适配，独立本空间插件的同源默认行为不变：

| 项目 | 当前规则 |
| --- | --- |
| 端点解析 | 从经过认证的 `api.view(managerId)` 取得 entryOrigin，检查 managerId、generation、serviceEpoch 和当前页面 origin |
| 允许来源 | Supervisor 自身，或 Supervisor 当前拥有的管理 Host 的精确 `http://127.0.0.1:port`；普通空间、旧管理端口、外部和 null Origin 均拒绝 |
| 预检 | 仅 query/commands 的 POST，仅 Content-Type 与 X-DSH-Dashboard 两个请求头，Max-Age=0，不返回数据 |
| 实际鉴权 | 仍必须是 Supervisor operator Cookie；CORS、Host bearer 或 publisher bearer 不是登录凭据 |
| 响应 | 获准管理来源使用精确 Allow-Origin、Allow-Credentials=true、Vary: Origin、no-store；没有 wildcard |
| 内部发布通道 | 不适用上述例外，仍拒绝浏览器 Origin/Cookie |

浏览器不取得管理 bearer、启动 token 或 Home 文件路径。旧运行实例、停用管理空间的来源失去 CORS 许可。传输不跟随重定向、不自动重发，错误响应也不对未获准来源放行。

## 4. 原生静态样式

初次真实截图暴露了工作台样式缺失：原生页面中三份 JSX style 未形成有效样式节点，工作台显示为普通 block，窄屏发生溢出。诊断没有看到 CSP 拦截；本批不推断为已经定位的 React 或上游具体缺陷。

现改为在原生插件的 ctx.effect 中注册固定打包 CSS，标注 `data-plugin` / `data-plugin-css`，随拥有者生命周期移除。这与官方主题插件的静态样式装配方式一致，不改变 CSP，不执行用户/provider CSS，不轮询补装样式，不清除其它插件的节点。共享视图与原生入口使用同一 CSS 常量，独立渲染测试仍可使用自身样式。

新增原生断言检查实际 computedStyle、网格、侧栏宽度以及三份已激活 CSSOM；不能只凭按钮可点击或元素存在判定界面完成。

## 5. 已验证的结果

[Dashboard workbench run 36106273448](https://github.com/klarkxy/dsh-spaces/actions/runs/36106273448) 的 unit 与 native job 均通过，运行 Node **24.21.0** / Ubuntu。

- node/web 严格类型检查通过。
- 52 项核心回归、187 项组合 Node 检查、2 项既有工作台 Chromium DOM 检查通过。组合包含既有工作台与插件测试；**不是新增 241 项**。本批新增 14 项 endpoint、表单、Remote schema、CORS 和样式生命周期检查。
- 既有 DOM 浏览器测试验证聊天草稿、同一 iframe、空间切换、设置关闭和原有管理交互。
- 完整 Spaces 构建和独立 dashboard 构建通过，没有重复打包 React。
- 额外一条原生多步骤 Chromium 流程通过，拥有者是实际 WorkbenchSupervisorRuntime，来源是两个实际安装插件的原生 DSH Host，不再用内存 UI fixture 代替完整链路。

原生流程实际完成：默认首页不自动创建聊天或布局；发布预览/取消零权限副作用；确认后来源仍停止；正常启动两个空间；在 Home 固定并显示两个来源；切换聊天保留实例；450px 窄屏无横向溢出；从界面撤销 A 后已有 A 卡片隐藏而两来源未被自动停止；正常关闭清理凭据、释放运行权并保持根目录指纹。

已下载并读回该 run 的 `dashboard-workbench-evidence`（artifact **10850799844**，保留至 2026-10-02）：result.json 为 passed，七项流程证据齐全；home-desktop.png 和 home-narrow.png 已逐张检查。截图确实来自实际默认工作台页面，不是效果图。卡片值 9 来自合成测试业务插件，没有调用模型或读取用户真实数据；本批未保存授权表单截图，不以 Home 截图冒充所有页面视觉验收。

本地 Linux Node 22.16.0 的同组非浏览器检查也通过。当前执行环境的 Chromium 访问隔离端口被策略阻止，因此浏览器通过证据来自 Actions；没有绕过策略或将本地阻断记为通过。

## 6. 剩余范围与发布门槛

新建/已有空间的默认预装、组件清单过渡和可公开发布版本尚未完成。当前无已安装发布插件或没有授权的空间不会自动出现业务卡片。插件标识目前由用户填写，未来可增加不暴露业务数据的元信息注册。

Windows Home 私有文件 ACL 仍未支持，Windows UI/跨端口不可用提示与 Electron 安装包流程也没有在本批验收；不能把 Linux 原生浏览器成功延伸成 Windows 发布可用。真实业务插件、完整双语、拖拽、目录分页和完整看板管理仍待施工。原生聊天默认工作目录初始化的先前提示未在本批修复或重新认定。

看板工作台、Home、Supervisor、本地和原生专项通过，不代表仓库全量 CI 已通过。Windows workbench 升级/交接的既有失败需要单独归因和处理；没有跳过相关测试或强行合并。最终状态以对应 commit 的 Actions 为准。

本批临时 CSS 诊断和 Git-object 准备步骤已移除；最终工作流只有 contents:read，直接运行提交源码。运行代码整树 `2a2fc120cf2ece90a65408dc4df53e214ede3227` 与本地验证树一致。随后文档提交不改变上述测试代码。

## 7. 复现

在本分支的隔离工作目录使用 Node 24：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npx --no-install tsc --noEmit -p tsconfig.node.json
npx --no-install tsc --noEmit -p tsconfig.web.json
node scripts/test-dashboard-core.mjs
node --import tsx --test tests/dashboard-workbench.test.ts tests/dashboard-workbench-cors.test.ts
npx --no-install playwright install --with-deps chromium
node --import tsx --test tests/workbench-ui-dom.test.ts
npm install --prefix .sandbox/dashboard-sdk --ignore-scripts --no-audit --no-fund --fetch-retries=0 @deepseek-ai/dsh@0.1.7-alpha.1 pnpm@10.15.0
node scripts/build-spaces.mjs && node scripts/build-dashboard-plugin.mjs
DSH_DASHBOARD_SDK_ROOT=.sandbox/dashboard-sdk node --import tsx scripts/test-dashboard-workbench-native.mjs
```

最后一行是 POSIX shell 语法。测试自己创建私有 `.sandbox/dashboard-workbench-native-*`，不要求提供真实 Home 或 API Key。完整 187 项组合命令保留在只读 Actions 工作流中。
