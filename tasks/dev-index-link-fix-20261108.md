# 2026-11-08 开发链接缺少 dev-index 的启动失败

## 故障与边界

用户重新打开 Desktop 后，管理空间 `spaces-hub` 报 `dsh: cannot resolve profile bundle "@klarkxy/dsh-dev-index"`。

开发链接不会在目标 profile 根安装被链接组件的 dependencies；Spaces plugin 和 view-bridge 的 patch 却都引用 dev-index。组件准入检查调用官方 `resolveBundleDir`，从 DSH 安装锚点和 profile 锚点查找该行，因目标 profile 没有可解析的包而失败。

这解释本次重开后的启动失败，不证明此前 `MAIN_REGISTRATION_REFUSED:400` 的历史原因。前一轮已修复其错误码被丢弃的问题。

## 修复

- `SupervisorToolchain` 仅处理组件 patch 已知引用的 `@klarkxy/dsh-dev-index`，版本读取组件自身清单，不另设版本来源。
- 正常管理空间对齐及子空间 `space.components-align` 写锁内，通过已有官方 CLI 链接安装流程，将 checkout 已安装的对应版本建立为 profile 直接依赖。
- 已匹配的组件不重装；用户已声明并安装的 dev-index 版本不覆盖；声明缺实体、清单损坏或 checkout 缺所需版本时如实失败。
- Browser base 不添加该依赖，发行包路径保持原行为；没有失败重试、重启、清理或恢复逻辑。
- `ensureViewBridge` 保持原职责，新增依赖写入只在组件对齐锁内发生。

## 验证

定向回归 28/28 通过，覆盖管理空间补依赖、子空间对齐、用户版本保留、声明但缺实体、损坏清单、Browser 和非开发模式。

真实 CLI 验收脚本：[run.mjs](../.sandbox/dev-index-link-acceptance/run.mjs)。使用 Node 26.10.0、独立官方 DSH 0.2.2-rc.1 SDK，SDK 与 Home 均位于仓库外，消除从仓库祖先 node_modules 借用依赖的假通过。

通过现场：`H:/Code/dsh-spaces-checktmp/dev-index-link-2026-11-08T13-13-14-637Z`。

1. 通过官方 CLI 从 Web 模板建立 `spaces-hub`，以仓库根目录作开发链接。
2. 官方解析器逐字复现用户的 cannot-resolve 错误。
3. 调用生产 `alignManagerPlugin`，不替换安装函数，实际经 `dsh plugin add` 对齐组件并安装本地 dev-index 链接。
4. 确认 profile 直接依赖及 bundle 声明、官方解析器成功、实际 `alignProfileComponents` 准入成功。
5. 官方 app-boot 真正加载组合，Loader 中 dev-index 只挂载一条，五个工具全部注册：`dsh_docs_fetch`、`dsh_docs_search`、`dsh_github_fetch`、`dsh_plugins_fetch`、`dsh_plugins_search`。
6. 正常 dispose，进程 exit 0。未调用付费模型或重启真实服务。

首次 CLI 验收停在夹具错误断言：`composeEntries` 保留三层同 ID 声明，去重发生在 Loader 挂载阶段。未改变产品配置以迁就断言；修正后新建独立 Home 验证。第一次现场保留，未重用。

最终完整 `check:all` 已完成，[原始结果](../.sandbox/checks-dbnQgE/result.json)为 **11/14 组通过**，原失败记录保留：

- `test:spaces` 首轮因直接构造的测试 host 未提供新增接口而失败；补齐 `ensureBundledDeps` 和锁内顺序断言后，单独补验为 **114 通过、1 条件跳过、0 失败**（父代理作业 `pwsh-7adbb14cf212407d`，exit 0）。只改测试夹具，未改产品实现。
- `test:workbench` 为 **796 通过、1 失败、2 跳过**，唯一失败是此前已记录的 `--dsw-radius-sm` 主题 token。
- `test:workbench:browser` 为 **19 通过、6 失败**，失败为此前已记录的旧选择器问题。
- 测试清单、三组类型检查、最终构建、基础测试、recovery、LLM（50/50）、Blueprint、Browser、包预检通过。

不能将本轮称作一次全量全绿；补验后剩余两组既有失败。当前实际用户实例尚待加载本轮构建后验收。

## 官方依据

- [Your first plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/index.md)：patch 不改变 profile 的模块解析基准目录。
- [Plugin lifecycle](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/index.md)：插件加载与清理语义。
- 上述网站是当前文档；决定性的解析、安装、挂载验证使用实际 0.2.2-rc.1 SDK 中的 `resolveBundleDir`、官方 CLI、profile loader 与 app-boot。未新增 DSH Service/Event/Tool API。

真实用户 Home 未因本轮修复被直接改写；正常对齐将在用户下一次明确启动时执行。前一轮受限只读调查的范围偏差已单独记录在任务清单，不将其说成完全合规的读取。
