# 空间总控扩展：安装、插件顺序、调试

> 状态：设计补充 2026-11-09，未实现。父设计见 [space-control-design.md](space-control-design.md)。故障政策只以 [let-it-crash.md](let-it-crash.md) 为准。官方行为以运行时 **DSH 0.2.2-rc.1**（Desktop `dsh-desktop-runtime` 与 tag `dsh-v0.2.2-rc.1` / `66491b05`）为准。当前官网文档未钉版本，只作索引，不覆盖 checkout。
>
> 本文件不改 `src/shared/control.ts`、`src/shared/creator.ts`、`src/adapters/node/supervisor/{creator,control}.ts`。下文 Creator 行号是本次只读所见，施工中的文件以合并后的源码为准。

## 1. 两条写者，不能同时写同一 profile

| 路径 | 谁写 profile | 空间状态 | 已有能力 |
| --- | --- | --- | --- |
| A. Supervisor | 停掉子进程后，`dsh plugin` / 原子写 / toolchain | 停止，或尚未启动 | maintenance `plugin.install`、Creator 建空间安装、`space.runtime.set`、product 导入 |
| B. 子空间 `@Remote` | 子进程内 `pluginManager`，与 CLI 共用 profile 写锁 | 必须在跑，且 generation 仍是计划里的那一次 | `installBundle` / `updateBundle` / `setPluginEnabled` 等 |

官方经理把 pnpm 放在 HMR 队列之外，CLI 与服务共用 manifest 写锁（`dsh-plugin-manager` README「Understand the implementation」）。锁只串行官方写者。Spaces 的导入 `writePatch` 是直接 `atomicWrite` `cordis.patch.yml`（`workbench-products.ts:554-556`），不经该锁。子进程活着时，Supervisor 再改同一 profile，会和 HMR 监听、Config Editor 的锁交错。

规则：一个 control 计划只选一条路径。路径 B 失败不改走路径 A，路径 A 停不掉就不写。不自动启动来凑路径 B。

会撞车的具体情况：

- 子进程活着时，Supervisor 再跑 `dsh plugin add/remove`。官方锁能让后一个写者等待（`lockWaitMs` 默认 120 秒），但 `updateBundle` 自己就是「先卸再装」两次操作，中间可以插进另一次写（plugin-manager README Known Limitations）。control 不制造这扇窗口。
- 导入和隔离 patch 的 `atomicWrite` 不拿经理锁。现有导入发生在 `start: not-run` 之前，所以今天不和子进程重叠。控制面不得把「写 patch」接到一个已经在跑的 generation 上。
- Creator 的 `writeBuildPolicy` 在空间启动前写 `pnpm-workspace.yaml`（`creator.ts:792-812`）。路径 B 改由 `installBundle` 的 `approvedBuilds` 让子进程自己记；两边不要对同一 profile 各写一次。
- 停机失败、所有权不明、维护中断：沿用 let it crash，不改文件（`let-it-crash.md:9-21`）。计划里的「先停」若停失败，安装步骤保持 `not-run`。

`pluginManager` 方法表（主空间 Host 目录导出，`4b92d3a02cf7-cordis_inspect_query.txt:1188-1235`）没有 `reorder`。`configEditor`、`hmr`、`inspector`、`profileContext`、`tools` 的方法都没有 `@Remote`（同文件 378-390、903-935、1302-1316、2213-2248）。

## 2. 安装

### 2.1 现状

**npm 精确版，空间可先被停掉再装（路径 A）。** `plugin.install` 只收 `catalogId` + 精确 `version`（`workbench.ts:180`，`validation.ts:25-32`）。`rejectRawSpec` 拒绝 `file:`、`git+`、`github:`、`http(s):`、路径和 `..`（`validation.ts:183-201`）。执行前停掉正在跑的目标，再 `dsh plugin add` 本地 tarball，读回，先前在跑的再启动（`plugin-batch.ts:134-193`）。目录未命中时现拉 registry tarball 进 hub library（`core.ts:323-352`）。这不是官方 `updateBundle`：没有「装失败则装回旧版」。

