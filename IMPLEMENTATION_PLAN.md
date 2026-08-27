# DSH Spaces — 施工计划

> 版本：1.0（2026-08-28）
> 前置阅读：`REQUIREMENTS.md`（需求与验收）、`web-dump-config.txt`（本机实测配置树）
> 本文档面向执行工程师（AI 或人类），按阶段推进，每阶段有明确的完成判据。
> **铁律：阶段 0 不通过，禁止进入任何 GUI 开发。**

---

## 技术栈（已定，不再讨论）

| 层 | 选型 | 备注 |
|---|---|---|
| 外壳 | Electron + electron-vite + React 19 + TypeScript | 内嵌 GUI 用 `WebContentsView` |
| 样式/组件 | Tailwind CSS 4 + shadcn/ui | 复制式组件，零运行时依赖 |
| 动画 | Motion（原 Framer Motion） | rail 的 spring 指示条、layoutId 过渡、悬停变形 |
| 点缀 | Magic UI / Aceternity 选抄两三个 | 仅用于状态光效、onboarding |
| IPC | oRPC 或 tipc-electron | 渲染层 → 主进程的进程控制指令需类型安全 |
| 图标 | lucide-react | |
| 起手模板 | 参考 cperuffo3/electron-starter 或 daltonmenezes/electron-app | Tailwind 4 + React 19 兼容性已配好 |

**架构约束（Electron 特有）**：`WebContentsView` 是浮在渲染层 DOM 之上的原生视图，React 界面无法覆盖它。布局必须是「左栏（DOM）+ 右侧预留槽位（view bounds）」；弹窗/右键菜单要么开在左栏区域内，要么打开时收缩或遮盖 view。

---

## 阶段 0：隔离验证脚本（先决条件，纯脚本无 GUI）

**目的**：证明「双 root patch + 多进程并行」在真实 dsh 上成立。这个脚本之后直接变成 CI 发布门。

**绝对安全要求：全程使用临时沙箱 `DSH_HOME`（如 `D:\0 code\dsh-profile-hub\.sandbox\dsh-home`），通过环境变量 `DSH_HOME` 注入。绝不允许读写用户真实的 `~/.dsh`。**

步骤：

1. **摸清 web-app 的启动 flag**：已确认 `--host` / `--port` / `--no-open` / `--trusted-host`（见 `REQUIREMENTS.md` §5.1）。
2. **沙箱建家**：设 `DSH_HOME` 指向沙箱目录，创建 `web` profile（`dsh plugin --profile web add @deepseek-ai/dsh-web-app` 或首次 `dsh web` 自动初始化，实测哪种可行）。注意沙箱里可能需要跳过登录/凭据（实测确认 web UI 无凭据时的行为；验证会话写入不需要真的调 LLM——建会话动作本身就会落盘）。
3. **建两个工作台**：`coding`、`writing`，同样方式创建，然后在各自 `cordis.patch.yml` 写入双 root 覆盖：
   - `session-persistence-jsonl` → `root: !!js dshHomePath('hub/coding/sessions')`
   - `storage-json` → `root: !!js dshHomePath('hub/coding/storages')`
   - patch 语法以官方注释为准（顶层 YAML 数组、id 定向覆盖）；写完用 `dsh --profile coding --dump-config` 确认覆盖已生效（root 值变了）。
4. **三进程并行**：`web`、`coding`、`writing` 各占一个端口同时启动。
5. **各建会话**：通过各自的 HTTP 端点或 UI 自动化在三个实例里各创建至少一个会话（沙箱无有效 API Key 时，发消息会失败，但**会话创建与标题写入已足够产生落盘文件**；若连建会话都需要凭据，写入假凭据或复用环境变量方案，实测定）。
6. **验证隔离**（全部通过才算阶段 0 完成）：
   - `web` 的会话文件只出现在 `$DSH_HOME/sessions/`，`coding`/`writing` 的只出现在各自 `hub/<name>/sessions/`；
   - 三个 `storages` 树互不写入（尤其 `workspace.json`）；
   - `web` 的 UI/API 列不出工作台的会话，反之亦然；
   - 并发操作后无文件损坏（JSONL 可解析）。
7. **产出**：`scripts/validate-isolation.ts`（或 .mjs），可重复执行、自动清理沙箱、以退出码报告结果。把实测确认的 flag 名、patch 语法回填到 `REQUIREMENTS.md` §5。

**完成判据**：脚本绿灯 + 需求文档 §5 待确认项全部落实。

阶段 0 实测记录（2026-08-28）：`node scripts/validate-isolation.mjs --clean` 对沙箱三进程给出 `ISOLATION GATE: PASS`。`session_projcache.json` 跟随 storage-json 根，无需额外覆盖。创建非 web profile 必须钉 `dsh-web-app@<CLI 版本>`（npm `latest` 仍指向 `0.0.1-rc.1`）。

---

## 阶段 1：Electron 骨架 + 进程管理器（无 rail 视觉，功能先行）

1. 用模板起 Electron + React 19 + Tailwind 4 + shadcn/ui 项目，命名 `dsh-spaces`。
2. 主进程模块：
   - `ProfileRegistry`：扫描 `$DSH_HOME/profiles/`（忽略 `node_modules`），分类 root/workbench/headless；读写 Hub 元数据 `$DSH_HOME/hub/spaces.json`（显示名、图标、排序；原子写）。
   - `ProcessManager`：spawn `dsh --profile <name> ...`，端口池分配（默认 3100-3199），PID 跟踪，崩溃侦测（exit 事件 → 状态机 stopped/starting/running/crashed），单 profile 互斥，退出时优雅关停（先 SIGTERM/taskkill，超时强杀）。
   - `PatchWriter`：备份 + 原子写 `cordis.patch.yml`；`--dump-config` 校验器（NFR2：row id 不存在 → 拒绝启动）。
   - `ViewManager`：每个运行中 profile 一个 `WebContentsView`，加载 `http://127.0.0.1:<port>`，按选中项切换 bounds/挂载。
