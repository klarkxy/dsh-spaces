# DSH Spaces — 执行 TODO 清单

> 配套文档：`REQUIREMENTS.md`（需求与验收）、`IMPLEMENTATION_PLAN.md`（阶段计划与技术栈）
> 使用方式：按序执行，每条勾掉前先完成「验证」栏。禁止跳阶段。
> 迷路时看本文件末尾的「决策规则」。

---

## 阶段 0：隔离验证脚本

### 0.1 实测 web-app 启动 flag
- [x] 运行 `dsh --profile web --help`（真实 home 下运行 help 是只读的，安全）
- [x] 记录：端口 flag 的准确名字（可能是 `--port`）、host flag、禁止自动开浏览器的 flag（可能是 `--no-open`）
- [x] 把确认结果回填到 `REQUIREMENTS.md` §5.1
- 验证：三个 flag 名都有实测输出佐证 — `--host` / `--port` / `--no-open`（另有 `--trusted-host`）

### 0.2 搭建沙箱 DSH_HOME
- [x] 创建目录 `D:\0 code\dsh-profile-hub\.sandbox\dsh-home`
- [x] 把 `.sandbox/` 加进 `.gitignore`（先创建 .gitignore）
- [x] 用 `$env:DSH_HOME` 指向沙箱后运行 `dsh web` 一次，观察它如何初始化（profiles/web 是否自动生成、要不要登录）
- [x] 记录：无凭据时 Web UI 的行为；建会话是否需要有效 API Key
- 验证：沙箱里出现 `profiles/web/`，且**真实 `~/.dsh` 的 mtime 无变化** — 已核对基线。`web` 由 `--dump-config` 从 CLI 模板自动初始化，无需 plugin add。

### 0.3 在沙箱创建两个工作台 profile
- [x] `DSH_HOME=沙箱 dsh plugin --profile coding add @deepseek-ai/dsh-web-app@0.1.1-rc.2`（必须钉 CLI 版本；裸 `latest` 会装到 0.0.1-rc.1 并 404）
- [x] 同样创建 `writing`
- [x] `dsh --profile coding --dump-config` 确认配置树里有 `session-persistence-jsonl` 和 `storage-json` 两行
- 验证：两个 profile 目录结构齐全（package.json 含 bundles、cordis.patch.yml、node_modules）

### 0.4 写双 root patch 并确认生效
- [x] 在 `coding/cordis.patch.yml` 写入（语法以实测为准，参考官方注释「id-targeted config overrides，允许 !!js」）：
  ```yaml
  - id: session-persistence-jsonl
    config:
      root: !!js dshHomePath('hub/coding/sessions')
  - id: storage-json
    config:
      root: !!js dshHomePath('hub/coding/storages')
  ```
- [x] `writing` 同理
- [x] 重新 `--dump-config`，确认两个 root 的值已变成 hub 子目录
- [x] 若 patch 是「整行替换」而非「深合并」，记录准确语义并回填 `REQUIREMENTS.md` §5.5
- 验证：dump-config 输出中 root 值已覆盖；启动 `coding` 后 `hub/coding/` 目录被自动创建

### 0.5 三进程并行 + 各建会话
- [x] 写脚本 `scripts/validate-isolation.mjs`：
  - 接受沙箱路径参数，自动设置 `DSH_HOME`
  - 并行启动 web(端口 A)、coding(端口 B)、writing(端口 C)
  - 轮询三个端口直到 HTTP 可达（超时 60s 报错）
  - 在三个实例各创建一个会话（优先走 HTTP API；如必须走 UI，用 Playwright；发消息失败没关系，建会话落盘即可）
  - 优雅关停三个进程
- 验证：脚本能跑完整个生命周期，退出码 0

