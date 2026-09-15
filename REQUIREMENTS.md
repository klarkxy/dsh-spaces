# DSH Spaces — 需求文档

> 版本：1.0（2026-08-28 定稿）；现行故障政策：2026-09-15 [let it crash](docs/let-it-crash.md)
> 项目名：**dsh-spaces**（已核实 GitHub 无撞名）
> 一句话定位：**Spaces for DeepSeek Harness — 像切 Discord 服务器一样切换你的 DSH 工作空间。**
> 目标：社区开源产品（Windows / macOS / Linux）

> **最高优先级原则（2026-09-15）：** 插件自由组合，失败允许发生。Spaces 如实报告已知原因或明确未知，不提供自动或手动恢复（不重试、不自动重启/重连、不回滚、不恢复快照、不重装依赖、不自动改配置或禁用插件、不切换版本或实现、不进入安全/救援模式、不续跑中断任务）。用户主动的启动、停止、重启、安装、卸载和配置仍是独立操作，不由错误处理器代替发起，也不包装成“检查并修复”“恢复中断任务”。安全、隔离、输入与路径校验、单写者、原子写和有界资源释放继续有效。校验失败拒绝并说明原因，不自动纠正。一个插件报错不要求杀掉整个应用。完整正文只维护在 [docs/let-it-crash.md](docs/let-it-crash.md)。

> 2026-09-08 后续决策（历史）：以 `tasks/plan.md` 为新增施工契约。关闭窗口进入托盘、明确退出停止全部；全应用统一 DSH 版本，协调升级官方基础插件。其中“支持升级前快照恢复”及同类恢复、修补、失败回退要求，已由 2026-09-15 的 let it crash 原则取代，不再作为当前施工与发布门槛。`web` 仍不写隔离 patch、不迁移旧聊天，但明确的升级操作可更新其官方基础插件。本文历史技术实测对应 0.1.1-rc.2，不代表更新版本已验收，也不把当时的恢复实现改写成从未存在。

---

## 0. 故障与错误（现行）

插件错误、依赖冲突、配置不兼容、启动失败和进程崩溃都是允许结果。DSH Spaces 不承诺任意插件组合都能正常运行，也不负责把失败的环境修复成可运行状态。

- 失败按原有执行边界失败或退出。记录失败，并在仍可用的界面或本地输出中说明发生了什么、已知原因是什么。
- 无法确定根因或具体插件时写明未知，不猜测；不能把最近安装的插件直接认定为原因。
- 不提供故障后的自动或手动恢复流程。
- 提交前准备失败、未切换到新结果，不是回滚。提交后失败保留现场，不再把旧环境写回去。
- 历史记录：2026-08-28 定稿的隔离、生命周期与安全需求仍然有效。2026-09-08 写入的快照恢复、配置恢复、升级失败回退，不再是有效功能需求。

当前施工入口：[tasks/todo.md](tasks/todo.md)。运行时仍含旧恢复实现，直至 R1–R6；不得因此把恢复重新写成有效需求。

## 1. 背景与问题

DeepSeek Harness（下称 DSH）官方支持 profile：`$DSH_HOME/profiles/<name>/` 下的一套插件组合。
但现状是：

- 官方 profile 只隔离**插件栈**；会话（`sessions/`）、工作区分组（`storages/workspace.json`）、API Key 全部在 home 级共享。
- 切 profile 必须重启 harness 进程，没有任何 GUI 支持多 profile 的可视化切换。
- 想同时跑多个 profile 的用户会遇到端口冲突和**并发写坏数据**（JSONL 持久化是"每个 session 文件同一时刻只允许一个活的写者"；两个进程抢同一个 `workspace.json` 会 last-writer-wins，参见官方仓库 discussion #1485）。
- 社区已有 DSH-Launcher V3 等多实例内嵌界面产品。Spaces 的重点是共享身份下的工作台管理、分离会话存储以及兼容性检查，不以多开或内嵌界面作为独有能力。

