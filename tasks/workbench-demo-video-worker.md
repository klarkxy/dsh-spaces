> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。
# 工作台介绍录像（叶子交接 · 唯一审查重试）

日期：2026-09-12。分支 `codex/spaces-pluginization`。只改下面 3 个授权文件。未改产品、旧录像、包清单。未 mmx、未 build、未 Git。未启动浏览器 / 真实 DSH / 录制。root 在跑 runtime，未干扰。

## 结论

**脚本已按审查修正；真实录制与合片仍未执行。** 成片不存在。Home 不再硬编码 `home-C4wR8E`。root 先跑最终 theme 验收，再串行录制、合成。

| 文件 | 作用 |
| --- | --- |
| `D:\0 code\dsh-spaces\scripts\record-workbench-demo.mjs` | Playwright 实录四章 |
| `D:\0 code\dsh-spaces\scripts\assemble-workbench-demo.mjs` | 合成 1080p + 字幕 + manifest + preview html |
| `D:\0 code\dsh-spaces\tasks\workbench-demo-video-worker.md` | 本记录 |

## 本轮修正

- `loadPrior` 只信任 `.sandbox/workbench-product-themes/results.json`：`status=pass`、`resolve(prior.home)` 必须是该 output 目录的子路径、toolchain 私有根与 packed 插件/桥也必须在该目录内、`refuseRealHome`。不允许任意外部 Home，也不绑定旧失败生命周期 Home。
- 校验用真实 `resolve` 路径；日志/错误经 redact，不回显 bootstrap token。
- 选择器对照当前 `packages/plugin/src/workbench/components.tsx` 与 `scripts/verify-workbench-interactions.mjs`（不 import 后者）：XP 走 Continue/稍后配置 → browse → `empty-workspace-xp` → new session → `childFrames()[0]` 内层 editor，禁止内层 `#dsh-xp-taskbar`；创建后不断开竹青选择、不点「进入空间」；rename/icon 的「保存」「代码」限定在对应 `.dsh-wb-dialog`；误装页等「返回工作台」heading+button，不点走。
- assemble 只接受 `status=recorded` 且恰好 4 章、每章 `status=recorded`、id 与配音稿一致、无 `unrecorded`。缺章或 error 不得合成。时长仍 `max(画面, 音频+1.5s)`，不把画面压到配音长度。
- 已有四段 mp3+srt 不重新生成。

## 静态检查

```
node --check scripts/record-workbench-demo.mjs
node --check scripts/assemble-workbench-demo.mjs
```

本叶实测：两文件 `node --check` 退出码 0；`import` 不执行 `main()`，不创建 `.sandbox/workbench-demo-*`。

## root 串行命令

最终 theme 验收写入 `.sandbox/workbench-product-themes/results.json` 之后：

```
"D:/Program Files/nodejs/node.exe" scripts/record-workbench-demo.mjs
"D:/Program Files/nodejs/node.exe" scripts/assemble-workbench-demo.mjs
```

合成入口：`.sandbox/workbench-demo-delivery/DSH-Spaces-workbench.mp4`。缺 4 章 recorded 时 assemble 必须失败。

只补章（不能拿去冒充成片）：`DSH_TEST_DEMO_CHAPTERS=04-maintenance`。

## 主 Agent

不要把本交接当成成片已完成。不要改旧 `spaces-demo-*` 脚本或产物。此叶结束。