**GitHub commit 与 allowBuilds，只在 Creator 建空间（路径 A，空间还没启动）。** 来源是 npm 精确版或 `github:owner/repo#40位sha`，子目录为 `#sha&path:/子目录`（`creator.ts:240-267,441-449`）。安装前把调用方点名的 `allowBuilds` 写入该 profile 的 `pnpm-workspace.yaml`，并写上 `dangerouslyAllowAllBuilds: false`（`creator.ts:542-549,792-812`）。键只允许包名或 `name@version`（`shared/creator.ts:201-216`）。失败把 pnpm 报告的 pending 键放进错误文本，不自动批准、不重试（`creator.ts:551-567`）。maintenance 的 `plugin.install` 没有这条审批。

**插件市场 / catalog 是两套目录。** Spaces 的 `catalog.refresh` 与 `plugin.download` 写入 hub catalog 和 library（`workbench-product.ts:102-109`，`workbench-products.ts:421-448`）。下载不安装。官方 `pluginMarket` 是子进程里的另一套索引：`listIndexes`、`search`、`readEntryDetail` 为 `@Remote`；`entry()` 不是（inspect 导出 1239-1256）。`setIndexes` 也是 `@Remote`，会改子空间自己的市场配置。

**本地 library。** `setSpacePlugin` 用 library 条目做 `plugin add`，关掉则 `plugin remove`（`plugin-ops.ts:845-884`）。它不是「禁用一行」，而是装上或卸掉包。

**更新版本。** 官方 `updateBundle(name, version)` 只存在于路径 B（inspect 导出 1216；README：仅 registry、可升级、比当前新；HMR 下先卸再装，失败会尝试装回旧版；无 HMR 则 `restart-required`）。Spaces 没有同名计划。`runtime.install` / `runtime.upgrade` 已是 `workbench/unsupported`（`validation.ts:71-73`）。给空间换 DSH 版本走已有 `space.runtime.set`：不够低、禁止降级、缺了才 `runtimes.install`，在跑则先停再钉版本，原来在跑才再启动（`runtime.ts:18-116`）。

**从模板 / 分享导入。** `template.create` 与 `space.import` 走 `applySpaceRecipe`（`workbench-products.ts:477-523`，`space-recipe.ts:197-274`）。顺序是：创建空间 → 可选写入隔离后的 patch → 只自动安装「npm + 精确版本 + installSpec 一致」的插件 → **不启动**。git / manual / 非精确版本进 `pendingManual`。定义失败、插件失败、未执行分开报告。已发布空间不回滚（`let-it-crash.md:83-84`）。`canonicalNpmInstallSpec` 拒绝宿主保护包和本管理器包（`space-recipe.ts:44-52`）。导入的 patch 还要过隔离检查，指向 `web` 或 `..` 的配置直接失败、原字节不动（`space-recipe.ts:55-70`）。

**官方 `installBundle` 合同（路径 B 必须照抄，不重写）。** 调用方自带 `requestId`。`plugin-manager/install-log` 流式输出，`install-state` 报 `installing` / `cancelling` / `applying`。`cancelInstall` 只在 git 检查或 pnpm 退出且文件已还原时为 `cancelled`；进入 applying 为 `too-late`；别的 id 为 `not-running`。失败或取消会还原 `package.json` 与 `pnpm-lock.yaml`，不还原 `pnpm-workspace.yaml`。pnpm 拦住脚本时，结果带 `pendingBuilds`；下一次才能带 `approvedBuilds`，且只能批准尚未决定的键，不能覆盖已有拒绝或通配（plugin-manager README）。`waitForInstall` 在调用结束前能补回同一次结果，结束后不保留，`null` 没有成功含义。

版本豁免 `setVersionExemption` 也是 `@Remote`（inspect 导出 1198），写入 profile 旁的 `compatibility.json`，不改依赖、不改 bundle 列表。授予要求 `acceptRisk`，且官方说明不兼容插件可能崩溃或丢数据。总控默认不暴露；要做也必须单独审批、单独计划，不能夹在 `plugin.install` 里顺带打开。