## 2. 产品定义

一个**独立的桌面外壳应用**（不是 DSH 插件），把官方 profile 变成 Discord 风格的多工作空间：

- **左侧细窄图标栏（rail）**：每个图标 = 一个 profile。可自定义显示名和图标。显示运行状态。
- **右侧主区域**：内嵌当前选中 profile 的官方 DSH Web UI（原样，不修改）。
- **栏上快捷操作**：点击切换/启动，右键菜单提供重启、停止、设置等。
- **多开并行**：多个 profile 同时运行，各自独立进程、独立端口。

### 2.1 两类 profile（核心数据模型）

| | `web`（根 profile，唯一） | 工作台（其余全部） |
|---|---|---|
| 地位 | 钉在栏顶，相当于 Discord 的 Home 按钮 | 普通栏位 |
| 数据路径 | 官方默认（`$DSH_HOME/sessions/`、`$DSH_HOME/storages/`），**永不打 patch** | 独立数据根：`$DSH_HOME/hub/<name>/sessions`、`$DSH_HOME/hub/<name>/storages` |
| 历史数据 | **维护所有旧资源**：Hub 安装前的全部聊天记录、工作区分组都归它 | 全新开始，会话/工作区完全隔离 |
| 来源 | 首次扫描时收养，零写入 | ① Hub 新建；② 用户已有的非 web profile 首启时**自动转换**（补 patch，插件栈原样保留） |

**明确不做**：数据迁移功能、共享模式、多套 `DSH_HOME` 沙箱。旧聊天永远住在 `web` 里看。

### 2.2 隔离语义

- **隔离**（per-profile）：插件 bundle、`cordis.patch.yml`、会话、工作区分组视图。
- **共享**（home 级，官方原意）：API Key（`.credentials.yaml`）、`settings.yaml`、Agent 预设——一个机器身份，多套工作空间。
- **关键布局约束**：工作台数据根必须放在默认树的**兄弟目录**（`$DSH_HOME/hub/`），绝不能嵌在 `$DSH_HOME/sessions/` 下面——否则 `web` 的持久化扫描器会把工作台会话吃进去，隔离穿透。

## 3. 功能需求

### FR1 左侧栏（rail）
1. 展示全部 profile：`web` 钉顶，工作台按用户自定义顺序排列。
2. 每项显示：图标（用户自定义，默认取名字首字母）、显示名（悬停提示）、运行状态（停止/启动中/运行中/异常）。
3. 点击：已运行 → 右侧切到它的 GUI；未运行 → 启动并切换。
4. 右键菜单：重启、停止、重命名（仅改显示名）、换图标、打开 profile 目录、删除（需确认，删注册项和 hub 数据目录，官方 profile 目录是否删除让用户勾选）。
5. 栏底"＋"按钮：新建工作台向导（输入名字 → 选图标 → 自动执行创建流程）。
6. 显示名和图标存在 Hub 自己的元数据里（如 `$DSH_HOME/hub/spaces.json`），**永不改动官方 profile 文件夹名**。

### FR2 进程管理
1. 每个运行中的 profile 对应一个 `dsh --profile <name>` 子进程，Hub 分配唯一本地端口，`--no-open` 禁止弹浏览器。
2. 重启只影响该 profile 的进程，其他 profile 与 GUI 不受影响。用户从常规菜单主动启动、停止、重启，是独立操作，不是恢复承诺，也不由错误处理器代替发起。
3. Hub 退出时优雅关闭全部子进程（可配置：退出即停 / 保持后台）。
4. 进程崩溃要被侦测，并在栏上显示异常态与已知错误（空间、阶段、插件或未知、原因、退出码或信号）。不自动重启、不自动重连。错误页只提供错误详情和脱敏日志，不提供一键修复或恢复中断任务。
5. 同一 profile 禁止双开（Hub 内互斥；Hub 外用户手动跑 CLI 不在保证范围）。

