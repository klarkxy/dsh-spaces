# 2026-11-08 独立 Web + Magpie SWE2 实测

用户明确授权使用 Magpie SWE2 进行独立 DSH Web 验证。本轮产品源码和验收包未改；结论是**真实模型与审批链通过，完整安装启动未通过**。

## 实际结果

| 验证项 | 结果 |
| --- | --- |
| Web 入口与会话 | DSH 0.2.2-rc.1 独立 Home，网页正常渲染；Creator 为 `cordis`，权限为 `workspace-write + ask` |
| 模型请求 | 持久 `request/context` 为 `provider=magpie, model=klarkxy/swe-2`；真实生成及工具轨迹存在 |
| 搜索与预览 | 实际调用 `spaces_context`、`dsh_plugins_search`、`dsh_plugins_fetch`、`spaces_create_preview`，选择当时查询到的 `@klarkxy/dsh-dev-index@0.2.9` |
| 拒绝审批 | 真实 UI 点击拒绝，`approval/decided=rejected`，execute 返回拒绝，模型结束；没有创建作业或 `space-swe2-deny` |
| 允许审批 | 真实 UI 点击“允许一次”，`approval/decided=allowed-once`；SWE2 提交作业 `4c8e2b71-d5a6-4f09-b3e2-1a7c9d5f6e82` |
| 作业终态 | `failed@plugins`：prepare / install-runtime / create / view-bridge 为 done；插件步骤 failed；start / result 为 not-run |
| 最终查询 | SWE2 只读调用 `spaces_job`，如实报告上述失败，没有重试、修复或声称空间已启动 |
| 正常收尾 | `service.shutdown` 作业 `3537661f-2eea-4797-a0ee-a668540aa383` 持久化 succeeded；端点、租约释放，端口关闭，Supervisor PID 66632 已退出；Web PID 58128 经 IPC SIGINT 正常退出 130；测试浏览器正常关闭 |

## 安装失败原因与边界

`@klarkxy/dsh-dev-index@0.2.9` 的传递依赖 `@klarkxy/dsh-model-route@0.2.7` 在安装使用的镜像中没有匹配版本。Spaces 的 `toolchainEnv()` 通过 `sourceEnv(currentPackageSource())` 后置覆盖进程的 npm registry；工具链配置的 `packageSource: china` 因而使子进程使用 npmmirror，外层准备脚本固定官方 npm 并未覆盖这条安装链。

失败空间已创建但未启动，保留其目录和作业记录；本轮没有修改全局工具链配置、补装、换版本或重放。普通 Web 不具备 Desktop 的 `exitWithHost` 条件，因此清理由测试 operator 经正常管理 API 单次停机，再停止 Web。Web 子进程退出 130 被外层作业显示为退出 1，保留这个事实；独立停机记录确认了实际资源释放，没有强杀。

隔离范围以实际证据为准：Home、agents 目录、主进程缓存设置和后续会话工作区位于本次 run；工具链源选择仍读取全局 AppData 配置。首轮只读会话使用 SDK 自动选择的默认工作区，之后另建 run 内工作区会话，并未迁移旧会话。早期一个漏设 `DSH_HOME` 的 `web --help` 探针触发真实 Home 写入尝试，被文件沙箱拒绝，拒绝前无 stdout；这是准备脚本错误，未授权提权重试，不能据此证明所有 OS 层先行读取均未发生。

请求路由不等于上游 served-model 证明：会话日志没有 `response_id/served_model`，Magpie usage 的 session 字段未关联该 DSH session，因此不声称已独立证明无网关 fallback。子空间未启动，本轮没有验证其运行时工具清单或进入后的交互。此前 SDK/native 的通过记录保留，但不替代本轮失败结果。

## 证据

- [运行报告](../.sandbox/creator-swe2-web-20261108/REPORT.md)
- [创建作业终态](../.sandbox/creator-swe2-web-20261108/run-9bb0a7b6be51497386625439b6b99ef0/home/.dsh-spaces-control/jobs/4c8e2b71-d5a6-4f09-b3e2-1a7c9d5f6e82.json)
- [正常停机证据](../.sandbox/creator-swe2-web-20261108/run-9bb0a7b6be51497386625439b6b99ef0/out/cleanup.json)
- [Creator/SWE2 配置截图](../.sandbox/creator-swe2-web-20261108/run-9bb0a7b6be51497386625439b6b99ef0/out/creator-swe2-config.png)
- [拒绝审批截图](../.sandbox/creator-swe2-web-20261108/run-9bb0a7b6be51497386625439b6b99ef0/out/approval-deny.png)
- [允许审批截图](../.sandbox/creator-swe2-web-20261108/run-9bb0a7b6be51497386625439b6b99ef0/out/approval-allow.png)
- [模型最终查询截图](../.sandbox/creator-swe2-web-20261108/run-9bb0a7b6be51497386625439b6b99ef0/out/final-query.png)