### 0.6 隔离断言（脚本的核心部分）
- [x] 断言 1：web 的会话文件只在 `$DSH_HOME/sessions/`，不在任何 `hub/` 下
- [x] 断言 2：coding/writing 的会话文件只在各自 `hub/<name>/sessions/`
- [x] 断言 3：三棵 `storages` 树互不污染（重点 `workspace.json` 内容互不包含对方的 session id）
- [x] 断言 4：通过各实例的会话列表 API/页面确认互相看不见对方的会话
- [x] 断言 5：所有 JSONL 文件可完整解析（无损坏）
- [x] 检查 `session_projcache.json` 落在哪棵树（跟随 storage root 则通过；不跟随则记录为风险并评估额外覆盖）
- 验证：五个断言全绿，脚本输出清晰的 PASS/FAIL 报告 — `ISOLATION GATE: PASS`
- **⛔ 此项不绿，停止一切后续开发，报告问题**

### 0.7 收尾
- [x] 脚本支持 `--clean` 重置沙箱、可重复执行
- [x] 把所有实测结论回填 `REQUIREMENTS.md` §5（端口 flag、patch 语法、凭据行为）
- [ ] git init + 首次提交（`.sandbox/`、`node_modules/` 忽略）— 仓库若尚未 init 则 init；提交等你明确说再做

---

## 阶段 1：Electron 骨架 + 进程管理

### 1.1 项目脚手架
- [x] 用 electron-vite 起项目（手写骨架，因官方 create CLI 全是交互式），项目名 `dsh-spaces`
- [x] 配好：React 19、TypeScript、Tailwind CSS 4、lucide-react、Motion（已入 package.json）
- [x] shadcn/ui 未接 registry：Dialog/Tooltip 为 Discord 风格自绘；ContextMenu 用 Electron 原生 Menu（必须浮在 WebContentsView 之上）。输入/进度在新建向导内。
- [x] 类型安全 IPC（preload `window.dshSpaces` 显式方法，后续可换成 oRPC）
- 验证：`npm run dev` 出窗口。注意：路径含空格时 `electron/install.js` 的 extract-zip 可能只解出 locales，需手动从 `%LOCALAPPDATA%\electron\Cache` 解压 zip。

### 1.2 主进程模块：ProfileRegistry
- [x] `src/main/profile-registry.ts` scan / spaces.json 原子写 / 开发模式走沙箱
- [x] 单测覆盖 scan 分类逻辑与原子写

### 1.3 主进程模块：PatchWriter
- [x] `src/main/patch-writer.ts`：web 硬拒绝；备份；`!!js` 双 root；dump-config verify
- [x] 单测 + 人为删 row id 的 A8 失败路径

### 1.4 主进程模块：ProcessManager
- [x] `src/main/process-manager.ts` 端口池、启停重启、状态机、taskkill /T、app quit 关停
- [x] 沙箱里三 profile 并行启停的手动验收（调试 UI 已接线）

### 1.5 主进程模块：ViewManager
- [x] `src/main/view-manager.ts` WebContentsView 切换（阶段 1 左栏宽 380px 给调试面板）
- [x] 切换无白屏 / resize 跟手的细调

### 1.6 IPC 契约 + 调试 UI
- [x] IPC：listProfiles / startProfile / stopProfile / restartProfile / selectProfile / updateMeta + 状态订阅
- [x] createProfile 流程
- [x] 临时调试页：图标 + Start/Restart/Stop（已被正式 Rail 替换）
- **阶段 1 出口判据 = 验收 A3 + A9**：`npm run validate:lifecycle` 已 PASS；GUI 栏上三开/单点重启需窗口里点一次确认

---

## 阶段 2：Rail UI

### 2.1 布局骨架
- [x] 左栏固定宽度（72px 级别），右侧留给 WebContentsView 的空槽
- [x] 弹窗/菜单只在左栏区域或全屏遮罩模式下打开（打开全屏 Dialog 时临时隐藏/缩小 view——WebContentsView 会盖住 DOM）
- 验证：Dialog 打开时 `setOverlayOpen(true)` 隐藏 native view；右键用 Electron 原生 Menu（浮在 view 之上）

