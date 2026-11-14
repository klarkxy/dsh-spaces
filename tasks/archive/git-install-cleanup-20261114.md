# 2026-11-14 Git 安装与发布流程清理

## 范围

用户决定暂缓 Spaces 的 npm 发布，当前从 Git 获取源码安装。本次整理安装入口、发布工具、测试入口和现行文档；包身份继续为 `@dsh-spaces/plugin`，0.5.0 仍为未发布候选版。

## 处理

- 移除 npm 发布专用 workflow、发布脚本及其测试，并移除只有该流程使用的 reusable workflow 入口。原实现保留在 Git 提交 `cad426a5ce02b4bdcc9c2bd118bd33314be20b11`，操作方案归档至 [历史发布准备](../../docs/archive/npm-publishing-20261114.md)；不要求当前用户先完成 npm 账号、组织或 OIDC 设置。
- 保留 CI、手动插件打包、制品内容与摘要校验。分发构建统一使用 `--distribution` / `DSH_SPACES_BUILD_TARGET=distribution`，继续默认记录 `info` 及以上日志。
- 保留 14 项公共插件目录、贡献入口、目录校验和按 npm 包名安装。目录测试独立为 `test:catalog`；移除注册表读取中仅供首次发布检查使用的“允许不存在”分支。
- README、中英文安装说明、包内说明、贡献说明、架构、候选发布说明和待办统一到“Git 克隆 → `npm ci` → `npm run pack:plugin` → 官方 DSH 安装本地 tarball”。明确仓库 URL 直接安装尚不支持；依赖下载仍使用 npm，不需要 npm 发布权限。
- 修正主 README 英文段落及包内 README 中已过时的“模型同步必须停空间”描述，与现行在线同步行为一致。
- 完整检查发现浏览器测试直接接受了系统分配的 6000 端口，导致浏览器在页面加载前报 `ERR_UNSAFE_PORT`。五个浏览器测试文件改用现有 `bindInitialLoopbackHttp` 完成初始端口绑定；不改产品代码、浏览器安全策略或故障处理。

## 保留边界

没有 npm 发布、版本升级、账号设置或日常安装变更。没有写入真实 `~/.dsh`。此前演示素材 `outputs/`、隔离验收数据及失败证据保留，不用全目录删除来隐藏未验事项。

真实 Desktop、长期运行和此前列明的验收缺口继续保留在 [维护待办](../todo.md)。干净检出的安装验收与日常 Desktop 验收是不同范围。

## 验证

- `npm run check:all -- --output .sandbox/git-install-cleanup-checks --temp-root C:\Users\27837\AppData\Local\Temp`：16 个阶段中的前 15 个通过，包括测试清单、目录校验/测试、三组类型检查、构建、全部非 DOM 测试组和包预检。最后 DOM 组为 26 通过、1 失败，失败原因是上述 6000 端口分配；原失败日志保留。
- 修正测试绑定后，重新执行 `typecheck:tests` 和整组 `test:workbench:browser`，均通过，DOM **27/27**。记录在 `.sandbox/git-install-cleanup-followup/`。未将第一次检查报告改写成成功，也未重跑无关已通过组。
- 全部四份现行 workflow 可解析，修改文档中的相对文件链接有效；`git diff --check` 通过。
- 干净 Git 检出上的依赖安装、构建、真实 Web 初始化/重开/卸载由本次推送的 `CI / plugin-install` 验证；其最终结果以该提交对应的 Actions 记录为准。上述本机检查不替代真实 Desktop 验收。
