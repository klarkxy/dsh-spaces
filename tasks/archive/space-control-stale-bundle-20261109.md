# 2026-11-09 spaces-hub 残留独立 space-control bundle

## 已确认事实

用户截图显示管理服务启动失败：`cannot resolve profile bundle "@dsh-spaces/space-control"`。

按 AGENTS.md 的真实 Home 只读例外执行 `dsh --profile spaces-hub --dump-config`，仅输出与旧包名和解析失败相关的行；CLI 返回 `skipping profile bundle "@dsh-spaces/space-control"` 和同一 cannot-resolve 错误，退出码 1。未直接读取真实 Home 文件。

当前 `packages/plugin/cordis.patch.yml` 的行已经使用 `@dsh-spaces/plugin/space-control`；根 manifest 及插件 manifest 提供该子入口。对 `src`、`packages/plugin/lib`、`dist` 的检查未找到旧独立包名。既有任务记录明确：独立 `file:` 包已撤销，改成宿主插件子入口。

因此，当前故障有真实 profile 仍引用已撤销独立 bundle 的证据。现有构建修正不会自行删除已持久化的 bundle 成员。不能把先前全新 Home 安装冒烟成功当作已有 profile 已完成变更。

源码路径：`startOwned` 调用 `alignProfileComponents`；其中 `declaredProfile` 对 `dsh.profile.bundles` 每个成员调用官方 `resolveBundleDir`，在读取插件行的 disabled 状态之前即失败。当前检查应保留，不以跳过未知 bundle 绕过准入。此前独立包通过官方安装进入 profile 是与既有变更记录一致的来源解释；本轮没有读取真实 manifest 或历史安装日志，不声称确认了当时具体安装命令。

本轮核对官方文档的安装/卸载规则，并以工作区安装的 `@deepseek-ai/dsh` / `dsh-plugin-manager` 0.2.2-rc.1 源码验证：`runPluginCommand` 在 profile manifest 写锁内运行 pnpm，成功后 `reconcile` 根据前后 dependencies 调整 bundles。若旧名称前后均不属于 dependencies，`reconcile` 保留该 bundle；不能只凭 dump 输出保证 remove 可用。

## 授权前边界（历史）

- 未修改产品源码，未加自动清理、重装、重试或迁移。
- 未执行真实环境卸载或直接编辑配置，未重启服务或子空间，未清除失败记录。此前按项目明列例外运行了 `--dump-config`；后续官方源码复核发现该命令可能生成 profile 的 `cordis.yml`，因此不能保证官方命令内部完全无文件写入。
- Win32_Process 只读查询返回拒绝访问；没有换通道重试，不能据此判断存活 Supervisor 的构建版本。
- 子代理在隔离 Home 验证：存在 dangling link:/file: dependency 时，官方 remove 退出 0，移除 dependency 与 bundle；只有孤立 bundle 时，remove 退出 1，保持 manifest 原样。主代理核对 `.sandbox/repro-full-A/profiles/spaces-hub/package.json` 已无旧名，`.sandbox/repro-full-B/profiles/spaces-hub/package.json` 保留旧名，后者官方 pnpm 日志记录 exit 1。子代理还报告移除后的 dump 退出 0、无旧名诊断。
- 隔离环境中旧 bundle 的 skip 本身可为 exit 0；真实 dump 的 exit 1 不能单独归因于该 skip。真实完整 stderr 尚未读取，附加原因待授权后确认；不根据猜测认定为锁或解析问题。
- 本轮没有产品代码变化，未重复全量构建与测试。此前新 Home 冒烟不代表旧配置迁移成功。
- 当时待授权范围：窄读真实 spaces-hub manifest 的旧包 dependency/bundle 字段及必要的脱敏错误；存在旧依赖时执行官方 remove，否则仅原子移除该确切 bundle 成员；保留其他配置，随后验证。真实配置操作须获得用户明确授权，以覆盖 AGENTS.md 对真实 Home 访问的禁止；服务启动仍按既有预览和确认流程执行。

## 用户授权后的真实配置处理

用户选择“授权检查并移除旧声明（推荐）”。限定读取确认旧 dependency 为 `link:H:/Code/dsh-spaces/packages/plugin/lib/space-control`，bundle 中旧名恰好出现一次。这是实际观测到的旧目标；不能把旧独立源码目录路径当成本机真实 dependency spec。

执行官方命令 `dsh plugin --profile spaces-hub remove @dsh-spaces/space-control`。沙箱首次因不能创建 profile 的 `package.json.lock` 而拒绝；经同命令单次普通权限批准后执行成功，pnpm 10.29.2 报告移除该 dependency、退出 0。未直接编辑真实 manifest。

读回确认 `HasOldDependency:false`、`OldBundleCount:0`。沙箱内配置导出明确报 `EPERM ... spaces-hub/cordis.yml`；按同命令单次普通权限批准后，`dsh --profile spaces-hub --dump-config` **退出 0，无旧包解析诊断**。最初过滤后的退出码 1 没有保留完整错误，不能追认其必然等于后来复现的 EPERM。

真实旧配置故障已处理，官方配置组合验证通过。未修改产品源码，未启动/重启管理服务或子空间；错误页当前失败控制器仍为终态，需用户在页面上按原有确认流程发起一次新服务启动。尚未将“配置验证成功”记成“实际服务已运行”。
