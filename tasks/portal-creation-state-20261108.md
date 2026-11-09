# 2026-11-08 新建空间触发 portal state-invalid

## 已确认缺陷

用户截图显示 `The space service returned invalid portal state data.`。`projectSpaceCreations` 原本引用模块级 `PORTAL_SPACE_RE`，但 `renderPortalPage` 通过 `.toString()` 把函数嵌入独立浏览器脚本，该页面并没有这个常量。状态中没有创建作业时不会执行该分支；出现带空间 ID 的 queued/running/failed 创建作业后，缺失引用抛出 ReferenceError，被 portal 的异常边界报告为 `state-invalid`。

源码与本轮开始时的 Supervisor 构建产物具有相同缺陷。修复把相同正则放到函数内部，与既有 `parsePortalSnapshot` 的自包含模式一致；未放宽校验、添加重试或恢复。

- [修复](../src/shared/space-host.ts#L188)
- [脚本嵌入与异常边界](../src/adapters/node/server/workbench-portal.ts#L78)
- [永久回归](../tests/native/nav-diag-portal.test.ts)：实际渲染脚本在独立 VM 中执行，覆盖 native 初始状态含创建作业、native 轮询出现作业，以及 Web 发布创建投影。

## 隔离验证

- 修改前，实际 Chromium 执行 esbuild 打包后的 portal：空作业状态正常，首次 queued `space.create` 导致 `stopped=true`，断言失败。见 [旧实现证据](../.sandbox/portal-creation-20261108/browser-before.json)。
- 修改后，实际 Chromium 两种 portal 模式 × 两种创建类型 × queued/running/failed/succeeded 共 **16/16** 通过；失败作业错误保留，完成作业不再投影，未出现终态错误。见 [浏览器结果](../.sandbox/portal-creation-20261108/browser-result.json) 与 [隔离驱动](../.sandbox/portal-creation-20261108/browser-check.mjs)。这是模拟 API 下的真实浏览器脚本验证，不是实际用户空间的创建验收。
- 第一次定向回归：native-desktop 与 nav-diag-portal 共 **43 通过**；portable-host 因本轮开始前已缺失的 view-bridge 源码而无法加载。新增永久回归随后移入不依赖缺失包的 nav-diag-portal，并单独验证 **8/8 通过**（包括新增回归；作业 `pwsh-f50f859531cf43c4`）。
- 第一次完整检查：[result.json](../.sandbox/checks-GKtIba/result.json)。check:test-lists、typecheck 通过，typecheck:spaces 因缺少 view-bridge 的 env/message-service 模块失败；runner 按既定规则停止，后续检查未执行，未记全量通过。

## 完整检查结果

恢复源码后的完整 runner 已结束：[result.json](../.sandbox/checks-Rgjy7P/result.json)，**12/14 组通过**。

- test-lists、三组类型检查、构建、基础测试（244/244）、Spaces（114 通过/1 跳过）、recovery（28/28）、LLM（50/50）、Blueprint（216 通过/4 跳过）、Browser（18/18）及包预检通过。
- workbench：797 通过、1 失败、2 跳过；失败仍为此前记录的 `--dsw-radius-sm` 非 SDK 主题 token。
- workbench browser：19 通过、6 失败；仍为此前记录的隐藏 plugins/diagnostics/版本选择器和缺失“预览切换”按钮。没有改这些 UI 或旧测试来使本轮变绿。
- 恢复产物逐项对照后补齐的两处变更，另由 [最终定向检查驱动](../.sandbox/portal-creation-20261108/final-check.mjs) 重跑空间/测试类型检查、构建、LLM、portal/视图/准入与预装回归、包预检。见 [final-result.json](../.sandbox/portal-creation-20261108/final-result.json)：类型两组、构建、LLM 50/50、包预检通过；组合回归 101 通过/1 失败，唯一失败仍为上述主题 token，新 portal 回归通过。没有将此 runner 的 failed 状态改成 passed。

## 构建阻碍

本轮初始 Git 状态已显示 `packages/view-bridge`、`packages/llm-bridge` 下 33 个受控文件删除；两目录为空。用户明确确认不是有意删除，授权找回最近源码并继续构建。已将现有嵌套构建副本保存在 `.sandbox/portal-creation-20261108/bridge-before/`，用 `git restore --source=HEAD --worktree -- packages/view-bridge packages/llm-bridge` 找回源码基线（未改变 index）。逐行发现基线仍包含 `FileLlmCredentialStore`、`llm-resolution`、`llm-snapshot` 与 `legacyApply`，证明“文件集吻合就代表最近源码”的初步复核结论错误，未直接据此构建。已依据现行任务、测试及保留的 LLM bridge 打包代码补回此前迁移：仅主空间继承默认投影与活动跟踪、main facade 的最新安装方式、4.1 internal/config 参数、移除六个已退役模块及 spacesLlmSnapshot 注入；保留握手 setImmediate 边界。view-bridge 已补回 dev-index 0.2.8 的依赖/标准行 ID 与 DSH 0.2.2-rc.1 peer 范围。三组类型检查与完整构建均已通过；完整检查已完成，结果保存在 `.sandbox/checks-Rgjy7P/`。对比恢复前后 6 个 bridge bundle 时，4 个逐字节一致，另两个仅定位出尚未补回的旧设置检查移除和附件所需服务检查；已按原产物补齐这两处，随后完成最终重建与定向检查。最终 6 个 bridge bundle 中 **5 个逐字节一致**，LLM 主 bundle 仅三处 if/throw 的换行格式不同（git diff 已逐项核对，无剩余执行逻辑差异）。view-bridge 元数据还补回了现行测试要求的 dev-index 预装声明。恢复依据是 Git 基线加当前打包行为与现行测试，不声称逐字找回所有删除前源码。

## 运行时与接口证据

- SDK 与官方 Desktop runtime 均为 DSH **0.2.2-rc.1**；官方 `spaces_context` 同样报告该版本、writable=true、maintenance=false、createBusy=false。说明读取时服务仍可响应，不证明此次创建作业的结果，也不证明实际 UI 已加载修复。
- 使用 [官方 Cordis 插件文档](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/01-first-plugin.md) 作开发参考；本修复不改变 DSH API。
- `cordis_inspect_list`、Host Service/Config 检查已执行。Config 可定位 `@dsh-spaces/plugin` 记录（schema absent）；Service 目录没有可查询的 `workbenchGuide`，精确查询返回 `no catalogued Service`。因此不把该服务的运行时反射契约记为已验证。恢复源码涉及的 `internal/config` 事件也未被 Inspect 编目；已核对匹配的本地 Cordis 4.1.0 `lib/types/events.d.ts:223-229`：`internal/config(fiber, next)` 为 waterfall。另参考[官方配置文档](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/config.md)，没有据当前网站引入不同版本 API。
- 未读取或写入真实 DSH Home，未调用创建/重启/恢复操作。最终 Supervisor 产物已确认 `projectSpaceCreations` 使用函数内 `spacePattern`。当前用户窗口是否加载修复仍需用户下一次正常关闭并重开确认；新启动不重放此前创建请求，先查看原任务结果。
- 共享 Memorix 曾返回本轮记录 #22681 属于错误项目 `klarkxy/dsh-plugins`（此前已绑定 `/repos/dsh-spaces`）；随后的归档请求被工具以超出当前写入范围拒绝。已停止进一步记忆写入并告知用户，以本仓库记录作为验收依据，未声称错误记录已经撤回。
