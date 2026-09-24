# DSH 0.1.7-alpha.1 迁移与验收

日期：2026-09-22。用户先要求更新官方默认版本，随后选择 alpha，并明确要求全面迁移。本次完成源码、SDK、原生设置、模型桥接及隔离运行验收；没有提交、推送或发布，没有切换用户既有运行中的 Home。

## 官方更新

依据 [官方 alpha 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-alpha.1) 与实际安装包核对：

- 会话置顶、归档管理，可折叠工作过程，后台任务实时输出。
- 左右分栏文件对比、更完整的 Excel / Office 预览、长会话性能改善。
- Windows 沙箱越界删除、大型工具参数阻塞、新会话误复用历史等修正。
- 会话日志 V4；设置进入 Profile 插件配置；官方 DeepSeek 适配器采用 Messages API；插件和 typed RPC 接口调整。
- 实包的浏览器登录返回 `303 Location: ./`；CLI 保留独立参数，安装路径不能再预先嵌入 shell 引号。

## 实现

- 新安装和 `dev:web` 固定 `0.1.7-alpha.1`，CI 使用同一版本。根依赖、锁文件及三个集成插件的 SDK peer 同步 alpha；不再依赖 `dsh-settings-file`。
- typed RPC codec 改为官方新 descriptor 的 `create` 形式。
- 设置读写使用 `profiles/<name>/cordis.patch.yml`；Supervisor 默认模型写入与官方 ConfigEditor 共用文件锁，避免覆盖并发保存。
- view bridge 复用原生 SettingsForms / ConfigEditor；仅为命名空间绑定隔离的 legacy 导入位置，不读取或导入根 Home 的旧设置。默认 `web` 不受 Spaces 写入。
- 旧 `hub/<name>/settings.yaml` 在正常启动的 Home 写锁内迁移，保留注释和原文件证据；冲突、动态值、未知 namespace 和中断状态直接失败，不覆盖、不续跑。
- 既有启用的 rc.2 bridge 通过选定组件的内容地址归档升级，并逐文件读回核验。禁用的 LLM bridge 不激活；未知/损坏的组件不自动修复。删除旧 settings.path 只改这一字段，不重写其他数据/凭据路径。
- 文件所有权检查拒绝 profile、data、node_modules 父目录及归档目标的 junction / symlink 越界。中断迁移标记保留，不重放。
- LLM 共享路由使用 Cordis 原生配置解析投影，不修改原始本地配置和持久化补丁。保留快照稳定性、直接写入保护、流式调用及卸载边界。
- 登录只接受 `/`、`./` 两个清洁根跳转，仍不跟随重定向。安装归档按一个绝对路径参数传递，支持 Home 含空格。
- 保留官方 `autoInstallPeers: false`。强制开启会安装另一份 app-boot，破坏 Cordis 服务身份和 ConfigEditor；相关脚本、文档已移除强制开启参数。

## 自动验证

以下套件有重叠，不合计为独立测试总数。日志在本仓库 `.sandbox/` 下。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 基础测试 | 276 通过 | `alpha-unit-final.log` |
| 工作台全量 | 473 通过，2 跳过 | `alpha-workbench-final.log` |
| 蓝图 | 196 通过，4 跳过 | `alpha-blueprints-final.log` |
| LLM 全量 | 77 通过 | `alpha-llm-final.log` |
| LLM 集成 | 5 通过 | `alpha-llm-integration.log` |
| 最终认证、进程、Supervisor、迁移组合 | 92 通过 | `alpha-final-integration.log` |
| 最终 Spaces | 102 通过，1 可选真实 CLI 项跳过 | `alpha-spaces-delivery.log` |
| 独立迁移/设置复审 | 15 通过；junction 复现由成功越界变为写前拒绝 | reviewer 独立执行及 `alpha-profile-upgrade-tests.log` |
| node / web / spaces 类型检查 | 通过 | `alpha-typecheck-delivery.log` |
| 完整构建、组件打包、LLM secret/distribution 校验 | 通过 | `alpha-delivery-build.log`、`alpha-delivery-pack.log`、`alpha-llm-gates-final.log` |

Windows 进程生命周期用例在受限进程权限下出现过清理失败；最终组合在具有正常进程权限的宿主环境通过。早期 npm cache 权限及 registry TLS 失败未算作通过；最终安装使用项目隔离 cache 和命令级镜像配置，未改全局 npm 配置。

## 实际运行

全部使用隔离 Home，官方 CLI 实际版本为 `0.1.7-alpha.1`。

1. 打包后的 Supervisor 安装并启动独立管理 profile；`state` 返回 `ready`、版本 alpha、管理进程 running。
2. Chromium 打开管理首页及其原生 DSH iframe；完成内测声明保存，读回原生 profile 配置；保留原有品牌图片。
3. 通过真实管理 API 创建空间、启动、兑换受认证视图并显示原生页面，随后协作停止。
4. 从仓库 HEAD 的 rc.2 view-bridge 源码构建归档，以官方 CLI 安装到一个已停止测试空间；放入有效旧隔离路径和 settings.yaml。正常启动完成 bridge 字节升级、旧设置迁移、原生进程启动及停止，根 settings.yaml 哨兵保持不变。
5. 当前构建的 Electron 桌面连接该 Supervisor，原生首页、品牌图、设置打开和 Esc 关闭均通过；测试桌面随后正常退出。
6. `profiles/web`、默认 `sessions`、默认 `storages` 始终未创建。未访问真实 `~/.dsh`。

主要结果：`alpha-live-result.json`、`alpha-legacy-live-result.json`、`alpha-desktop-result.json`。截图：`alpha-delivery-manager.png`、`alpha-desktop-home.png`、`alpha-desktop-settings.png`。

测试期间保留了早期失败现场，包括旧 CLI 路径参数、登录重定向不兼容及错误的测试 YAML。浏览器上下文/就绪时序、测试客户端连接池等验收脚本问题单独修正，没有添加产品重试或恢复流程。

## 边界

- 本轮是本地迁移交付。用户已有运行中的开发 Home 和真实 Home 未升级；既有 runtime selection 不会被默认版本号覆盖。
- 未重新验证 Windows 安装器安装/卸载、macOS / Linux 打包、发布或远端真实模型计费调用。
- 会话 V4 由官方 runtime 读写；本轮验证了新会话创建和隔离路径，没有扫描或改写用户历史会话库。
- 官方任意插件组合仍可能失败；当前 CLI 版本准入规则不等同于所有历史/未来 SDK 的兼容性承诺。失败遵循 [let it crash](../docs/let-it-crash.md)。
