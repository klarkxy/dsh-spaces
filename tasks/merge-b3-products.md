# B3 产品服务与共同配方（Grok 施工叶）

2026-09-20。本叶只交付独立产品服务和版本化配方流水线，不装配 Supervisor、不改协议/Host/UI、不写 Git。

## 交付接口

### `WorkbenchProductService`（`src/adapters/node/workbench-products.ts`）

`constructor(ports)`。`ports` 至少包含：

| 端口 | 作用 |
|---|---|
| `home` | 临时/授权 Home，构造时 `assertNotRealHome` |
| `observation()` | 读结果绑定的 `serviceEpoch` / `expectedRevision` |
| `managerId()` | 与 `web`、保留名一起禁止导入/导出/改写 |
| `listSpaces()` | 公开空间列表，只读 library 用它算 `installedIn` |
| `createSpace(input, ctx)` | 配方创建空间；ctx 来自统一 job |
| `installPlugin(spaceId, spec)` | 只安装配方算出的精确 npm spec |
| `llm(request)` | 导出/存模板走 `previewShare`；不调用模型 |
| `diagnostics(spaceId)` | 原样返回有界诊断 |
| `withWrite(label, action)` | 与主 Supervisor 同一把 `HomeOperationLock`，可重入 |
| `settingsChanged?` | 设置写入成功后通知 |
| `now?` | 导入 TTL 测试时钟 |
| `fetchImpl?` / `packGit?` | 现有 catalog/download 的 IO 注入 |
| `writePatch?` / `writeLlmShare?` | 默认真磁盘；测试可替换 |

方法：

- `read(request): Promise<WorkbenchProductResult>` — `settings` / `catalog` / `library` / `diagnostics` / `templates` / `share.export` / `share.previewImport`
- `execute(command, ctx): Promise<WorkbenchProductOutcome>` — `settings.update` / `catalog.refresh` / `plugin.download` / `plugin.library.remove` / `template.save` / `template.create` / `space.import`

写入只进 `ports.withWrite`。没有第二套队列或 job。读路径不写 catalog 缓存、不同步 library。

### `SpaceRecipe` 与 `applySpaceRecipe`（`src/core/application/space-recipe.ts`）

`SpaceRecipe { schemaVersion: 1, displayName, icon?, plugins, patch?, llm?, source? }`。模板是本机配方，分享 zip 仍是 formatVersion 1 可携包装。

`applySpaceRecipe`：校验目标名 → 隔离配置 → 创建空间 → 写 patch → 写 LLM 需求（只存要求，`mapped: false`）→ 按精确 npm spec 批量安装（首失败停止，后续不跑）→ `start: "not-run"`。定义失败不创建；创建后失败保留空间。

`src/main/space-share.ts` 的 `importSpaceArchive` 与 `src/main/space-templates.ts` 的 `createSpaceFromTemplate` 改为调用该流水线，原公开返回形状不变。

## 领域行为

- **设置**：只改 `portStart` / `portEnd` / `packageSource` / `catalogUrl`；磁盘上 locale/theme、quitBehavior 和未知字段保留。http catalog URL 拒绝，不改写成空。
- **目录**：本地读。缺缓存明确 `source: "seed"` 且不落盘。损坏缓存抛错。显式 `catalog.refresh` 走现有 `loadPluginCatalog({ refresh: true })`，失败不再回退种子。
- **library**：公开项只有 id/name/title/version/source/downloadedAt/installedIn。不含 tarball、原始 spec。使用中删除拒绝。
- **下载**：现有 `downloadPlugin`（精确版本、多版本缓存）。拒绝 URL/凭据、`file:`/本地路径、任意命令。
- **分享**：复用 parse/pack/export 与 `previewShare`。8MiB。浏览器只拿到无秘密检查后的 base64 和安全 `.dshspace` 文件名。
- **导入预览**：base64 大小、zip 路径/entry 尺寸、未知 schema、secret-free。内存暂存最多 16 份、5 分钟 TTL、绑定当前 `serviceEpoch`。`execute space.import` 用 `command.name`/`displayName` 消费一次；旧 epoch / 过期 / 已消费 / 不存在拒绝。job 只应存 id。
- **部分失败**：已创建空间保留；`ctx.result({ product: outcome, spaceId })` 后抛真实失败。定义成功但插件失败不返回整体成功。