**启停粒度不要并成一个 toggle。** 父设计 P3 的 maintenance `plugin.toggle` 经 `setSpacePlugin` 装包或卸包（`validation.ts:38-47`，`plugin-ops.ts:845-884`）。官方 `setPluginEnabled` 只改最后一条匹配 override 的 `disabled`，包还在。官方 `setBundleEnabled` 改的是 `dsh.profile.bundles` 顺序。三件事的结果不同，计划 kind 必须分开，文案不能都写成「开关插件」。

### 2.2 路径怎么选

| 需求 | 用 A | 用 B | 不要 |
| --- | --- | --- | --- |
| 新空间 + npm/GitHub 精确来源 | Creator 同款校验与 `pluginAdd` | 空间还没进程 | 用 maintenance 的 `catalogId` 装 GitHub |
| 已有空间、npm 精确版、可停 | 现有 `plugin.install`（先停） | 在跑且要热装时 `installBundle` | 一边停一边打 Remote |
| 在跑时升级可升级的 registry 包 | 不做伪 `updateBundle` | `updateBundle` | 把官方「失败装回旧版」抄进 Spaces |
| 换 DSH 版本 | `space.runtime.set` | 无此 Remote | 复活 `runtime.install` 计划 |
| 模板 / 分享 | 现有 product 命令 | 无 | 导入成功才允许空间存在 |
| hub library / Spaces catalog | 停机后 `plugin add` 已下载的 tarball | 不把 Home 路径塞给子进程 | 把 hub catalog 当成 `pluginMarket` |

路径 B 的 `installBundle` 必须带调用方已批准的 `approvedBuilds`，由子进程自己记入 `pnpm-workspace.yaml`。Supervisor 不要在子进程活着时再写这份文件。官方页面对整组脚本一次批准，没有逐包选择（plugin-manager README Known Limitations）。control 的审批文案列出每一个 key；用户没点名的 key 一律不传。

### 2.3 建议的 control 面

在父设计 P3 的 `plugin.install` 上分开来源，而不是新造安装器：

- `plugin.install` 增加与 Creator 相同的封闭来源：`npm` 精确版或 `github` 全 sha。`catalogId` 仍只表示 Spaces catalog。GitHub 不走 `rejectRawSpec` 那条旧 kind，另作校验（父设计 D4）。
- `plugin.installFromLibrary`：`libraryId` 必须是 hub library 已有条目；执行前空间已停止；规格只来自库记录，不接受调用方路径。
- `plugin.update`：仅路径 B。参数 `spaceId, packageName, version, requestId`。空间未运行 → `control/not-running`。官方结果原样返回（`applied` / `restart-required` / `failed` / `restore`）。`restore` 是官方经理的行为，Spaces 不再包一层回滚。
- `runtime.set`：复用 `space.runtime.set`。不新增「安装运行时但不钉到空间」。
- `space.import` / `template.create`：复用 product 预览与一次性 `importId`。计划冻结模板 id 或 import 指纹。执行不启动。`pendingManual` 是结果，不是失败后的自动补装。

审批：安装、更新、换运行时、导入各一次 `danger-full-access`。文案含空间、精确来源或版本、`approvedBuilds`、会不会停空间。只读的 catalog/library/market 列表不审批。`pluginMarket.setIndexes` 会改子空间配置，默认不暴露。

停止要求：路径 A 的安装与 `runtime.set` 要求目标已停，或计划里写明先停且停成功才写。路径 B 要求目标在跑，且 execute 时 generation 与计划一致，否则 `control/request-conflict`，计划消耗、不提交。

## 3. 调整插件顺序

### 3.1 顺序由什么决定

Loader 方言（本机 `cordis-composition-reference` skill，以及 app-boot README 63-64 行）是：

- 若干 patch 层按顺序叠上去。`insert` 追加行；带 `id` 时追加进该 `group` 的 `config`。
- 只有 `id`、没有 `insert` 时，整字段替换已有行；`config` 整份替换，不深合并。
- 没有 id 的非 insert，或找不到目标，告警并跳过。
- 后层压过前层。bundle 按 `package.json` 里 `dsh.profile.bundles` 的顺序拼接；其后是 profile 的 `cordis.patch.yml`，再是 Home 的同名文件（Home 更后、更优先）。调用参数 overlay 还在其后（`profileContext.overlays`，无 `@Remote`）。

