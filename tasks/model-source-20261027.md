# 2026-10-27 新建空间模型来源与兼容入口

用户要求新建空间只保留“使用主空间模型”和“在此空间配置”，旧连接入口移到次级设置；随后确认没有旧空间，不需要迁移。本次仅调整界面和提示，保留原有未提交工作，不更改后端策略格式、共享接口或运行数据。

## 交付

- 新建空间默认 `main`，可选 `local`，不再展示或由此表单提交 `shared`。浏览器空间原有处理保留。
- 设置 → 模型与连接 → 旧连接兼容设置：默认折叠，首次展开才加载共享连接库；收起保持编辑组件，不清空未保存内容。
- 空间详情 → 模型中的旧绑定表单采用同样的次级入口；不再声称每个空间都使用管理器共享连接。
- 中英文说明同步，键盘可展开兼容入口，设置对话框焦点循环包含折叠标题。完整模型设置重订仍未实施。

## 验证

完整检查日志：`.sandbox/checks-model-source-20261027-run/`。使用 `H:/Code/dsh-spaces-checktmp` 内的独立临时 Home；最初受限进程在创建外部临时目录时被拒，未运行检查，随后获准以普通进程执行。

| 检查 | 结果 |
| --- | --- |
| check:test-lists、typecheck、typecheck:spaces、typecheck:tests、build | 通过 |
| test | 280 通过 |
| test:spaces | 148 通过，1 条件跳过 |
| test:workbench | 588 通过，1 失败，2 条件跳过 |
| test:workbench:recovery | 31 通过 |
| test:llm | 123 通过，1 npm 缓存失败；失败项补查通过 |
| test:blueprints | 通过，独立蓝图包测试及后续组均成功 |
| test:browser | 13 通过 |
| check:plugin-package | npm 缓存失败；独立缓存补查通过 |
| test:workbench:browser | 17 通过 |

浏览器覆盖两种模型来源的实际表单提交、默认来源、创建后进入空间、兼容库默认未加载、键盘展开/焦点循环、收起保留组件、空间详情绑定区默认折叠。这里是浏览器夹具交互证据，不是用户安装版 Desktop 重载证据。

最终补查：`.sandbox/checks-model-source-20261027-final/`。键盘焦点补充后重新通过两组相关类型检查和构建。两项打包失败均为系统 npm 缓存 `EEXIST`；独立空缓存下 A28 和包预检通过，未清理系统缓存，完整检查原失败日志保留。

唯一未消除的测试失败是 `tests/message-bus/space-message-supervisor.test.ts` 的子进程启动。仅在临时诊断脚本里收集子进程 stderr，确认错误为 `cannot get property "profileContext" without inject`，来自本轮开始前已存在的 `packages/view-bridge/src/drafts.ts:61`，调用者为 `view-bridge/src/index.ts` 和消息总线测试夹具。本次没有修改这些文件或掩盖失败，不声明全量检查通过。

未执行数据迁移，未读取或写入真实 Home，未重启用户服务，未提交、推送或发布。