3. IPC 契约（oRPC/tipc）：`listProfiles / createProfile / startProfile / stopProfile / restartProfile / selectProfile / updateMeta / getStatus`（推送式状态更新）。
4. 临时调试 UI：一个纯按钮列表即可，验证全链路。

**完成判据**：调试 UI 上能创建工作台、三 profile 并行启动、切换右侧 GUI、单点重启互不影响（对应验收 A3、A9）。开发期一律用沙箱 `DSH_HOME`。

---

## 阶段 2：Rail UI（产品的脸面）

1. 左栏结构：`web` 钉顶 + 分隔线 + 工作台列表（可拖拽排序）+ 底部「＋」。
2. Discord 级交互（Motion 实现）：
   - 选中指示条 spring 滑动（`layoutId` 共享元素）；
   - 图标悬停从圆形弹成圆角方形；
   - 运行状态点（灰=停止 / 呼吸绿=运行 / 黄=启动中 / 红=异常）；
   - 悬停 Tooltip 显示名。
3. 右键菜单（shadcn ContextMenu）：启动/重启/停止/重命名/换图标/打开目录/删除（确认对话框）。
4. 新建向导（Dialog）：名字（合法性校验+查重）→ 图标（预置一组 + 自定义上传）→ 进度反馈（创建 profile → 装 web-app → 写 patch → 校验）。
5. 首启 onboarding：扫描结果展示、自动转换的明确提示（FR4.4 的文案是硬需求：**"你的历史聊天统一由 web 维护，工作台从全新会话开始"**）。

**完成判据**：验收 A1、A2、A10 通过；手感对标 Discord 服务器栏。

---

## 阶段 3：健壮性与社区义务

1. NFR1 全面落实：所有写路径过一遍审计（备份、原子写、web 零写入）。
2. NFR2 版本防护：启动前校验流程接入每一次 start；人为破坏 row id 的测试用例（验收 A8）。
3. 插件安装队列（FR5）：串行执行 `dsh plugin` 命令，UI 显示队列状态。
4. 崩溃恢复：crashed 状态的一键重启；启动超时处理（端口探活超时 → 报错而非无限转圈）。
5. 设置页（FR6）。
6. 阶段 0 脚本接入 CI（GitHub Actions），作为发布门（NFR3）。

**完成判据**：验收 A1–A10 全绿，CI 绿。

---

## 阶段 4：发布准备

1. electron-builder 三平台打包 + GitHub Releases 自动更新（electron-updater）。
2. README（中英双语）：定位一句话（"Spaces for DeepSeek Harness — switch your DSH workspaces like Discord servers"）、动图演示、与 DSH-Launcher/dsh-desktop 的差异说明、安全设计说明（不碰 web、备份策略、无遥测）。
3. LICENSE（建议 MIT）、CONTRIBUTING。
4. GitHub topics：`deepseek-harness`、`dsh`、`desktop-app`、`electron`、`profile-manager`。

---

## 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| web-app 端口 flag 与假设不符 | 阶段 0 步骤 1 即暴露 | 以 `--help` 实测为准，回填文档 |
| patch 语法细节（`!!js` 表达式、整行覆盖 vs 合并） | 隔离失效 | 阶段 0 用 `--dump-config` 逐项确认生效 |
| 建会话是否强依赖有效凭据 | 验证脚本设计 | 实测；必要时注入假凭据文件（沙箱内） |
| dsh 版本升级改 row id | 用户数据风险 | NFR2 启动前校验，拒绝启动 + 明确提示 |
| `session_projcache.json` 等次要落盘文件路径不跟随 storage root | 轻微隔离泄漏 | 阶段 0 检查它落在哪；若跟随 storage-json 则天然解决，否则评估是否需要额外覆盖 |
| headless 类无 GUI profile 的处理 | 交互歧义 | V1 不在栏上展示（需求 FR4.5 已定倾向） |
| Windows 下进程树杀不干净（dsh 可能有子进程） | 端口占用、僵尸进程 | 用 taskkill /T 或 tree-kill；阶段 1 测试覆盖 |

## 阶段依赖关系

```
阶段 0（验证脚本）──→ 阶段 1（骨架+进程管理）──→ 阶段 2（Rail UI）──→ 阶段 3（健壮性）──→ 阶段 4（发布）
     └────────────────────────────────────────────────────┘
                    阶段 0 的脚本在阶段 3 进 CI
```

## 给执行者的注意事项

1. **任何时候不要读写用户真实的 `~/.dsh`**，开发与测试全部走沙箱 `DSH_HOME`（环境变量注入）。本机真实 home 里有用户的生产数据（多个 profile、几周的会话）。
2. 本机已装 `dsh 0.1.1-rc.2`、Node v24.16.0，可直接实测。
3. 需求文档 §5 的"技术契约"是实测事实，可直接依赖；标注"待确认"的两处（端口 flag 名、patch 具体语法）在阶段 0 落实。
4. 遇到与需求冲突的官方行为（如 patch 覆盖不生效），停下来报告，不要自行改变产品语义（比如擅自退回共享会话或另起 DSH_HOME）。
