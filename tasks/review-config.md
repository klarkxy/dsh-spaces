# 配置修复独立验收

更新：初稿问题现已由 Codex 接管修复。配置测试 14/14、独立补充验收 13/13 通过；真实 DSH 0.1.1-rc.2 对 coding/writing 重复应用后的配置解析通过，web patch 字节不变。真实配置备份预览、恢复后 DSH 解析以及无效备份原样回滚也已验证。以下保留初稿问题和返工原因，便于审查。

日期：2026-09-08。施工者 Grok，验收者 Codex。仅配置解析初稿交付，不代表首批全部完成。

Agent Bridge 用户配置已设置 server.idle_exit_sec = 0，实际配置读取和模拟空闲 24 小时退出条件测试通过，原生 list_agents 和实际派发工具均成功。连接修复已完成。

## 施工记录

- 首轮 task_dcf0feb11f：约 649 秒，只有读取和计划，没有生产文件修改，协调者取消。
- 聚焦返工 task_d22e9a0497：约 1222 秒，完成四个文件的初稿。
- 实际变更：src/main/patch-writer.ts、tests/patch-writer.test.ts、package.json、package-lock.json。
- observed_model 为 grok-4.6；聚焦返工请求 medium，但 Bridge 返回 observed_effort 为 xhigh，此差异未进一步诊断。
- worker usage 未提供，不能报告 token 消耗。
- Grok 报告目标测试、类型检查和构建通过；Codex 独立运行全部单元测试 49/49 通过、类型检查通过，但补充验收 9/13 通过，4 个场景失败。

## 必须修复的问题

### 1. 路径校验丢失表达式标签语义（高优先级，两个失败场景）

位置：src/main/patch-writer.ts 的 isExpectedIsolationRoot。

当前 !!js 标签是可选的；不带标签的 dshHomePath('hub/notes/sessions') 字符串，以及裸 hub/notes/sessions 相对路径都会通过。它们不能证明实际存储根位于 DSH_HOME 下指定的工作台目录。应保留 YAML 标量标签语义，只接受能静态证明为目标根的值；不能把未求值函数字符串或相对路径当成已求值的绝对目标。

### 2. root 行内注释丢失

位置：src/main/patch-writer.ts 的 setRootOnConfig。

config.set('root', 新标量) 会丢弃旧 root 的行内注释，例如 # important root note。应在修改值时保留原节点的注释及相关样式信息。

### 3. 动态 config 被静默覆盖（高优先级）

位置：src/main/patch-writer.ts 的 setRoot。

合法 YAML 输入 config: !!js "({ root: 'sessions', compression: 'none' })" 被替换成仅包含 root 的映射，其余动态配置被丢弃。不应求值任意表达式；对于无法安全保留的动态 config，应拒绝写入并保持原文件不变，而非静默丢弃用户设置。

## 可复现证据

从项目根目录运行：

```powershell
node --import tsx tasks/patch-review.mjs
```

初稿结果曾为 Independent acceptance: 9/13 passed，退出码 1；修复后结果为 13/13（见本文开头）。脚本仅使用系统临时目录，不接触真实 DSH_HOME；保留临时样本以便检查。

## 后续门槛

以上为初稿阶段的门槛，现已修复并通过配置验收。后续功能已经施工；当前完成度和实际验证限制以 todo.md、acceptance.md 为准，不再沿用初稿阶段的未施工结论。
