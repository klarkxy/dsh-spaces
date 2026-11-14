# DSH Spaces

Spaces uses the project package identity `@dsh-spaces/plugin`. Third-party authors keep their own npm packages and can submit them to the [public plugin catalog](catalog/README.md); users can browse the catalog or install by npm package name. See [npm publishing](docs/npm-publishing.md) for the maintainer release workflow. The current candidate is not yet published.

[![XERJ Corpus Hub contributor](https://hub.xerj.org/contributors/klarkxy/badge.svg)](https://hub.xerj.org/contributors/klarkxy)

**DSH Spaces is a multi-space plugin for compatible DSH Web and Desktop hosts. There is no standalone client.**

It adds a space rail to the existing application, runs each ordinary space in its own DSH process, and keeps management in one Supervisor per Home. The original application remains available; ordinary spaces do not become second managers.

## Current documents

- [Current architecture](docs/architecture.md) — roles, data ownership, control/data flows, availability and extension boundaries.
- [Workbench guide](docs/workbench.md) — lifecycle, models, backups, upgrades and diagnostics.
- [Standard installation](docs/plugin-standard-install.md) — installation, linked development and removal.
- [Management contract](tasks/merge-contract-v2.md) — protocol 2, tasks, plans and concurrency.
- [Workbench API surface](docs/workbench-api-surface.md) — public management wire semantics.
- [Host embedding contract](docs/host/embedding.md) — presentation, origin and Desktop limits.
- [Space control contract](docs/space-control-design.md) — main-space Creator and space-control tools.
- [Fault policy](docs/let-it-crash.md) — the sole authority for failure and recovery behavior.
- [Changelog](CHANGELOG.md) — release history.
- [Blueprint](docs/blueprint.md) — DSHBP1/DSHBP2 protocols. Spaces blueprint workflows are currently sealed; the independent package remains available.

## Data and identity

- `web` remains the original home profile. Spaces does not patch or migrate its sessions and storage.
- An ordinary space exists only after creation in Spaces. Its profile is `profiles/space-<name>`, its data is under `hub/space-<name>`, and membership comes from `hub/spaces.json`.
- Spaces does not scan, adopt or modify unrelated profiles.
- `spaces-hub` is the dedicated manager profile, not the main space and not an ordinary deletable space.
- Main-space settings and credentials stay in the main host; Spaces does not copy or migrate that settings document.

## Runtime behavior

Protocol 2 mutations carry a service epoch and expected revision. Requests and plans are rechecked at execution; refreshing reads existing jobs instead of replaying them. Closing a tab does not stop spaces or the Supervisor. A Supervisor started by official Desktop exits with that Desktop instance via one normal shutdown (stopping its managed spaces and releasing its lease); if shutdown fails, the state and lease remain untouched without force-kill or retry. A Web-started Supervisor or an existing Supervisor attached by Desktop stays running. Stopping all spaces and stopping the service are separate actions.

Each ordinary space calls its models with its own configuration. Choosing the main space's models copies its routes, default model and their keys once at creation; the General tab of space detail shows the saved model state and can sync again. The confirmation previews non-secret names and counts, then stops an active space, verifies the write and restarts only a space that was already running. Login-grant and expression routes are reported and skipped. Session selections and local defaults keep their own precedence. See [Model configuration](docs/architecture.md#6-模型配置).

The main space's `cordis` preset also exposes the Creator four-tool set and the space-control tools (`spaces_overview`, `spaces_inspect`, `spaces_logs`, `spaces_templates`, `spaces_import_preview`, `spaces_plan`, `spaces_execute`, `spaces_control_job`, and the `spaces_ui_*` session tools). They use separate authenticated scopes; mutation plans require explicit approval and are never a management bypass for ordinary spaces.

Failures are recorded with their actual stage and known cause, or explicitly marked unknown. Spaces does not automatically retry, restart, reconnect, roll back, restore, repair or replay interrupted work. The bounded Desktop service-start/restart exception is defined only in the [fault policy](docs/let-it-crash.md).

Unregistered manual DSH processes are outside managed discovery and shutdown. Home backups therefore guarantee only the consistency scope of known, stopped managed spaces, not every possible external writer.

## Install and upgrade

The next release is **0.5.0**, delivered as the prebuilt Spaces plugin for an existing DSH host. Browser Space and Spaces blueprint entry points are withheld. See the [release notes](docs/releases/v0.5.0.md) for the supported scope and transition from the old standalone distribution.

Build and pack the prebuilt plugin, then install it into the existing host profile:

```powershell
pnpm run pack:plugin
dsh plugin --profile web add <printed-tarball-path>
dsh web
```

In ordinary Web, open **Workbench / 工作台** and choose **Initialize Spaces / 初始化 Spaces**. That initialization is one explicit request; a later page load does not silently resume a failed request. Official Desktop starts the management service in the background when the application opens and leaves the main window usable. After a failed launch or a normal stop, the host does not automatically request another launch. Opening the application again, or the existing confirmed manual service action, starts a new operation. Refreshing the panel only rejoins the current Home record.

To upgrade, install the newer host plugin, stop the Spaces service from the manager, and reopen Spaces. There is no in-app self-update or launcher handoff. Each ordinary space pins an exact DSH runtime; the manager follows the host runtime.

Node.js 24.21+ (24.x) and 26.x are supported. New managed toolchains default to Node 26.10.0. The default DSH CLI for new installations is **`0.2.2-rc.1`**; `0.2.0-rc.2` is the minimum supported space runtime. See the [installation guide](docs/plugin-standard-install.md) for exact package and platform limits.

## Develop

```powershell
npm install
node scripts/setup-sandbox.mjs
npm run build
npm test
npm run dev:web
```

`npm install` uses `--legacy-peer-deps` via the committed [`.npmrc`](.npmrc). `@klarkxy/dsh-dev-index` declares `@deepseek-ai/*` peers such as `>=0.2.0-rc.2`; npm's default peer gate excludes prerelease versions the range does not explicitly name, so it rejects the pinned `0.2.2-rc.1` toolchain even though the official DSH compatibility check (`includePrerelease`) accepts it. Do not replace the flag with `--force`, which would mask conflicts rather than describe this one prerelease peer contract. The runtime `dsh plugin add` flow installs into managed profiles with pnpm and is unaffected.

Development uses an isolated Home. Never target the real `~/.dsh`, default `sessions/` / `storages/`, or `profiles/web/`. `npm run dev:link` prepares the linked development profile without starting the host. Rebuild and explicitly restart the host after changes; Supervisor changes also require a normal service shutdown and reopen.

The plugin and scoped packages are local prebuilt artifacts unless their individual documentation says otherwise. Publication and marketplace listing are separate release actions.

## License

MIT. See [LICENSE](LICENSE).

---

# DSH Spaces（中文）

**安装在兼容 DSH Web / Desktop 中的多空间插件，没有独立客户端。**

它在原应用内增加空间栏，每个普通空间使用独立 DSH 进程，每个 Home 只有一个 Supervisor 持有 Spaces 管理写权。原应用保留，普通空间不会变成第二个管理器。

## 文档入口

- [现行架构](docs/architecture.md)：角色、数据所有权、控制/数据流、可用性与扩展边界。
- [工作台说明](docs/workbench.md)：生命周期、模型、备份、升级与诊断。
- [标准安装](docs/plugin-standard-install.md)：安装、链接开发与卸载。
- [管理合同](tasks/merge-contract-v2.md)：协议 2、任务、计划与并发。
- [工作台 API 语义](docs/workbench-api-surface.md)：公开管理 wire 语义。
- [宿主嵌入合同](docs/host/embedding.md)：展示、来源与 Desktop 边界。
- [空间总控契约](docs/space-control-design.md)：主空间 Creator 与空间总控工具。
- [故障政策](docs/let-it-crash.md)：唯一的失败与恢复边界。
- [变更记录](CHANGELOG.md)：发布历史。
- [蓝图](docs/blueprint.md)：DSHBP1/DSHBP2 协议。Spaces 内蓝图工作流当前已封存，独立蓝图包保留。

## 数据与身份

- `web` 保持原始主 profile，Spaces 不改写或迁移它的会话和存储。
- 普通空间只能在 Spaces 中创建；profile 为 `profiles/space-<name>`，数据位于 `hub/space-<name>`，成员资格以 `hub/spaces.json` 为准。
- 不扫描、收养或修改无关 profile。
- `spaces-hub` 是专用管理空间，不是主空间，也不是可删除的普通空间。
- 主空间设置和凭据留在主宿主；Spaces 不复制、不迁移该设置文档。

## 运行语义

协议 2 的变更携带服务纪元和预期状态版本，请求与计划在执行时重新校验。刷新只读取原任务，不重放。关闭标签不会停止空间或 Supervisor。由官方 Desktop 启动的 Supervisor 跟随该 Desktop 退出：Desktop 宿主进程结束时，Supervisor 执行一次正常关闭（停止它管理的空间、释放运行权后退出）；关闭失败时保持原样并保留运行权，不强杀、不重试。由 Web 启动的 Supervisor 不受影响；Desktop 附着到已有 Supervisor 时不改变它的生命周期。停止全部空间与停止服务是不同操作。

每个普通空间用自己的配置调用模型。创建时选择主空间模型，会把主空间的路由、默认模型和对应 Key 复制一次到新空间；空间详情的“常规”页持续显示已保存的模型状态，并可再次同步。确认框展示不含凭据值的名称与数量。运行中的空间通过自身设置接口写入并保持运行，下一次模型请求使用新配置；已停止或异常退出的空间直接写入配置文件。启动中或停止中的空间需等待状态稳定后再同步。登录授权型和表达式路由会列出并跳过。会话选择和本地默认保持各自的优先级。见 [模型配置](docs/architecture.md#6-模型配置)。

主空间的 `cordis` preset 还提供 Creator 四工具及空间总控工具（`spaces_overview`、`spaces_inspect`、`spaces_logs`、`spaces_templates`、`spaces_import_preview`、`spaces_plan`、`spaces_execute`、`spaces_control_job` 和 `spaces_ui_*` 会话工具）。它们使用独立认证 scope；变更计划必须显式审批，不能成为普通空间绕过管理边界的通道。

失败按真实阶段和已知原因记录，无法确定时明确未知。不自动重试、重启、重连、回滚、恢复、修复或续跑。Desktop 手动服务启动/重启例外仅以[故障政策](docs/let-it-crash.md)为准。

未登记的手工 DSH 进程不属于可发现、可停机范围。Home 备份只保证已知受管空间停止后的一致性范围，不保证所有潜在外部写者均已停止。

## 安装与升级

下一版本为 **0.5.0**，通过预构建插件安装到已有 DSH 宿主；Browser Space 和 Spaces 蓝图入口暂不开放。[发布说明](docs/releases/v0.5.0.md)列出本版范围及旧独立桌面发行方式的变化。

```powershell
pnpm run pack:plugin
dsh plugin --profile web add <实际输出的包路径>
dsh web
```

普通 Web 打开 **工作台**，点击 **初始化 Spaces**。初始化是一次明确请求，后续打开页面不会静默续接失败请求。官方 Desktop 在打开应用时后台启动管理服务，主界面保持可用。启动失败或正常停止后，宿主不会自动请求另一次启动。再次打开应用，或使用已有的确认式手动服务操作，才是一份新启动。刷新面板只是重新加入当前 Home 记录。

升级时更新宿主插件，在管理界面停止 Spaces 服务，再重新打开。没有应用内自我更新或启动器交接。普通空间固定精确 DSH 运行时，管理空间跟随宿主。

支持 Node.js 24.21+（24.x）和 26.x；新托管工具链默认 Node 26.10.0。新安装默认 DSH CLI 为 **`0.2.2-rc.1`**；普通空间最低运行时为 `0.2.0-rc.2`。具体包与平台限制见[安装说明](docs/plugin-standard-install.md)。

## 开发

```powershell
npm install
node scripts/setup-sandbox.mjs
npm run build
npm test
npm run dev:web
```

`npm install` 通过提交内的 [`.npmrc`](.npmrc) 使用 `--legacy-peer-deps`：`@klarkxy/dsh-dev-index` 声明 `>=0.2.0-rc.2` 这类 `@deepseek-ai` peer，npm 默认 peer 规则排除 range 未显式命名的 prerelease 版本，会拒绝已锁定的 `0.2.2-rc.1` 工具链，而官方 DSH 兼容检查（`includePrerelease`）接受它。不要用 `--force` 替代：那会掩盖冲突而非描述这一条预发布 peer 约束。运行时 `dsh plugin add` 在托管 profile 里走 pnpm，不受影响。

开发使用隔离 Home，禁止指向真实 `~/.dsh`、默认 `sessions/` / `storages/` 或 `profiles/web/`。`npm run dev:link` 只准备链接。修改后重新构建并显式重启宿主；Supervisor 变化还需正常停止服务后重新进入。

插件和各 scoped 包是否为本地预构建制品，以各自文档为准。发布和市场收录是独立动作。

## 许可证

MIT，见 [LICENSE](LICENSE)。