本机 skill 与 app-boot 说明里没有 patch 键 `before` / `after` / `order`。仓库里名为 order 的实现是空间注册表顺序，不是插件行顺序（`registry.ts:14-16,102-108`；`space.reorder` 在 `space-commands.ts:104-109`）。`loader.update(..., position?)` 只在进程内挪条目（loader README API 表），不写回 patch，也不是 `pluginManager` 的方法。

启用 bundle 会把该包追加到 `dsh.profile.bundles` 末尾，从而改变层的优先级（plugin-manager README「Use this package」）。这不是「把某一行移到另一行前面」。`updateBundle` 在 HMR 下失败回装时，也可能把该 bundle 放到选择列表末尾（同 README Known Limitations）。

`pluginInventory/list` 按加载顺序返回行，含 id、模块名、有效 enabled、fiber phase（`dsh-host-plugin-inventory` README 12、28-44 行）。它是 Remote，且 README 写明不能改顺序、也不指出条目来自哪一层。本次主空间服务目录导出没有 `pluginInventory` 键；子空间是否挂载，调用时才知道。

### 3.2 可行与不可行

| 做法 | 结论 |
| --- | --- |
| 官方 reorder API | **未找到。** 不发明。 |
| 手写 `cordis.patch.yml` 重排 | 不可。直接写绕过经理锁与 `!!js`/注释保留；和在跑的 HMR 冲突。 |
| 停机后用 Config Editor 改顺序 | Config Editor 只改活动 profile patch 里、根 Include 能唯一寻址的条目配置（config-editor README 67-69），方法无 `@Remote`，不管顺序。 |
| 先 `setBundleEnabled(false)` 再 `true` 把层甩到末尾 | 官方副作用，不是排序 API。失败可能停在未选中。control **不提供**这个操作。 |
| 只读当前顺序 | 在跑：`pluginInventory/list`（未挂载则如实 `unavailable`）加 `pluginManager.listPlugins/listBundles`。已停：不启动；不把 `--dump-config` 全文塞进工具结果（体积与 `!!js`）。P1 的 `detail()` 插件名版本列表不够表示加载顺序。 |

因此「调整子空间插件顺序」在 0.2.2-rc.1 **没有可推荐的写路径**。控制面只增加只读顺序。用户要的优先级变化，仍通过安装/启用官方已经定义的层语义发生，并在结果里说明「新启用的 bundle 在选择列表末尾」，而不是接受一个 `order` 数组。

`space.reorder` 继续只排侧栏。它写的是 Spaces 注册表的 `order` 数组和每条 `meta.order`（`registry.ts:102-108`），不读、不写目标 profile 的 `cordis.patch.yml` 或 `dsh.profile.bundles`。总控若转发它，放在生命周期计划里，参数仍是空间 id 列表；不要把插件 entry id 放进这个命令。

只读顺序的返回要能让调用方看出「这不是重排结果」：每行最多 `entryId`、`name`、`enabled`、`fiberPhase`（在跑且 inventory 可用时）、`bundleName`（来自 `listBundles` 时）。没有层来源就省略，不填「未知层」这种猜测。`fiberPhase` 的 `null` 只表示当前没有活着的根 Fiber（inventory README：没启动过和已经卸掉都是 `null`）。停着的空间不返回 phase。

## 4. 调试

下表只区分「已认证 Web 客户端能调的 `@Remote`」和「同进程服务」。代理白名单外的方法一律不转发。Client 的 Slots 还要子空间浏览器页连着，Supervisor 没有那一页。

