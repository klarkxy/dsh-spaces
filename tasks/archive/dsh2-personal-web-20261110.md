# dsh² 个人工作宇宙 Web 实机验收

日期：2026-11-10。用户授权为个人用途准备多个功能不同的复杂 Spaces，搜索并安装真实插件，允许本机 Agnes 3.0 Flash 实际请求，同时为后续宣传片积累素材。

## 本轮结果

八个空间创建、十三次扩展插件安装、八个服务启动作业成功。六个前端可进入，两种组合前端失败。**本轮不是全部通过，也不是发布批准。**

| 空间 | 插件 | 实机结果 |
|---|---|---|
| 产品实验室 | Super Cards 0.16.0 | Agnes 产品策划卡完成；正常停止、启动后原会话和卡片保留 |
| 情报观测站 | Obsidian Panel 1.6.4 锁定 commit、Markdown+ 0.6.0 | Agnes 研究简报完成；笔记、关联引用、Mermaid 实际显示 |
| 开发工坊 | Better Sidebar 0.30.1 | Agnes 写 HTML/测试后限流；Codex 运行 11 项断言并经真实编辑器修正统计刷新，筛选/状态/持久化验证通过 |
| 数据驾驶舱 | Chart Lab 0.1.0 锁定 commit、Super Cards | 图表工具完成，交互/筛选/导出通过；后续统计卡参数失败并限流 |
| 内容编辑部 | Markdown+、Super Cards | 模型读任务后限流；Codex 另写草稿，已在 DSH 原生文件预览展示 |
| 影像策划室 | AI Drama 0.16.281 锁定 commit | 模型首次请求限流；Codex 在原生接口保存一集八镜/60 秒分镜，读回及 UI 验证，绑定三个实机参考图 |
| 世界观档案馆 | Novel Studio 3.4.2-beta.1 | 前端等待 `settingsScope` 服务失败；未提交模型任务 |
| 日常事务所 | Life Workbench 1.0.0、Pixel Whale 1.0.0 锁定 commit、Super Cards | `pixel-whale` 未调用 `__ModuleLoader__.load` 注册导致前端加载失败；不据此断言 Life Workbench 单插件失败 |

官方 DSH 0.2.2-rc.1、本地构建 Spaces 0.5.0，tarball SHA256 `207080980bdf7f98f5822d0181523ba94ef1ab95d58987b4f0655672dce95a54`。九种不同扩展形成十三次安装。精确 commit 清单与交付说明见本地 `outputs/dsh2-personal-20261110/`。

## 请求、生命周期和持续运行

实际请求模型 `agnes-3.0-flash`，响应记录 `agnes-3.0-flash-angel`。并发请求遇到供应商免费用户 429 RATE_LIMIT。失败回合保留，没有自动重试或续跑。凭据仅进程环境传递；此前写凭据文件的尝试被自动审批拒绝而未执行，后续采用不落盘方式完成请求。

产品空间正常停止作业 `9f032c7f-9391-420a-b862-eb92261f7765` 成功，正常启动作业 `3c6b838f-06ed-469b-9668-a2b0c53a468a` 成功，运行代次 1→3。原会话及卡片重新可读，未重放请求。

长时间使用期间发生一次 `portal/request-deadline`，外层空间列表与视图消失；只读 Supervisor 状态仍 ready、同纪元、八进程 running。人工刷新浏览器后展示恢复可读，没有重启服务或重发操作。根因未确认，持续稳定性未通过。

自定义 `spaces-demo` profile 不符合主空间仅接受 web/desktop 的注册条件；为保护本轮默认 web 边界，没有改用默认 profile。因此主空间自然语言创建/总控与主模型一次性同步未验证。

## 失败现场

早期独立环境的缺依赖、EEXIST、EPERM 均保留。EPERM 发生在旧 Home 安装计划的原子重命名阶段，该环境仍处于 maintenance 保护；没有清除记录或重放任务。最终新环境同时更改 Home 位置和包缓存，不能归因于单一变量。

未替换、禁用或修复两处失败插件来制造成功结果。坏空间不曾连带停止其他健康空间，但这不等于完整故障隔离验证。

短剧第一次参考图绑定因调用方哈希结构错误返回 409；根据实际读回期望哈希发起新的绑定后成功，没有跳过并发校验。多空间录制末步因按钮定位超时结束，成功切换片段已裁出；不是插件故障证据。

## 检查

通过：check:test-lists、typecheck、typecheck:spaces、typecheck:tests、build、test:spaces、test:workbench、test:workbench:recovery、test:llm、test:blueprints、test:browser、test:workbench:browser、check:plugin-package，共十三阶段。

基础 `npm test` 未正常退出，日志已记录 45 个失败条目，涉及日志、文件系统、插件缓存、模板与进程生命周期，不能统称计时抖动或已证明的环境故障。未重跑覆盖，不宣称 check:all 通过。

最终素材页八项切换、六张主场景图加载、两段视频元数据、390px 宽度无水平溢出已验证；桌面与手机截图已目视检查。交付副本的原型十一项断言通过。演示入口脚本识别本机正常认证 401，仅打开当前运行，不启动/重启服务。

## 交付与定位

- 本地交付：`outputs/dsh2-personal-20261110/index.html`、使用说明、验收报告、拍摄清单、plugins.json、media/、成果/。
- 原始证据：`.sandbox/dsh2-personal-20261110/isolated-store/out/`；检查日志：同根 `checks/`。
- 当前 Web：127.0.0.1:10874；Supervisor：127.0.0.1:13068。带认证的入口仅在私有 out/url.txt，由本地打开脚本读取。
- 运行 Home：`C:\Users\27837\AppData\Local\Temp\dsh2-personal-20261110-isolated\home`；临时目录可能被清理，未承诺可永久重建。
- 六类实机截图为 1600×1000，两段有效录屏为 800×500、18秒/17秒，无旁白；不是高清宣传成片。
- 数据使用虚构输入；90 天 450 条时间记录合计 31,125 分钟，模型失败统计卡中的错误数字未采用。

没有修改 Spaces 产品实现，没有提交、发布或部署。已有用户改动保留。早期受保护环境和挂起测试未强制终止。本轮后续事项是插件兼容、门户持续运行、基础测试失败定位和主空间正式入口验收。