### FR3 新建工作台
1. 通过官方 CLI 创建：`dsh plugin --profile <name> add @deepseek-ai/dsh-web-app`（自定义名字默认只带 `dsh-base`，必须装 web-app 才有 GUI）。
2. 创建后写入双 root patch（见 §5 技术契约）。
3. 名字合法性校验（目录名安全字符），与现有 profile 查重。

### FR4 已有 profile 自动转换
1. 首次启动扫描 `$DSH_HOME/profiles/`（忽略 `node_modules`）。
2. `web` → 收养为根，**零写入**。
3. 其余每个 profile → 自动转换为工作台：备份其 `cordis.patch.yml` 后追加双 root patch，插件栈不动。
4. 转换时必须向用户明确提示：**"你的历史聊天统一由 web 维护，工作台从全新会话开始"**（被转换的 profile 打开后会话列表是空的，用户可能误以为数据丢了）。
5. `headless` 等无 GUI profile：栏上显示但标记为"无界面"，点击不启动 Web UI（V1 可以直接不展示，二选一由实现者定，倾向不展示）。

### FR5 插件安装（Hub 安装器）
1. 对勾选的一个或多个 profile 执行 `dsh plugin --profile <name> add <spec>` / `remove <pkg>`。
2. Hub 内所有 plugin 命令**串行排队**，避免 pnpm 并发写 `profiles/node_modules` 回退链打架。
3. 发现层复用公开的 NanmiCoder catalog schema v1（MIT）：只对 `verified-npm` / `verified-git` 且带 `installSpec` 的条目一键安装。Renderer 只传 catalog id，主进程用自己的目录副本解析 spec。
4. 手动输入只接受 npm 包名或 `github:owner/repo`，不是 shell 命令。
5. 不把任何社区「插件市场」bundle 预装进 profile。插件栈仍按 profile 隔离。
6. 装完若目标 profile 正在运行，提示重启该进程（Hub 不热挂载）。

### FR6 设置
1. DSH_HOME 路径（默认 `~/.dsh`，可改）。
2. 端口范围（默认如 3100-3199）。
3. 退出行为、开机自启（V1 可选）。

## 4. 非功能需求（社区红线）

| # | 义务 | 具体要求 |
|---|---|---|
| NFR1 | 永不损坏用户已有 home | `web` 永不打 patch；任何写 `cordis.patch.yml` 前先备份原文件（如 `cordis.patch.yml.bak-<时间戳>`，这是提交前安全副本，不是产品恢复流程）；写文件必须原子（临时文件+rename）。提交前失败不替换原文件，不是回滚。提交后失败不得再把旧环境写回去。 |
| NFR2 | 版本漂移防护 | 每次启动某工作台前跑 `dsh --profile <name> --dump-config`，校验 `session-persistence-jsonl` 和 `storage-json` 两个 row id 仍存在且 patch 生效；校验失败 → **拒绝启动**并给出清晰提示，绝不静默用不安全配置起进程，也不自动改 patch |
| NFR3 | 并行安全有证据 | §6 的隔离验证脚本必须先跑通才允许开发 GUI；同一脚本进 CI 作为发布门 |
| NFR4 | 跨平台 | Windows / macOS / Linux；进程与端口管理抽象封装 |
| NFR5 | 隐私 | 不收集遥测；不上传任何用户数据 |

## 5. 技术契约（已在真实环境核实，2026-08-28，dsh 0.1.1-rc.2）

以下全部为本机实测确认的事实，实现时直接依赖：

### 5.1 CLI 接口
```
dsh --profile <name>            # 启动指定 profile
dsh --patch <path>              # 追加 patch overlay（可重复）
dsh --dump-config               # 打印组合后的配置树后退出
dsh --dump-default-config       # 不含用户层的配置树
dsh web [args...]               # --profile web 的别名
dsh plugin --profile <n> [args] # 转发给 profile 目录里的 pnpm
```
启动器 flag 之后的参数会传给 profile 的 app。web-app 启动 flag 已于 2026-08-28 实测确认（`dsh --profile web --help`）：