## 主 Agent 复现后的边界修正

`.sandbox/repro-product-review.mts` 三类均已拒绝（不改 `plugin-library.ts`）：

1. **设置**：已存在的 `portStart`/`portEnd`/`packageSource`/`catalogUrl`/`locale`/`theme` 必须是合法类型。端口必须是整数 1024–65535（不 `floor`，NaN/float 拒绝），`portEnd >= portStart`，catalog 必须是空或 https。缺省字段可补默认；显式无效值拒绝并保留原字节。`settings.update` 先校验旧记录，损坏时不写。未知非目标字段保留。
2. **library**：逐条严格校验；无 `schemaVersion` 的旧布局兼容，未知版本/坏条目/重复 id 拒绝。读和 download/remove 写前都走该校验，避免底层 `readPluginLibrary` 吞错再覆盖。公开项仍不含 spec/tarball/绝对路径。
3. **模板**：`includeConfig` 在持久化前 `assertShareSecretFree`；含 `apiKey` 等秘密则拒绝，不删 secret 后保存。无秘密的本地配置留在 recipe 中，创建时写回。`publicSpaceTemplate` 投影掉 URL 凭据/本机路径 spec，不只 strip patch。

## 实测

未跑全套、未重装依赖。命令：

```text
npx tsx --test tests/space-recipe.test.ts tests/workbench-products.test.ts tests/space-share.test.ts tests/space-templates.test.ts tests/plugin-catalog.test.ts tests/llm-share.test.ts
npx tsx .sandbox/repro-product-review.mts
```

结果：上述测试 **89/89 pass**（原 77 + 本轮回归）。复现脚本三项均为 `rejected`。覆盖：

- 失败部分结果（定义 imported、插件 failed、空间保留、`ctx.result.product`）
- 损坏模板/目录/设置不覆盖原字节
- library/export/job 记录不含 tarball、base64、归档
- 导入 TTL / epoch / 重复消费
- 纯读不写 settings/catalog/library/templates
- 安装首失败停止
- 旧 `templates.json`（无 schemaVersion/recipe）与 share formatVersion 1
- 显式 catalog 刷新失败不回退种子；缺缓存仍可显示 seed

`npx tsc --noEmit -p tsconfig.node.json` 仍有协议叶未完成的 Supervisor/Host 错误（`product` 方法、`serviceEpoch`、已删除的 controller/recovery 命令等）。本叶源文件未出现在那些报错里。

## 与协议叶待整合

共享 DTO 侧已出现 `WorkbenchApi.product`、`WorkbenchCommand` 含产品命令、`WorkbenchJobResult.product`。本服务可被直接调用，但 **尚未接到唯一 Supervisor**。

协议/JobStore 仍缺：

1. **装配**：Supervisor 用同一把 `HomeOperationLock.run` 作 `withWrite`，把 `listSpaces` / `createSpace` / `installPlugin` / `llm` / `diagnostics` / `managerId` / `observation` 注入本服务。不要第二套 ProfileRegistry。
2. **读路径**：`WorkbenchApi.product(request)` → `service.read`。
3. **写路径**：产品 command 进现有 job 队列后 `service.execute(command, ctx)`。命令只许带 `importId`/名字等无秘密字段；不要把 archive/base64/raw config 写入 job 记录。
4. **`publicResult`**（`src/adapters/node/workbench-jobs.ts`）目前只复制 `spaceId` / `snapshotId` / `runtimeVersion` / `view`，**丢掉 `product`**。`parseStrictResult` 的允许键同样没有 `product`。
5. **失败 job**：handler 抛错后 JobStore 把 `current.result = undefined`。协议合同要求失败 job 保留安全的 `product`（定义/安装/启动/LLM 映射）和 `spaceId`。本服务已在抛出前调用 `ctx.result({ product, spaceId })`。
6. Host schema / HTTP 输入输出校验由协议叶负责；本服务做路径、大小、epoch/TTL 与空间保护。
7. 不要改正常快照创建/删除和安装 worker。

## 未做（按合同）

- 不装配客户端或 Supervisor
- 不写 Git、不读真实 `~/.dsh`、不改全局配置、不发布
- 不改 `src/shared/workbench-product.ts`
- 不改 `workbench.ts` / supervisor / http / jobs / Host schema / UI 及其测试
