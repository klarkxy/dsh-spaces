# 蓝图

本插件现由 [dsh-spaces/packages/blueprint](https://github.com/klarkxy/dsh-spaces/tree/main/packages/blueprint) 维护，面向 DSH **0.2.0-rc.2 及以后版本**，当前使用 **0.2.1-rc.2** 构建，仍可独立安装。Spaces 依赖蓝图协议；蓝图插件无需安装 Spaces。

[English](README.md)

把一组插件以精确版本和建议顺序分享出去。在 **Creator 模式**粘贴蓝图码并说明导入意图，由 Agent 归并到当前 profile 的 bundle 集合。Core 部分不依赖 Web，插件页只是可选的导出与只读解析入口。蓝图不提供 Spaces、独立客户端或后台 Agent 调度器。

蓝图描述的是插件组合，不是环境备份：不携带凭据、会话、数据、运行实例或发送方授权，也不声称恢复某个环境。同一份蓝图在不同接收方式下含义不同，不能因共享格式而承诺得到相同结果。

**源码预览，新版实现尚未完成真实宿主端到端验收。** 已执行的检查与仍待验收的条目见 [ACCEPTANCE.md](ACCEPTANCE.md)。

## 使用

- **直接归并**：在 Creator（`cordis`）发送“把以下蓝图合入当前插件组合，保留本地插件，由你处理版本冲突和顺序”，并附上 `DSHBP2:` 蓝图码。Agent 不要求你例行审阅排序计划；原生权限与安全审批仍然有效。
- **插件页**：打开 **插件 → 蓝图**。导出时选择已安装的插件并调整建议顺序，生成蓝图码；导入入口只解析蓝图，显示包身份与建议顺序，并生成可复制的归并请求。复制后在 Creator 粘贴发送；复制本身不启动模型，也不改变 profile。
- **Spaces 集成已封存**：Spaces 当前拒绝蓝图 source/generate/inspect/preview/apply 工作流，同一份蓝图不再是当前 Spaces 创建入口；独立 Creator 插件和蓝图格式不受影响。以后若唤醒，模型需求必须由接收方显式映射，不携带主空间 token、实例、授权或凭据；未显式配置时按届时的创建策略处理。
- 蓝图没有提到的本地 bundle 默认保留。只列在 `packages` 而不列在 `bundles` 中的项只是要求安装，不表示停用接收方 profile 中的同名 bundle。

## Core 与宿主能力

同一个包提供环境独立的 Host 部分和可选的 Web Client 部分，不需要另外安装 UI 包。ACP、SDK、headless 能做什么取决于各自的插件组合，而不是环境名称。环境独立并不表示每种部署都提供同样的服务、或都能立即激活插件。缺少 Web 服务不会阻止 Core 加载。

| 工具 | 用途 |
| --- | --- |
| `blueprint_parse` | 严格解码并校验蓝图码，不读取 profile |
| `blueprint_encode` | 校验 v2 JSON 并编码蓝图码，不安装或发布 |
| `blueprint_catalog` | 读取当前 profile 的包身份、完整已选顺序及状态 stamp |
| `blueprint_generate` | 按选定顺序导出已安装包的精确身份与版本 |
| `blueprint_apply_order` | 仅在 Creator 中重排当前已选 bundle 的完整顺序；不安装、不添加、不停用 |

工具在依赖的服务就绪后才会出现：

- `blueprint_parse`、`blueprint_encode` 只需要 `tools`。
- `blueprint_catalog`、`blueprint_generate` 还需要原生 `pluginManager` 和 `profileContext`。
- `blueprint_apply_order` 还需要 `sandboxPolicy`、`agentPresets`，并复用 `@deepseek-ai/dsh-sandbox` 的原生审批入口。

Creator 提示指引是可选的：随 `systemPrompt` / `agentPresets` 可用时注册，且只在 Creator 注入。只读页面在 Connection、WebServer 和 profile 服务都可用时才挂载，UI 注册到 npm 包名对应的 `plugins.bundle.config`，不需要宿主工具栏补丁。

## 原生执行与安全边界

安装、更新、启用、停用、卸载都交给原生 `plugin_manager`，Blueprint 不重复实现安装器。Agent 依据实际核实过的元数据和你的意图自主选择版本与顺序；一旦选中的版本与蓝图记录的精确版本不同，必须报告差异，且不改写原蓝图。

顺序工具只重排已经选中的 bundle。它拒绝遗漏、重复、未知名称、过期状态和受保护位置的变动。它先通过与原生管理工具相同的 danger-full-access 权限／单次审批闸门，再依次使用官方文件锁、原子 manifest 保存和可选的 HMR 排他队列。顺序始终是：先安装／启用，再读取新的 catalog 与 stamp，最后提交新顺序。

保存配置和运行时真正生效是两件事。有 HMR 时重新读取完整 patch 层并协调激活；只在启动时加载的环境会报告需要重启。应用失败可能留下已保存的配置或部分运行时变化。这里没有跨插件事务、自动回滚或对变更操作的重试。响应丢失后先核对当前状态，不要重放。状态 stamp 覆盖 manifest 与 bundle 目录，不是每个 patch 文件内容的完整版本号。

Agent 的自主归并不豁免包脚本审批、精确插件／运行时兼容性风险授权，也不授予蓝图元数据里要求的任何其他权限。分享码不提供签名、加密或作者认证；蓝图中的描述是数据，不是执行指令。

## 插件发现与默认配置

发现候选插件时，可以使用 [`@klarkxy/dsh-dev-index`](https://www.npmjs.com/package/@klarkxy/dsh-dev-index) 的 `dsh_plugins_search` / `dsh_plugins_fetch`，并逐个核实精确版本与 bundle 声明。搜索结果和声明的兼容性都不是运行验证。不要猜测版本，也不要悄悄更换来源。蓝图只支持 `npm` 与 `builtin` 身份，不包含 git/tarball、本地链接、设置、凭据或组件行。

可复用的默认配置应放在原生组合／preset 包里，并明确写出组件行。仅安装依赖不会递归启用每个依赖 bundle。后层优先，行补丁替换整段 `config`，不是深度合并；profile 和 home 覆盖仍然有效。不要把密钥或本机私有数据打包成默认配置。

## 格式与兼容性

[协议](PROTOCOL.md)定义字段、编码、限制和测试向量。`DSHBP2` / `formatVersion: 2` 保持不变，旧蓝图码仍可严格解析；Creator 自主归并是新的执行策略，旧页面 `preview` / `apply` / `result` 端点已移除，而不是静默把追加式执行改成重排。

DSHBP2 只传输插件组合：精确包身份加请求启用的 bundle 顺序；DSHBP1 另外传输配置预设和本机输入声明。两种格式互不转换，也都不是环境备份。

```json
{
  "kind": "dsh-blueprint",
  "formatVersion": 2,
  "metadata": { "name": "Example" },
  "packages": [{ "name": "example-plugin", "version": "1.2.3", "source": "npm" }],
  "bundles": ["example-plugin"]
}
```

上面的包名只用于展示协议结构。设置、凭据、组件行状态和嵌套蓝图不随蓝图码传输。蓝图码是固定前缀 `DSHBP2:` 加上 raw-DEFLATE 压缩的 UTF-8 JSON，再编码为无填充的规范 Base64url。上限：输入 2 MiB，解压后的 JSON 1 MiB，容器最多 64 层。严格解析会拒绝重复成员、不安全数字、原型键、非法 Unicode、非规范 Base64url 以及压缩数据后的尾随字节。

本包的公开能力分为协议操作、双格式文档处理，以及旧格式兼容三层。协议字段与编码以 [PROTOCOL.md](PROTOCOL.md) 和 [docs/blueprint.md](../../docs/blueprint.md) 为准；此处不复制入口导出清单。

## 开发与安装源码包

```sh
cd packages/blueprint
npm install
npm test
npm run build
npm pack
# 使用 npm pack 实际输出路径，并明确目标 profile：
dsh plugin --profile <目标profile> add <归档绝对路径>
```

官方包由宿主运行时提供：本插件只把它们声明为可选 peer 并使用开放下界，不捆绑自己的副本。当前源码对齐本机官方 CLI `0.2.1-rc.2`；此前 `0.1.7-rc.2` 的历史证据单独保留在 [ACCEPTANCE.md](ACCEPTANCE.md)。测试使用隔离目录，不会碰真实 profile；语法和离线契约检查不等于真实宿主验收。

## 供 Spaces 与其它工具使用的协议接口

只处理插件组合的工具可以直接使用独立的 v2 API。文档层同时校验两种受支持的格式，并给出已校验数据的只读投影；持久化与分享时保留它返回的文档。在环境允许时，文档层可用于浏览器侧代码；DSHBP1、DSHBP2 与 JSON 的编解码在 Node 侧进行。未知版本明确报错，不做猜测。

完整旧格式（配置预设）接口继续提供，供仍在生成或读取它的工具使用。Spaces 通过这些公开接口处理空间创建、隔离和安装；独立插件的 Creator 仍使用 v2 合并当前 profile 的语义。插件组合导出不携带配置和用户数据。

MIT 许可。原编解码器的版权归属保留在 [NOTICE.md](NOTICE.md)，许可证文本见 [LICENSE](LICENSE)。
