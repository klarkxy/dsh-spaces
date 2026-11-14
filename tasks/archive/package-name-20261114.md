# 2026-11-14 主插件改名为 dsh-spaces

用户确定后续主包名使用无 scope 的 `dsh-spaces`，npm 发布继续暂缓。

## 实现

- 根开发入口、发行包、锁文件根身份、官方 bundle patch、前端模块 ID、Typert 描述、包内空间总控子入口及打包/安装工具统一使用 `dsh-spaces`。安装归档名为 `dsh-spaces-0.5.0.tgz`。
- 组件目录与包名分开处理：主组件仍在 `packages/plugin`，包名为 `dsh-spaces`；view-bridge、Browser、Supervisor 等内部包名保持原样。开发链接、已安装目录检查和宿主兼容性检查不再假设所有组件都在 `@dsh-spaces/` 下。
- `@dsh-spaces/plugin` 保留为历史受保护身份：不能作为普通空间插件安装或分享，管理空间识别继续接受；误装清理仍按实际包名预览、确认和执行。
- 管理空间仍声明旧包时，组件对齐在安装任何包之前明确失败，不把新旧两个管理包一起安装。旧安装按[一次性换名步骤](../../docs/plugin-standard-install.md#first-change-from-the-old-package-name)显式替换；不自动改配置、不迁移数据、不重试或回滚。
- 历史归档保留当时包名；现行 README、架构、安装指南、候选发布说明和合同同步更新。版本仍为未发布候选 0.5.0。

## 验证

- 初轮完整检查发现开发链接夹具和组件工具中仍有动态拼接旧 scope 的路径，已修正；原始报告保留在 `.sandbox/package-rename-checks/`。
- 初轮另出现一次既有并发 lease 竞争用例的保守拒绝：`assertMissingEntry` 在 `reclaim` 路径竞争期间抛出安全检查错误。该轮失败保留，没有修改锁和文件系统安全策略；不将后续成功当作该竞态已修复。
- 官方 DSH 0.2.2-rc.1 在隔离 Home 中完成宿主与管理空间两个 profile 的旧包安装 → 显式卸载 → 新包安装 → dump-config 读回，新身份唯一、旧身份已移除，用户文件保持不变。初次换名验证见 `.sandbox/package-rename-proof/result.json`。
- 最终完整检查 `.sandbox/package-rename-final-checks/result.json` **16/16 阶段通过**；工作台 934 通过/2 跳过，DOM 27/27。开发入口后续补充的旧名拒绝测试为 3/3，通过记录在 `.sandbox/package-rename-link-tests.log`。
- 最终构建再次通过官方 CLI 的双 profile 换名与用户文件保留验证，记录在 `.sandbox/package-rename-final-proof/result.json`；最终新包在其 `package/dsh-spaces-0.5.0.tgz`，打包报告包含实际摘要。
- 本次提交对应的远端 CI 验证干净检出的 Node 24/26 及新包的真实 Web 初始化/重开/卸载。最终状态以该提交的 Actions 记录为准。真实日常 Desktop 与长期运行仍按原维护待办跟踪，本轮未改真实 Home。