| 能力 | 0.2.2-rc.1 | 控制面 |
| --- | --- | --- |
| `pluginManager` 列表、`inspect`、`listVersions`、`registries`、`readBundleDetail` | `@Remote`（inspect 导出 1192-1234） | 在跑可读。`readBundleDetail` 有大小上限，再截到工具上限。 |
| `setPluginEnabled(id, enabled)` | `@Remote`（1219）。只改 profile patch 里最后一处匹配的 `disabled` | 与 Spaces `plugin.toggle`（整包 add/remove）不是一回事。在跑、每次审批。结果含 `applied` 或 `restart-required` / `overridden`。未运行不代写 patch。 |
| `setBundleEnabled` | `@Remote`（1222）。改 `dsh.profile.bundles`，启用即追加到末尾 | 默认不暴露。它改层优先级，不是单纯开关。 |
| `pluginInventory/list` | 包 README：Remote，加载顺序与 `failed` phase 及当前 fiber 诊断。无历史 | 在跑可读。导出里主空间未列出该服务；没有就 `unavailable`。 |
| `pluginMarket` 搜索与详情 | `@Remote`；`entry()` 不是 | 只读搜索可代理。`setIndexes` 不暴露。 |
| Cordis inspect（Service/Event/Config/Tool/Slots） | `dsh-tool-cordis` 是本进程工具，登记在 host runner。不是 `@Remote`。Client 查询要已连接页面 | **不代理。** 不把主空间的 inspect 结果当成子空间的。 |
| `configEditor.entries/configuration/edit` | 无 `@Remote`。与 HMR、manifest 锁串行；非法或更高层覆盖则不改文件 | **不读写。** 停机后也不手改 patch。 |
| `settings.update/replace/mutate` | `@Remote`（inspect 导出 1807-1816），但是设置命名空间，不是插件 `config` | 不拿来改插件配置。 |
| `hmr.*`、`getLinked`、dev link | `hmr` 无 `@Remote`。`pluginLinkDirectory` 是 Supervisor 对已校验绝对目录执行 `dsh plugin add`（`plugin-ops.ts:220-253`） | 不暴露 link 路径，不代理 `hmr`。dev link 留在现有组件对齐，不进总控工具。 |
| 启动失败阶段 / 插件归属 | Spaces 自己的阶段在 `start-failure.ts` 与 startup phase，不是 DSH fiber。官方 `StartupError` 能标插件，但是进程内对象。可选插件失败时进程仍在，`pluginInventory` 的 `failed` 才是归属；必需插件失败则进程退出，归属只能来自已捕获日志，没有就不猜（`let-it-crash.md:46-70`） | 读 Spaces 已有 diagnostics/logs 与 startup failure。不解析日志猜插件名。 |
| 运行日志 | product `diagnostics` / `logs`，有界、脱敏。父设计 `spaces_logs` | 保持 P1。不返回日志路径。 |
| Doctor | `doctor` 只读 `inspectHome`；`verify` 只跑 `--dump-config` 并对隔离断言。`unlock` / `recover` / `rollback` 为 unsupported（`packages/doctor/src/index.ts:33-50`，`let-it-crash.md:25`） | 只暴露 `doctor` 只读投影，Supervisor 进程内调用，不起子空间。不暴露 `verify` 的全文 dump。 |
| 子空间工具列表 | `tools.definitions/schemas` 无 `@Remote`，且随 agent scope 变化 | **不代理。** 不通过给子会话发 prompt 来列工具。 |

`sessionController` 的列表/搜索/事件等是 `@Remote`（inspect 导出 1447 起），已属父设计 P4/P5，本文不扩大会话写。

调试读面的代理白名单（在跑、只读、无审批）只到这些方法名：`pluginManager.listPlugins`、`listBundles`、`registries`、`inspect`、`listVersions`、`readBundleDetail`、`listVersionExemptions`；`pluginMarket.listIndexes`、`search`、`readEntryDetail`；若该代次确有服务，再加 `pluginInventory/list`。`listVersionExemptions` 只读。`setVersionExemption`、`setIndexes`、`installBundle`、`updateBundle`、`removeBundle`、`setPluginEnabled`、`setBundleEnabled`、`cancelInstall` 都不走这条只读白名单。

实验性 `dsh-experimental-inspector` 的 `ctx.inspector.cordis.getTree()` 与 CDP 调试端口是同进程或 loopback DevTools，不是控制通道。fetch 捕获默认含凭据（该包 README Security）。总控不打开 `--inspect`，不转发 DevTools URL。