```
--host <host>                  bind host
--no-open                      do not open the Web UI in the default browser
--port <port>                  listen port; pass 0 to let the OS pick a free one
--trusted-host <authority...>  extra authority the /api browser-trust fence accepts
```

多开时每个进程必须带 `--no-open --port <unique>`。`--port 0` 由 OS 分配，Hub 不便预知，V1 用显式端口池（默认 3100–3199）。

### 5.2 profile 目录结构
```
$DSH_HOME/profiles/<name>/
├── package.json        # dsh.profile.bundles: 插件 bundle 有序列表
├── cordis.patch.yml    # 用户 patch 层：顶层 YAML 数组，id 定向覆盖，允许 !!js 表达式
├── cordis.yml          # 空入口（注释明确写着"不要编辑此文件"）
├── pnpm-lock.yaml / pnpm-workspace.yaml
└── node_modules/
```

### 5.3 必须覆盖的两个持久化 row（来自 `dsh --profile web --dump-config` 实测输出）
```yaml
- id: session-persistence-jsonl
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js dshHomePath('sessions')      # ← 覆盖为 dshHomePath('hub/<name>/sessions')

- id: storage-json
  name: '@deepseek-ai/dsh-storage-json'
  config:
    root: !!js dshHomePath('storages')      # ← 覆盖为 dshHomePath('hub/<name>/storages')
```
另外确认：`session-query-sqlite` 是 `:memory:`，无落盘，不需要处理。

### 5.4 数据目录实测形态
- `$DSH_HOME/sessions/`：按工作区路径编码命名的目录（两级结构），内含 `session.jsonl.zstd`（zstd 压缩 JSONL）。
- `$DSH_HOME/storages/`：`workspace.json`（工作区分组）、`session_projcache.json`（投影缓存，`writeIntervalMs: 5000`）。
- home 级共享文件：`.credentials.yaml`、`settings.yaml`、`.anonymous-user-id` 等——**全部不碰**。
- **工作台覆盖后**：会话落在 `$DSH_HOME/hub/<name>/sessions/`，`workspace.json` 和 `session_projcache.json` 都跟随 `storage-json` 根，落在 `$DSH_HOME/hub/<name>/storages/`。无需额外覆盖 projection-cache。
- 覆盖后的目录由 dsh 在首次写入时自动创建，脚本不必预先 mkdir。

### 5.5 patch 写法（已固化）

`cordis.patch.yml` 是顶层 YAML 数组。按 id 覆盖时**整份 `config` 被替换**（官方 web-app patch 注释原文），因此必须重写该 row 拥有的每一个 key。`session-persistence-jsonl` 和 `storage-json` 的 config 都只有 `root`，所以如下即可；`name` 可省略，`--dump-config` 仍会带上原 name。

```yaml
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('hub/<name>/sessions')
- id: storage-json
  config:
    root: !!js dshHomePath('hub/<name>/storages')
```

写完后用 `dsh --profile <name> --dump-config` 确认两处 `root` 已变成 hub 路径。`web` 禁止写入此文件。

### 5.6 创建 profile 的实测路径
- `web` / `headless`：首次 `dsh --profile web --dump-config`（或 `dsh web`）即从 CLI 自带模板自动初始化，bundles 为 `dsh-base` + `dsh-web-app`，**不必**再 `plugin add`。
- 其它名字：`dsh plugin --profile <name> add @deepseek-ai/dsh-web-app@<CLI版本>`。必须**钉死与 CLI 相同的版本**（本机为 `0.1.1-rc.2`）。
- **陷阱**：npm 上 `@deepseek-ai/dsh-web-app` 的 `latest` dist-tag 仍指向 `0.0.1-rc.1`，`next` 才是 `0.1.1-rc.2`。不钉版本会装到缺 `@deepseek-ai/dsh-code-runtime-worker` 的旧树并 404。Hub 创建工作台时必须读 `dsh --version` 再拼接 `@<version>`。
- 沙箱无 API Key 时 Web UI 可启动；`POST /api/session.create` 能建会话并落盘，不需要凭据。发消息才会失败。

