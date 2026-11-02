# 2026-10-27 按 base 与产品版本创建空间

> 后续决定：同日用户要求先准备可发布版本，Browser 相关入口已封存。本文保留此前实现与隔离验收事实，不代表 0.5.0 开放 Browser。当前范围见 [发布准备](release-0.5.0.md)。

用户确认：没有需要迁移的旧空间。创建时先选 base，再选对应版本；Web 使用官方版本，Browser 使用自己的版本，两者基于 DSH 框架。Browser 默认没有模型与聊天，但可以安装 DSH 插件扩展。

## 完成行为

- 创建表单先选 Web / Browser，再读取该 base 的版本目录。切换 base 后丢弃迟到结果；版本未读到或读取失败时不能提交。Web 保留主空间模型/本地配置选择；Browser 不显示模型来源。
- Web 从所选官方 CLI 的 Web 预设创建；未安装的精确版本沿用受控运行时安装。Browser 从空 profile 装配自己的 base，只提供当前实际携带的 0.4.0；其框架依赖由发行元数据固定为 0.2.1-rc.2。注册信息分别保存 base、产品版本、框架版本。
- Browser 加载认证通信、凭据、插件/配置服务和浏览器 UI，不加载 dsh-base / dsh-web-app 整包、LLM bridge、Agent、Session 或聊天。官方 rc.2 渲染器需要的可选 session scope 由无会话适配器满足，显式会话请求仍失败。
- Browser 使用独立认证就绪接口，不调用聊天接口；启动检查实际安装的 Browser 版本及框架依赖。隔离检查允许未安装的存储服务缺席，但检查所有存在的已知会话/存储/附件/凭据提供者，包括改名及嵌套配置。Web 原有强制存储检查不变。
- 空间详情保留插件管理，Browser 提供工具栏和覆盖层扩展插槽，隐藏模型与单独 DSH 版本切换。Browser base 不能作为普通扩展移除。模板和分享保留 base/版本，并在创建相同 base 后安装扩展。
- 纯消息总线测试夹具明确禁用其未提供上下文的草稿功能；真实 Web 的草稿功能保持默认启用。

## 验证

环境：Windows、Node 26.10.0、官方 DSH 0.2.1-rc.2 SDK；所有测试使用独立 Home，Windows 改名检查使用仓库外 `H:/Code/dsh-spaces-checktmp`。官方 SDK 未修改。

- [完整检查](../.sandbox/base-create-20261027/checks-2/result.json)：清单、三组类型、构建、全部规定测试组、包预检和 Chromium 交互共 14 项全部通过；测试 1,431 通过，7 项既有条件跳过。最终无会话适配器补充通过 `typecheck:spaces`、构建/打包及 [Browser 17/17](../.sandbox/base-create-20261027/browser-final.log)。
- [真实 Supervisor Browser 验收](../.sandbox/base-create-20261027/supervisor-4/result.json)：公共 create/start/stop、版本元数据、组合配置隔离、认证入口、浏览器根页面、输入网站地址并创建 iframe、无聊天控件、无页面异常、正常停止均通过。
- [真实 Web 与 Browser 验收](../.sandbox/base-create-20261027/supervisor-web-1/result.json)：同一隔离 Supervisor 中分别创建两种 base，Web 按指定 0.2.1-rc.2 创建并正常启动/停止；Browser 产品版本保持 0.4.0。
- [插件扩展验收](../.sandbox/base-create-20261027/extension-1/result.json)：本地测试插件通过官方 CLI 安装到独立 Browser profile，真实 Chromium 显示工具栏按钮并响应点击；[截图](../.sandbox/base-create-20261027/extension-1/extension.png)。此项证明标准 DSH 插件安装与插槽交互，不是 npm 目录发布验收。
- [Web 实际版本目录](../.sandbox/base-create-20261027/web-catalog.json)：从配置的官方包注册源读到 10 个兼容版本，默认选当前宿主 0.2.1-rc.2；未伪造 Browser 历史版本。

首轮检查的旧断言、临时缓存/受限进程 EPERM、蓝图测试偶遇 Node 禁止端口及初期 Browser 缺少 credentials / session scope 的实际失败均保留在 `.sandbox/base-create-20261027/`。修正后使用新的独立测试实例验证，没有在产品内加入自动重试或恢复。

本轮完成源码、包、真实隔离 Supervisor 与 Chromium 验证。没有访问真实用户 Home，没有重启或更新当前安装版 Desktop，没有提交、推送或发布；既有 Desktop 原生浏览能力的历史验收不能替代新 base 的安装版验收。Web 预览仍受网站 iframe 限制。
