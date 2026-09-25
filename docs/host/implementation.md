# 宿主内空间栏实施记录

日期：2026-09-25。基线：PR #16 `35c07c6386ad3f1d84681369ea2cde192e47586b`。本批在独立分支提交，依赖看板工作，不合并、不发布、不修改真实 Home。

## 已实现

- 普通顶层宿主使用 additive shell.overlay 空间栏，保留宿主 root、品牌、原会话 DOM；管理身份不再决定能否显示外层空间栏。
- 单次 audience-bound portal 接入既有 Guide、Supervisor Cookie 和 Node 内部认证；普通客户端没有新增管理 Remotes。
- contained manager 及严格来源导航桥保留实际 manager → workspace 的 parentOrigin 链；既有 Home 看板保留；embedded child 不重复挂载空间栏。
- 只读选择运行中空间；未运行、未知、失效和不支持的传输明确报告。当前应用不纳入删除/停止管理。
- 蓝图 v1 不变；类型契约、来源校验、TTL/数量/字节上限、客户端销毁与暂存消息检查、安装验收脚本和专项 CI 同步。

## 本地已执行

Node 24.21.0，隔离的源码/依赖副本。portable-host、spaces-host、workbench-plugin、workbench-ui、workbench-http-port、dashboard-workbench 六组共 131 项通过，0 失败、0 跳过。其中 portable-host 新增 10 项。初期 manager Home 品牌断言失败已通过保留 manager 原有品牌修正。spaces、node、web 三套 TypeScript 检查和 build-spaces 全部通过。浏览器与真实安装验收另列，不以这些检查代替。

本机 Chromium 对 loopback 导航返回 `ERR_BLOCKED_BY_ADMINISTRATOR`。未更改浏览器策略或使用关闭安全机制的启动参数；本机浏览器用例不记通过，交由隔离 CI 执行。工作流 artifact 只用于准备公开源码和依赖，无用户目录或 Git 凭据；临时准备工作流不进入最终产品 diff。

## 尚未认证

官方 Desktop 的 `dsh-app://app` 与原生子视图、远程 HTTPS 和第三方布局适配尚未实现与验收。内置通道明确拒绝这些条件，而不是宣传全宿主可用。完整既有外部空间注册、跨进程关闭确认、原生窗口 chrome 和复杂模态交互也是后续门槛。

上游 PR #16 栈与仓库已有 Windows 升级/交接失败不由本批专项测试抵消。只有对应实际运行的 CI 和原生安装记录可用于合并判断。
