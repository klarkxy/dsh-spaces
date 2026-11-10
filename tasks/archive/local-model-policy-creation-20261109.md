# 新建本地模型空间的策略初始化

## 问题与证据

用户报告新建空间不使用主空间模型后出现 `llm policy has unexpected keys`。受控 `spaces_inspect` 记录显示 `space-111`（测试1）在 2026-11-09 12:15:46Z 创建成功，随后启动因 `LLM_CONFIG_INVALID` 失败；同 ID 存在此前的运行记录，model inspection 同样失败。未读取真实 Home 的策略文件，因此实际旧文件的字段集合未验证。

源码确认普通创建和 Creator 创建原先仅在主空间继承分支写策略；删除并保留数据时 `hub/<id>` 继续存在。同名本地模型空间重建因此可能沿用旧策略。隔离测试预置旧 `{schemaVersion, revision, shared}` 格式即可复现同一严格解析错误；合法的 `inheritMain:true` 残留也会违背本次 local 选择。

## 修复范围

- 普通 Web 创建在创建锁内明确写入本次模型来源；local / 未指定为 false，main 为 true。
- Creator 计划和执行均包含策略阶段，local 明确写 false；保留 main 预览期模型桥接组件检查。
- 策略写入失败归属 `llm-policy` 阶段，不继续桥接。
- 保持严格解析、原子写入和首个失败终止。不迁移现有空间，不删除其他保留数据，不重放失败任务。
- 回归覆盖旧格式残留、合法继承策略残留、写入失败归属、Creator 本地来源与预览组件缺失。

## 验证

首次完整检查在 Windows 文件沙箱中因 esbuild `spawn EPERM` 于构建停止。对同一命令获批使用普通进程后，使用外部临时 Home 完整运行 `check:all`：12/14 组通过，记录在 `.sandbox/checks-i2xNtY/result.json`。

通过：测试清单、三项类型检查、构建、spaces、recovery、LLM（53/53）、blueprints、browser、包预检、workbench browser（27/27）。

未通过：

- `test`：239/240，通过停止后端口重用用例时 API 就绪等待超时。
- `test:workbench`：898 pass / 2 fail / 2 skip；失败为 workbench-plugin 注册失败文案预期与启动观察计数断言，均不在此次策略初始化改动路径。保留原始失败，不宣称全绿。

独立审查后补齐 phase、预览组件探测和回归场景。其后两项类型检查先在沙箱中通过、构建受 `spawn EPERM` 阻止；获批普通进程复查时，工作区新增的并行 attention 改动导致类型检查失败（`SpaceAttention` 导入/本地声明冲突与 `attentionOf` 接口尚未对齐），后续构建未执行。未修改这些非本任务文件，最终构建验证受此限制。独立运行最终四文件回归全部通过：`llm-policy.test.ts`、`creator-channel.test.ts`、`llm-policy-plan.test.ts`、`workbench-supervisor.test.ts` 合计 98/98，退出码 0。独立复核确认无新增关键问题。最终构建未在并行 attention 改动后完成，不把前一轮构建视为最终源码的已验证制品。

## 运行时边界

本次修改工作区源码与构建产物，不改真实 `space-111` 的旧策略，不重启 Spaces 服务或子空间。已运行的 Supervisor 不自动加载新构建；既有坏策略也不由本修复迁移。运行时需在正常加载新构建后另行验收，不能把源码及隔离测试通过当成真实空间已经恢复。