Spaces 启动失败对外只有自己的阶段和脱敏原因（`start-failure.ts:37-62`）。阶段名来自 Supervisor（例如 prepare、cli、patch、start），不是官方表里的「模块导入失败 / 缺服务 / schema」。官方那张表（app-boot README「Startup and reload failures」）说明可选插件失败时进程可以继续、必需插件失败时启动退出；Spaces 没有把 `StartupError.entries` 接成稳定 DTO。在进程已经退出的情况下，插件归属写「未能归属到单个插件」，除非 inventory 或官方诊断对象真的在同一次活进程里读到了。日志尾部仍走父设计的脱敏上限。

## 5. 新增 op 与工具

父设计的 `read` / `plan` / `execute` 够用，不新开 URL 前缀。`ChildSessionClient` 白名单在父设计 §7 之外增加下面这些，仍按 (spaceId, generation) 换 cookie。

| 工具 | 参数概要 | 审批 | 空间必须 |
| --- | --- | --- | --- |
| `spaces_inspect` 增 `order`、`market`、`startup` | `spaceId` + section | 否 | `order`/`market` 要在跑；`startup` 用 Spaces 记录，停着也能读 |
| `spaces_doctor` | `{ spaceId? }`，缺省是 Home 只读投影 | 否 | 不要求子空间在跑 |
| `spaces_plan` 来源扩展 | `plugin.install` 的 npm/github/catalog/library；`plugin.update`；`plugin.setEnabled`；`runtime.set`；`template.create`；`space.import` | 否，只冻结 | 见 §2.3。导入要未过期的 `importId` 或模板 id |
| `spaces_execute` | 原 `{ planId, requestId }` | 一次 danger-full-access | 路径不符或 generation 变了就拒绝 |

`plugin.setEnabled` 的参数是 `{ spaceId, entryId, enabled }`。`entryId` 来自上一笔 `listPlugins` / inventory，不接受包名猜测。禁止对受保护包和本控制通道自己的管理行操作（沿用 `assertGuardedPackage` 与 `web`/`desktop`/`spaces-hub` 拒绝）。

不新增：`plugin.reorder`、`config.write`、`hmr.*`、`inspect.query`、`tools.list`、`market.setIndexes`、`bundle.reappend`。

## 6. 失败语义

- 路径 A 安装沿用 `mutatePlugins`：停成功才改；改完读回失败则作业失败并保留 journal，不把旧包写回去，不自动再启动来「验证」（`plugin-batch.ts:134-193`，`let-it-crash.md:76-88`）。
- 路径 B：`waitForInstall` 只等待官方仍活跃的同一次 `requestId`；返回 `null` 不解释成成功或取消（plugin-manager README）。`cancelInstall` 的 `too-late` / `not-running` 原样返回。不第二次安装。
- `updateBundle` 若官方结果是 `restore` 或仍失败，Spaces 不再安装第三次回退版本。
- 导入：空间已创建但插件失败 → `plugins: failed`，空间留着，启动保持 `not-run`。不删除空间来消掉失败。
- `plugin.setEnabled` 得到 `restart-required` 时，不自动重启。文案只陈述该状态。
- 批量仍是 A 成功、B 失败、C 不执行。cookie 交换失败即 `control/unavailable`，不换第二次。
- Doctor 与 inspect 只读失败就是读失败，不升级成修复。

## 7. 分期

| 项 | 放哪 | 原因 |
| --- | --- | --- |
| npm/GitHub 精确安装、allowBuilds、catalog 精确版、停机 library 安装、`runtime.set` | **扩 P3** | 父设计 P3 已含安装/启停/运行时；补的是来源和写者选择 |
| `plugin.update`（仅在跑） | **扩 P3** | 与安装同一审批和 generation 检查；不要单独假回滚 |
| `template.create` / `space.import` | **新 P6** | 创建空间，不是给已有空间热装；验收要分开定义/插件/不启动 |
| 只读加载顺序、`setPluginEnabled`（明确不是 reorder，也不是 `plugin.toggle`） | **新 P7 的只读一半可提前到 P1**；写 `setPluginEnabled` 放 **P7** | P3 的 toggle 会被误实现成改顺序或整包删除 |
| `pluginInventory`、market 只读、startup 投影、`spaces_doctor` | **P1 只读扩展**，可与 P7 同一批 | 都不写 profile |
| reorder、config 读写、HMR/dev link、cordis inspect 代理、工具列表代理 | **不做** | 无 `@Remote` 或无官方写 API |

