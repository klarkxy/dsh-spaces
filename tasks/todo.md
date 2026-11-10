# DSH Spaces 维护待办

> 只列当前仍需跟踪的事项。完整日期日志和已关闭条目在 [tasks/archive](archive/README.md)，不要在这里追加长日志。

- [ ] 空间注意光晕：三种空间栏按 `dsh-spaces:space-attention` 通道投影待审批/待提问状态；已有空间的 view-bridge 需按新组件组重新对齐才会上报（此前为 unknown、无光晕），真实 Desktop 尚未实测。

## 发布验收

- [ ] 最终 0.5.0 制品验收：按错误页现有预览/确认流程完成一次真实服务重启（旧 space-control bundle 清理后的实际服务重启仍未执行）。见 [归档记录](archive/todo-2026-11.md) 2026-11-09 管理空间残留旧 space-control bundle。
- [ ] 最终 0.5.0 制品验收：真实 Desktop 加载后的删除/新建验收；失败空间与作业保留，不自动补配置或重放。见 [归档记录](archive/todo-2026-11.md) 2026-11-09 新空间无模型与自定义图标同屏报插件路径错误。

## 2026-11-09 发布前清理（开发态 → 维护态）

- [x] 代码：删除无使用方的导出、文案键、`settleRecovery` 空壳、doctor 恢复残留字段（`rollbackRequired`→`writeBlocked`）、`DSH_SPACES_PACKAGED` 真实 Home 绕过、生产不可达的 managed CLI 自动安装、Node 下载的 `curl --retry`；合并语义相同的路径工具与工具/审批类型；`DSH_DEFAULT_VERSION` 升到 0.2.2-rc.1（用户决定）。保留：`recovery-only` 等线上可见枚举、封存的 Browser/blueprint 代码、`test:workbench:recovery` 名称。
- [x] 测试：修正 `--dsw-*` 白名单（改为从已安装 SDK 收集）与设置页页签/安装区导航后的 DOM 选择器；删除无引用 fixture/辅助脚本和重复的 E08；blueprint 用例不再被 0.2.1-rc.2 版本卡住跳过；测试清单去重；CI 改跑 `test:workbench:browser`。
- [x] 文档：历史计划移到 `docs/archive/`，日期日志与旧待办移到 `tasks/archive/`（`todo-2026-11.md`）；现行文档、包 README、AGENTS/CONTRIBUTING 按维护态改写；新增 CHANGELOG。
- [x] 普通进程 `check:all`：首轮 12/14（dsh-cli 测试的 resolver 泄漏、DOM 安装区导航），修后复跑 13/14：唯一失败为 `workbench-plugin.test.ts` “portal startup observation … unavailable”（observed 0≠1），该文件单独复跑 52/52，首轮同组通过；按负载偶发记录，不记全绿。两个 `.npmignore` 未删（需先对比打包清单）。
- [ ] 尚未提交；真实 Desktop 未实测本轮改动。

## 已跟踪问题

- [ ] 首次管理页导航/35 秒就绪超时根因未确认；不将后续成功样本视为修复。见 [归档记录](archive/todo-2026-11.md) 2026-11-02 首次导航诊断、2026-11-02 前一轮首次管理页超时、2026-11-02 Desktop 后台启动条目。
- [ ] `MAIN_REGISTRATION_REFUSED:400` 原始根因未确定；补丁加载后的实际拒绝码仍待确认。见 [归档记录](archive/todo-2026-11.md) 2026-11-08 Desktop 主空间注册 400 诊断。
- [ ] `attachReady` 监听器失败后本纪元控制工具不可用，`workbench/unavailable` 无法区分“未接入”和“不可用”。见 [归档记录](archive/todo-2026-11.md) 2026-11-09 主空间空间总控插件设计。
- [ ] 真实 Desktop EXE 与 `cordis` 会话内的 `spaces_plan` / `spaces_execute` / `spaces_ui_*` 审批端到端尚未实测。见 [归档记录](archive/todo-2026-11.md) 2026-11-09 主空间空间总控插件设计。
- [ ] `plugin.live.*` 对真实子 DSH 进程（真实 cookie 交换 + 真实 `pluginManager`）的端到端冒烟尚未执行。见 [归档记录](archive/todo-2026-11.md) 2026-11-09 主空间空间总控插件设计。
- [ ] 长时间 UI 探针中的浏览器侧 DNS 停顿、`read.deadline`、portal/transport-failed 仍未归因。见 [归档记录](archive/todo-2026-11.md) 旧阶段仍未关闭的条目（2026-10-15、2026-10-14）。
- [ ] 负载下的计时敏感用例（launch token、端口分配、`workbench-plugin` portal startup observation “unavailable” 变体）仍可能偶发失败，根因未查；`dashboard-supervisor` 测试已不存在，blueprint `native.test.mjs` 现先等待 `listening` 再读端口，未做负载复测。另有 Linux taskkill 挂起记录。见 [归档记录](archive/todo-2026-11.md) 2026-10-12 清理与结构拆分、2026-10-09 精简 MVP。
- [ ] Web 拒绝嵌入提示不完整：实际页面主要为浏览器破损图标和通用预览文案。见 [归档记录](archive/todo-2026-11.md) 旧阶段仍未关闭的条目（2026-10-09）。
- [ ] Terminal Space 尚未实施，另行设计与授权。见 [归档记录](archive/todo-2026-11.md) 旧阶段仍未关闭的条目（2026-10-09）。
