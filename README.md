# DSH Spaces

**Spaces for DeepSeek Harness — switch your DSH workspaces like Discord servers.**

A standalone Electron desktop shell (not a DSH plugin). Left rail of official DSH profiles; right side embeds the official DSH Web UI. Community / open source. Windows / macOS / Linux.

中文说明见下方 [中文](#dsh-spaces-中文)。

## Why

Official DSH profiles isolate the plugin stack, not sessions or workspace groups. Running two profiles at once can race the same JSONL files. DSH Spaces keeps **one shared identity** (API keys, `settings.yaml`) and gives every workbench its own session/storage roots under `$DSH_HOME/hub/<name>/`.

`web` is the unique home profile. It is never patched. Pre-Hub chats stay there.

## vs other launchers

| | DSH Spaces | DSH-Launcher / dsh-desktop |
|---|---|---|
| UI | Discord-style rail + embedded official Web UI | Usually process lists / custom chrome |
| Isolation | Dual-root patch to `hub/<name>/` (sibling of default trees) | Varies |
| `web` | Zero writes | Often treated like any profile |
| Parallelism | Required: one process + port per space | Often sequential |

## Safety design

- **No telemetry.** Nothing is uploaded.
- **`web` zero writes.** Hub never patches `profiles/web/` or the default `sessions/` / `storages/` trees.
- **Backups.** Any write to `cordis.patch.yml` first copies `cordis.patch.yml.bak-<timestamp>`.
- **Atomic writes.** `spaces.json` and patches use same-volume temp + rename (not `%TEMP%`).
- **Start gate.** Workbenches run `dsh --profile <name> --dump-config` first. Missing/wrong row ids refuse to start (A8).
- **Dev sandbox.** Unpackaged builds use `.sandbox/dsh-home`. Tests refuse the real `~/.dsh`.

## Requirements

- Node 22+ (24 recommended)
- Global DSH CLI (`npm i -g @deepseek-ai/dsh@0.1.1-rc.2` or matching)
- Pin `@deepseek-ai/dsh-web-app` to the **same version as the CLI**. npm `latest` may still point at a broken `0.0.1-rc.1`.

## Develop

```bash
npm install
node scripts/setup-sandbox.mjs
npm test
npm run typecheck
npm run validate:isolation
npm run dev
```

Do not run the isolation/lifecycle scripts while the app is using the same sandbox profiles.

## Build

```bash
npm run build
npx electron-builder --win   # or --mac / --linux
```

Installers land in `release/`.

## License

MIT. See `LICENSE`.

---

# DSH Spaces (中文)

**Spaces for DeepSeek Harness — 像切 Discord 服务器一样切换你的 DSH 工作空间。**

独立 Electron 桌面壳（不是 DSH 插件）：左侧官方 profile 图标栏，右侧内嵌官方 Web UI。社区开源，Windows / macOS / Linux。

## 数据规则

- `web` 是唯一根 profile，使用官方默认 `$DSH_HOME/sessions/` 与 `$DSH_HOME/storages/`，**永不打 patch**。Hub 安装前的聊天都归它。
- 其它 profile 都是工作台：双 root 覆盖到 `$DSH_HOME/hub/<name>/sessions` 与 `.../storages`（默认树的**兄弟**目录，禁止嵌进 `sessions/`）。
- 已有非 web profile 首次确认后自动转换（备份 `cordis.patch.yml` 再写 dual-root）。插件栈不动。会话列表从空开始。
- 转换时固定提示：**「你的历史聊天统一由 web 维护，工作台从全新会话开始」**。
- 共享家目录身份：API Key、`settings.yaml`、Agent 预设。不做迁移、不做多套 `DSH_HOME`。

## 安全

无遥测；`web` 零写入；写 patch 先备份；启动前 `dump-config` 校验；开发测试只走沙箱 `.sandbox/dsh-home`。

## 开发

```bash
npm install
node scripts/setup-sandbox.mjs
npm test
npm run typecheck
npm run validate:isolation
npm run dev
```
