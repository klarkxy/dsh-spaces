# 2026-10-22 官方 Desktop UI 安装与手动服务操作验收

## 授权与结果

用户要求使用独立 Desktop，先打开应用、再通过插件 UI 以 symlink 安装仓库；随后明确选择“允许手动重启服务，点击后确认受影响空间”。本轮已完成该入口、构建、回归和官方安装版实测。没有自动重试、自动重启或子空间任务续跑。没有操作真实 Home、正常使用的服务或官方安装文件；没有提交、推送或发布。

`AGENTS.md` 与 `docs/let-it-crash.md` 同步记录这一项有限例外。已有失败仍保留，普通子空间没有重启所属服务的权限。

## 使用方式

仓库构建产物已更新。已经打开的旧 Desktop 需要正常重开一次加载新版链接插件。若 Spaces 设置入口显示服务错误，打开详情后点击“手动启动 / 重启 Spaces 服务…”，查看受影响空间并确认。活服务正常停止成功后，使用当前插件启动一次管理服务；没有活服务时显示启动确认。当前 Desktop、main DOM 和输入草稿保持，子空间保持停止。

预览不会停机，取消不会停机。确认绑定服务身份、状态版本和一次性令牌；身份变化、确认过期、停机失败、维护中或所有权不明时拒绝，不强杀、不清除证据。

## 官方 Desktop 交互证据

官方安装版 `0.2.1-rc.2`，打包 Electron `44.7.0`、内置 Node `24.21.0`。每个测试使用独立 Home、userData 和仓库外临时目录，不复制用户配置。测试期间窗口隐藏，由实际官方 UI 和 Playwright Electron 驱动交互。

证据根：`H:/Code/dsh-spaces-checktmp/desktop-link-20261022/`。

1. **先打开空白 Desktop，再 UI 安装。** `run-2026-10-22T13-58-06-322Z`：插件 UI 添加 `H:/Code/dsh-spaces` 并启用；`link-evidence.json` 确认 `link:H:/Code/dsh-spaces` 和真实链接目标。首次初始化注册 200；正常关闭重开后注册仍 200，main 可用且输入草稿保留。
2. **旧服务与新链接插件。** `run-2026-10-22T14-03-12-177Z`：旧测试包启动服务，在 Desktop 插件 UI 卸载旧包、安装并启用仓库链接，保持旧服务。热替换后侧栏未立即出现，正常重开 Desktop 后加载新客户端，真实复现 `MAIN_REGISTRATION_REFUSED:404`。这只证明隔离环境中的旧服务版本冲突可产生该错误，未读取用户真实 Home，不能据此确定用户原实例的根因；也不宣称宿主热替换已得到修复。
3. **带运行中子空间的确认和取消。** 创建并启动 `space-restart-check`（显示名“重启影响测试”，无模型调用）。确认页列出它和管理空间。先取消，`after-cancel-state.json` 证明服务纪元及两空间运行状态不变。
4. **确认重启。** 同一个 Desktop PID `43312`、宿主服务进程 PID `5832` 中，确认一次正常停机并启动。注册由 404 变为 200，服务纪元改变；管理器运行，测试子空间为 `stopped`、generation 0。过程中返回当前应用，main 草稿 `legacy service upgrade draft` 保留；之后设置页实际打开可用。证据：`feature-02-confirmation.png`、`feature-04-settled-main.png`、`feature-05-settings.png`、`after-manual-restart-state.json`、`registration-observations.json`。
5. **服务已停止时手动启动。** 通过正常停机接口停止本次测试服务，Desktop 保持打开；观察到终态错误且没有自动启动。UI 显示“确认启动 Spaces 服务”，确认一次后，同一个 Desktop 回到 main，注册 200，草稿保持，子空间仍停止。证据：`feature-06-start-confirmation.png`、`feature-07-started-main.png`、`after-manual-start-state.json`、`feature-final-ui-result.json`。

前两次空白准备（仓库内 `13-55-15`、外部 `13-56-55`）发现观察插件误继承仓库包的 client 元数据，导致未安装服务时出现幽灵客户端；这两次均终止，不算产品验收。观察插件随后放到外部目录并使用独立 package 元数据，重新建立以上有效测试。旧准备和错误记录保留。

## 实现边界

- `packages/plugin/src/host/service-restart.ts`：认证发现、受影响空间预览、一次性确认、正常 shutdown、只读观察精确持久化作业及所有权释放，然后启动一次。作业路径、身份、大小和状态均校验；不实例化会处理旧作业的 store。
- `host/runtime.ts` 与 `host/llm-main.ts`：只对确认的 Desktop 开放；旧服务确已停止后才能清除旧连接状态和委派请求、轮换认证。旧连接迟到完成不能覆盖新连接。
- `client/ui/service-restart.tsx` 与 `native-controller.ts`：操作状态随外壳保留，切回 main 不取消已接受操作；旧失败控制器保持终态，成功后替换为新控制器，不重新挂载 main。
- host/remote 类型与描述符同步；普通 portable 入口保持原行为。

## 自动检查

Node `26.10.0`、版本匹配的 rc.2 SDK、仓库外临时根运行完整 15 组。首次 14 组通过；`test:spaces` 的方法清单断言未包含两个新增 API，已修正断言并重跑整个组，通过 148、跳过 1、失败 0。首次失败保留，不将原 `result.json` 改写为成功。

| 检查 | 最终结果 |
|---|---|
| 清单、三组类型、构建、包预检 | 全部通过 |
| 默认测试 | 270 通过 |
| spaces（清单修正后整组复查） | 148 通过 / 1 跳过 |
| workbench | 573 通过 / 2 跳过 |
| workbench:recovery | 31 通过 |
| llm | 123 通过 |
| blueprints | 前置 94 + 主组 239 通过 / 4 跳过 |
| browser | 13 通过 |
| dashboard | 前置 52 + 主组 152 通过 / 1 跳过 |
| workbench Chromium 交互 | 15 通过 |

新协调器的 15 项用例覆盖确认、取消前无副作用、重复确认、并发、过期、身份和版本变化、停机失败/取消/超时/不可读、所有权未释放、维护和 Desktop 权限。另有主委派重置和 Chromium 成功/失败/保留 main 用例。

完整原始结果：[result.json](../../.sandbox/manual-service-restart-checks-20261022/result.json)；修正后整组日志：[test-spaces-recheck.log](../../.sandbox/manual-service-restart-checks-20261022/test-spaces-recheck.log)；[补充汇总](../../.sandbox/manual-service-restart-checks-20261022/final-summary.json)。这是各必需组最终通过，不是一次全绿的原始运行。

## 隔离与清理

有效测试 Desktop 已正常关闭，测试服务通过正常 shutdown 结束；全部外部测试 Home 的端点和运行所有权目录均消失，`profiles/web`、根 `sessions`、根 `storages` 均未创建。官方 EXE 与 ASAR SHA-256 不变。

最早快照中的 7 个用户进程有 5 个在手动功能验收前已改变，不能将最早快照宣称为全程不变，也不推断变化原因。手动功能验收期间记录的 7 个非测试进程，最终 PID 与创建时间全部一致；本次测试进程均已退出。首轮审计因最早快照不匹配返回非零并保留；补充审计准确区分上述时间窗口，且修正了审计脚本中的所有权目录和构建产物路径。

[最终隔离审计](../../.sandbox/main-startup-desktop-20261022/link-isolation-audit-final.json) 保存进程身份、服务纪元、空间状态、注册结果与构建摘要。本报告是本次启动与手动操作的有界验收，不替代历史 S1/P0/P1 全部门槛或长期运行验证。
