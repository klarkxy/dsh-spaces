# 2026-11-14 Git 仓库根目录直接安装

用户澄清：安装入口应直接接受 Git 仓库根地址，不能要求用户先克隆、装依赖、构建并手动打包。此前将 Git 安装描述成手工源码构建流程不符合要求；本记录取代那部分现行安装说明，旧记录保留为历史。

## 实现

- 根 `package.json` 增加 `prepare`，复用现有分发构建；根 `files` 白名单携带 `packages/plugin` 的完整运行组件、配置、图标、语言资源和许可证，不带源码、测试、沙箱与构建工具。
- 主包名仍为 `dsh-spaces`，根包 exports 与既有本地开发链接共用入口。Git 安装在 `node_modules` 中，按发行模式选择并暂存组件组，不进入开发检出模式。
- Blueprint workspace 和已被编译进插件的库移至开发依赖。Git 包的生产依赖不再引用安装包中不存在的本地目录；锁文件同步，依赖版本未升级。
- CLI 示例为 `dsh plugin --profile web add github:klarkxy/dsh-spaces --allow-build=dsh-spaces`。示例验证使用 pnpm 10.29.2；Web 插件页直接填写 Git 来源并按宿主提示确认构建权限。授权仅针对当前插件，未放宽全局脚本策略。
- 现有安装验收支持 `DSH_TEST_PLUGIN_SPEC`：直接安装完整提交号的 Git 根来源，跳过本地打包输入，并读回根入口、完整组件文件及锁文件提交号。复用真实 Web 初始化、空间生命周期、正常停机和卸载检查；CI 同时保留 tarball 验收并新增公开 Git 根安装验收。
- README、包内文档、架构及候选发布说明统一到直接 Git 安装。手工源码构建/打包保留为维护者可选流程，npm 发布仍暂停。

## 本地验证

- `.sandbox/git-root-fixture-proof/`：使用 Git 跟踪文件的源码快照，明确断言快照无编译产物。通过隔离的 Git 配置把 fixture GitHub 来源映射到本地仓库，不改用户 Git 配置。官方 DSH 0.2.2-rc.1 拉取完整提交、运行根包 prepare、安装并通过初始化、空间创建/进入/重启、重开同一管理器、持久化正常停机与卸载。该阶段是受控 Git 传输测试，不冒充公开 GitHub 下载证明。
- 新增官方 CLI 回归：全新 profile 不预写构建配置，单条 Git 根安装命令使用 `--allow-build=<包名>` 即可执行 prepare；安装前构建入口不存在，安装后生成入口可读，构建源码不进入成品。该用例已通过。
- `.sandbox/git-root-install-checks/`：16 阶段中 15 阶段通过，包括所有 Git/root packaging 用例、类型检查、构建和 DOM 27/27；维护响应测试在进入工作断言之前，连续分配到测试预留端口而失败。原失败日志保留。
- 将该测试的未暴露心跳探针改为高位端口，避开项目预留区间；只在初次绑定出现地址占用时进行有界选端口。未改变产品端口分配或失败处理。`.sandbox/git-root-followup/` 中 `typecheck:tests` 与完整 `test:workbench:recovery` **28/28** 通过。
- 公开仓库的完整提交安装由本次推送的 `Git repository root installation in a fresh Home` CI 步骤验证，其结果以对应提交的 Actions 记录为准。

没有 npm 发布、真实 Home 写入或日常安装变更；既有真实 Desktop 和长期运行待验项继续保留。