### 5.7 Web API（隔离脚本使用）
- 默认 `http://127.0.0.1:3080`。TCP 端口就绪 ≠ API 就绪，需轮询 RPC 直到成功。
- 请求：`POST /api/<method>`，`Content-Type: application/json`，带与监听地址一致的 `Origin`。
- 信封：`{"type":"client-request","rpcId":"<uuid>","method":"<method>","payload":{}}`
- 成功：`{"type":"server-response","rpcId":"...","result":{"ok":true,"value":{...}}}`
- 建会话：`session.create` payload `{ cwd }`（与 `workspaceId` 互斥）；列会话：`session.list` payload `{}`。

## 6. 验收标准

| # | 场景 | 通过条件 |
|---|---|---|
| A1 | 根收养 | 首启后 `web` 在栏顶，旧聊天全部完好；`web` 的任何文件未被修改 |
| A2 | 自动转换 | 已有非 web profile 以工作台身份启动，插件栈原样、会话视图为空；其旧聊天在 `web` 中仍可见 |
| A3 | 多开 | `web` + 两个工作台同时在线，栏上三个都亮，右侧 GUI 跟随选中项 |
| A4 | 插件隔离 | 装进工作台 A 的插件不出现在工作台 B 和 `web` |
| A5 | 会话隔离 | 工作台 A 新建的聊天在 B 和 `web` 的侧边栏都看不见，反之亦然 |
| A6 | 身份共享 | API Key 填一次，所有 profile 可用 |
| A7 | 并行安全 | 并发使用下无 session 文件交叉写、无 workspace.json 互相覆盖（CI 自动验证） |
| A8 | 版本防护 | 人为改掉 row id 后启动工作台被拒绝且提示清晰，而非静默启动 |
| A9 | 单点重启 | 重启工作台 A，`web` 和工作台 B 的进程与 GUI 不受影响 |
| A10 | 身份覆盖层 | 改显示名/图标不改官方 profile 文件夹名 |
| A11 | 失败可见、无抢救 | 安装失败、启动失败或进程崩溃后，错误指向空间、阶段、已知包或明确未知；没有重试、自动重启、回滚、快照恢复、重装依赖、自动改配置或续跑中断任务。一个插件报错且宿主仍在时，不人为杀掉整个宿主 |

> A1–A10 的隔离与生命周期目标继续有效。历史上曾把快照恢复、配置恢复、升级回退、kill 后抢救列为通过条件的补充验收，已由 2026-09-15 let it crash 取代，不再作为发布门槛。

## 7. 明确不做（V1 排除项）

- 数据迁移（旧聊天搬进工作台）
- 多套 `DSH_HOME` / 沙箱机模式
- 把社区插件市场预装进每个 profile；跨 profile **共享一份插件栈**（批量对勾选空间执行官方 `plugin add` 可以）
- 把 Hub 做成 DSH Web 插件（插件跟着 profile 一起死，栏必须活得比任何 harness 进程长）
- 移动端
- 故障后的自动或手动恢复（重试、自动重启/重连、回滚、快照恢复、重装依赖、自动改配置或禁用插件、切换版本或实现、安全/救援模式、续跑中断任务）

## 8. 参考资料

- 官方文档：deepseekdocs.com（Boot & Configuration / Configuration / profile 目录）
- 并发写冲突证据：deepseek-harness 仓库 discussion #1485
- 单写者契约：`packages/session/session-persistence-jsonl/README.md`
- 竞品与调研全景：本仓库配套 canvas 简报（DSH Spaces product brief）
- 本机实测配置树：`web-dump-config.txt`（本仓库根目录）