P4/P5 不动。P6 依赖 P2 的计划/作业语义和现有 product 导入，不依赖 P5。P7 的在跑读面依赖 P4 的 `ChildSessionClient`，但只加白名单，不提前做会话发送。

各期验收仍在 `.sandbox` Home，不碰真实 `~/.dsh`。在父设计的检查命令之外，这三期至少要看到：

- P3：同一空间上，路径 A 的安装作业进行时，子进程已停；作业失败后 profile 保持失败现场，测试不要求包回到旧版本。GitHub 规格若被 `rejectRawSpec` 拒绝，算旧 kind 的正确行为，不能在新 kind 里放行非全长 sha。`approvedBuilds` 里的通配或 URL 在预览阶段就 `invalid-input`。
- P6：导入一个含精确 npm 与一条 git 插件的分享。npm 装上，git 留在 `pendingManual`，空间状态不是 running。定义不合法时 `profiles/` 下不出现新空间。
- P7：对在跑空间，`setPluginEnabled` 前后 `cordis.patch.yml` 的行序不变，只多或少 `disabled`。对停着的空间调用返回 `not-running`，patch 字节不变。`space.reorder` 不改变该 patch。不存在 `plugin.reorder` 的 op。

只读扩展可以和 P1 一起测：子空间未运行时 `order` 与 `market` 为 `not-running`，Doctor 仍返回，且响应里没有日志路径、cookie、token。

## 8. 待决

| # | 问题 |
| --- | --- |
| E1 | 子空间默认 web 模板是否挂载 `pluginInventory`。导出未证明。实现时对沙箱空间列一次 Remote；没有则工具报 `unavailable`。 |
| E2 | 停着的空间要看加载顺序时，`--dump-config` 是否只抽取条目 id 序列。全文 dump 含 `!!js` 与路径，默认不返回。 |
| E3 | maintenance `plugin.install` 与 Creator 的 GitHub/`allowBuilds` 是扩展旧 kind，还是新 kind。父设计 D4 仍开放。本文要求校验与 Creator 同一套，且不把 `github:` 塞进 `rejectRawSpec`。 |
| E4 | `plugin.update` 的包若官方判定 `not-updatable`（官方包、git、别名），错误码用 `control/unsupported`，不改走 `plugin add`。 |

## 9. 依据

- 运行时：`C:\Users\27837\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\package.json` 版本 `0.2.2-rc.1`。Host 服务目录：`4b92d3a02cf7-cordis_inspect_query.txt` 上列行号。
- 官方包 README（同一 checkout）：`@deepseek-ai/dsh-plugin-manager`、`dsh-config-editor`、`dsh-hmr`、`dsh-app-boot`、`dsh-host-plugin-inventory`、`dsh-tool-cordis`、`cordis-plugin-loader`、`dsh-experimental-inspector`。
- tag：`dsh-v0.2.2-rc.1` = `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。
- 本仓库：`validation.ts:25-73,183-201`；`plugin-batch.ts:16-193`；`plugin-ops.ts:206-287,845-884`；`runtime.ts:18-116`；`space-recipe.ts:44-71,197-274`；`workbench-products.ts:434-558`；`creator.ts:240-267,433-571,792-812`；`space-commands.ts:104-109`；`registry.ts:102-108`；`packages/doctor/src/index.ts:25-50,106-118`；`let-it-crash.md:9-33,76-88`；父设计 §5、§7、§9。
- 未验证：子空间进程里 `pluginInventory` 是否实际注册；`dsh plugin` 是否另有未写入上述 README 的 enable 子命令（本文不假定有）；官网当前页与 0.2.2-rc.1 的正文差异（以 checkout README 与服务目录为准）。施工中的 `control.ts` / `creator.ts` 若已改行号，以合并后的源码重新对一次 Creator 引用。