### 2.2 Rail 交互（Motion）
- [x] `web` 钉顶 + Divider + 工作台列表 + 底部「＋」
- [x] 选中指示条：左缘白色竖条，`layoutId` spring 滑动
- [x] 图标悬停：圆形 → 圆角方形的形变过渡
- [x] 状态点：灰=stopped、黄脉冲=starting、绿呼吸=running、红=crashed
- [x] Tooltip 显示名；拖拽排序（写回 spaces.json）
- 验证：手感对标 Discord；状态变化实时反映

### 2.3 右键菜单 + 对话框
- [x] ContextMenu：启动/停止/重启/重命名/换图标/打开 profile 目录/删除（原生 Menu）
- [x] 重命名/换图标：只写 spaces.json（验收 A10）
- [x] 删除：确认对话框，说明会删什么（进程停止、注册项移除、`hub/<name>/` 数据删除；官方 profile 目录是否一并删除给复选框，默认不删）
- [x] 新建向导 Dialog：名字校验 → 图标选择（预置 lucide 图标集）→ 分步进度（创建/装插件/写 patch/校验），失败可重试且展示错误

### 2.4 首启 Onboarding
- [x] 扫描结果页：列出发现的 profile 和即将执行的动作（web 收养零写入；其他 profile 将被转换）
- [x] 转换确认页，必须包含文案：**「你的历史聊天统一由 web 维护，工作台从全新会话开始」**
- [x] 用户确认后才执行转换（备份 + patch + verify）
- 验证：验收 A1、A2 通过
- **阶段 2 出口判据 = A1、A2、A10 通过**

---

## 阶段 3：健壮性

- [x] 3.1 写路径安全审计：全代码搜写文件的地方，确认备份/原子写/web 零写入（NFR1）
- [x] 3.2 启动前 verify 接入所有 start 路径；A8 测试用例（人为改坏 row id → 拒绝启动 + 明确提示）
- [x] 3.3 `dsh plugin` 命令串行队列（同一时间最多一个 pnpm 在跑），UI 有队列指示
- [x] 3.4 启动超时、端口探活失败、进程崩溃的用户可见错误提示 + 一键重启
- [x] 3.5 设置页：DSH_HOME 路径、端口范围、退出行为
- [x] 3.6 阶段 0 脚本接入 GitHub Actions（Windows runner 起步），作为发布门
- **阶段 3 出口判据 = 验收 A1–A10 全部通过 + CI 绿**（Windows runner；`dsh plugin` 需要全局 pnpm）

---

## 阶段 4：发布

- [x] 4.1 electron-builder 三平台打包配置；electron-updater 在打包后检查 GitHub Releases
- [x] 4.2 README 中英双语：一句话定位、竞品差异表、安全设计说明（web 零写入/备份/无遥测）
- [x] 4.3 MIT LICENSE、CONTRIBUTING.md
- [x] 4.4 建 GitHub 仓库 `dsh-spaces`，topics：`deepseek-harness` `dsh` `desktop-app` `electron` `profile-manager`
- [x] 4.5 发 v0.1.0

---

## 决策规则（迷路时看这里）

1. **数据安全 > 功能进度**。拿不准某个写操作是否安全 → 不写，报告。
2. **实测 > 文档 > 猜测**。dsh 行为与本文档冲突 → 以实测为准，回填文档，但**不得擅自改变产品语义**（不许退回共享会话、不许另起 DSH_HOME——这两条是已明确否决的方向）。
3. **`web` 是圣域**：任何代码路径都不允许修改 `profiles/web/` 下的文件和默认 `sessions/`、`storages/` 树。
4. 开发/测试一律走沙箱 `DSH_HOME`（真实 `~/.dsh` 有用户生产数据）。只有「只读」命令（`--help`、`--dump-config`）允许在真实 home 上执行。
5. 阶段出口判据没过 → 不进下一阶段。阶段 0 的隔离断言失败 → 停止一切开发，报告根因。
6. UI 拿不准的细节 → 按 Discord 服务器栏的行为抄。
7. 名字保留字：`web`、`hub`、`headless`、`node_modules` 不允许作为新工作台名。
