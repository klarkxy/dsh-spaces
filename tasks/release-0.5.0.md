# 0.5.0 发布准备

日期：2026-10-27。用户授权“先准备能发一个版本，浏览器相关的入口先封存”。本次范围是本地发布准备；没有提交、推送、打标签、GitHub Release、npm publish 或更新当前安装版。

## 版本与发行单元

- 已只读核对 GitHub：最近公开版本为 0.4.0，发布日期 2026-09-21；远端没有 v0.5.0 标签。npm 的 `@dsh-spaces/plugin/0.5.0` 查询返回 404，目标未占用。
- 0.4.0 → 0.5.0。最高变化包括从独立桌面发行转为宿主插件、公开管理/模型接口及持久化能力变化，并封存既有入口；按照项目 0.x 规则升 minor，不使用 patch 掩盖兼容边界。
- 根包、管理插件、Supervisor、view bridge、LLM bridge、Doctor 版本源为 0.5.0，锁文件同步。独立 Browser 产品保持 0.4.0，独立蓝图包保持 0.2.0-alpha.1；组件组按各自身份、版本、摘要核验。
- 用户安装单元为 [dsh-spaces-plugin-0.5.0.tgz](../dist/releases/0.5.0/dsh-spaces-plugin-0.5.0.tgz)，2,465,833 字节，SHA-256：`b064dd11377f41b9514c6f1fc70ed724bcd6456f96af007b16ee80be4a4c22e1`。
- [校验文件](../dist/releases/0.5.0/SHA256SUMS)、[打包报告](../dist/releases/0.5.0/pack-report.json)、[候选发布说明](../docs/releases/v0.5.0.md)齐备。目录中的桥接/Browser tarball 是组件核验和内部安装制品，发布给用户的安装入口是主插件 tarball。

## Browser 封存边界

统一的编译期封存标志隐藏创建表单的 base 选择和 Browser 选项，保留 Web 精确版本及模型来源，不显示“已封存”说明。新旧 Browser 创建参数和 Browser 版本目录返回 unsupported，直接创建在任务落盘前拒绝；模板/分享路径在创建底座前拒绝，不写 profile、不装扩展。已知 Browser base 不允许启动；工作台转接和原生 Browser guest 不启用。

Browser 实现、版本契约、组件载荷、单元测试和此前验收记录保留，没有删除用户数据。普通 Web、普通模板/分享及其插件管理保持；Spaces 蓝图既有封存状态保持。

## 验证

- [完整规定检查](../.sandbox/release-0.5.0-20261027/checks-1/result.json)：14/14 通过。清单、三组类型、构建、八组测试/交互、包预检均通过；测试累计 1,433 通过、7 项既有条件跳过。Windows 改名检查使用仓库外临时目录和普通进程。
- 最后新增的模板拒绝用例已在 Browser 18/18 中通过，并补查最终测试类型。最终包重新构建，包内容清单、组件摘要、版本身份与安装制品组校验通过。
- [凭据检查](../.sandbox/release-0.5.0-20261027/llm-secrets.log)与[模型桥发行检查](../.sandbox/release-0.5.0-20261027/llm-distribution.log)均通过。
- [最终包实际运行](../.sandbox/release-0.5.0-20261027/installed-2/result.json)：解包最终主插件，加载其中打包的 Supervisor，使用同组制品在全新隔离 Home 安装管理器；没有使用源码 Supervisor 代替最终载荷。真实 Chromium 验证无 Browser 入口、Web 版本与模型选项可用、UI 创建成功、子空间认证就绪及正常停止，页面异常为空。[创建界面截图](../.sandbox/release-0.5.0-20261027/installed-2/create-web.png)。
- 所有真实测试保持 `profiles/web/`、默认 `sessions/` / `storages/` 不存在，正常关闭受管进程。首次最终包测试脚本误在设置层打开时点击后方空间栏按钮，其超时、页面和截图保留在 `installed-1`；只修正测试导航，未改产品或强制点击。
- 最终差异空白检查通过。保留工作区既有未提交工作；当前候选制品来自该工作区，不等同于远端某一已提交版本。

## 发布状态与边界

本地候选包可供审核和后续明确授权发布。发布时需要将完整源码状态提交，并保持该候选的版本/摘要对应；若源码或包内容变化，应重新核验相应产物。

本轮真实运行环境为 Windows、Node 26.10.0、官方 DSH 0.2.1-rc.2、Chromium。没有更新或重启用户当前安装版 Desktop，也没有对 0.5.0 做 macOS/Linux 实机验收。旧版独立桌面应用不走原地自动升级，本次不迁移旧空间；当前产物只包含宿主插件，不含独立桌面安装程序。以上边界已写入候选发布说明。
