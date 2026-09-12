# Plugin bundle layer (`dsh.bundle.patch`)

日期：2026-09-12。叶子 `executor_bundle`。未跑 `npm pack` / 构建 / 真实 Host。

后续主 Agent 已通过真实 CLI 安装、自动启用、同版本替换与同 profile 卸载验收，见 [可分发试用验收](pluginization-trial-acceptance.md)。本文件下文保留施工交接时的验证范围。

官方契约来自 CLI `0.1.5-rc.1` 安装树：

- `@deepseek-ai/dsh-web-app` / `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-acp-app` 的 `package.json` + `cordis.patch.yml`
- `@deepseek-ai/dsh` `lib/plugin-Ddi42qoW.js`：`dsh.bundle.patch` 存在才把包装进 `dsh.profile.bundles`；remove 后依赖不再是 bundle 则从列表剔除
- `@deepseek-ai/dsh-app-boot` `loadProfileDirectory`：按 `join(packageDir, dsh.bundle.patch)` 加载层
- `@deepseek-ai/cordis-plugin-include` `applyEntryPatches`：无 `id` 的 `insert` 追加行；有 `id` 无 `insert` 的补丁按 id 覆盖（整份 `config` 替换，不是深合并）；目标不存在则 warn 并跳过

## Manifest 精确改动（`packages/plugin/package.json`）

未改：`name`/`version` `0.2.0`、`main`、既有 `exports`（`.` / `./typert` / `./remote` / `./client` / `./package.json`）、`dsh.client`、`peerDependencies`。

新增：

| 字段 | 值 |
| --- | --- |
| `dsh.bundle.patch` | `"./cordis.patch.yml"` |
| `exports["./cordis.patch.yml"]` | `"./cordis.patch.yml"` |
| `files` | 在原 `lib` / `README.md` / `LICENSE` 后追加 `"cordis.patch.yml"` |

新文件 `packages/plugin/cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-spaces
      name: '@dsh-spaces/plugin'
      config: {}
```

`dsh plugin add` 后应自动：依赖写入 profile、`dsh.profile.bundles` 含 `@dsh-spaces/plugin`、组合 dump 出现 `id: dsh-spaces`。
`dsh plugin remove @dsh-spaces/plugin` 后应自动：依赖与 bundles 层去掉，bundle insert 不再参与组合（不再残留 Loader 行）。

## 分发脚本应从手动 insert 改为自动启用

`scripts/verify-spaces-distribution.mjs`（本叶只读，由分发 worker 改）：

1. **停止**用 `upsertPluginInsert` / 向 `profiles/<host>/cordis.patch.yml` 追加 `- insert: [{ id: dsh-spaces, name }]`。那是用户层，`plugin remove` **不会**删它，这正是残留原因。
2. 安装后断言改为官方层：`inBundles === true`，且 **尚未**写用户 patch 时 `dump-config` 已包含 `@dsh-spaces/plugin` / `id: dsh-spaces`。`inspectPluginBuild` 里 `dsh.bundle.patch` 缺失应变为硬失败，不再 `defect` 后继续手动 insert。
3. **snapshotRoot 用 id-only 覆盖**（用户层，bundle insert 之后才有效）。`applyEntryPatches` 会整份替换 `config`，因此覆盖必须重写完整 config，不要再 `insert` 一行：

```yaml
- id: dsh-spaces
  config:
    snapshotRoot: "D:/absolute/path/to/snapshots"
```

不要带第二个 `insert`，不要改 `name`（name 不一致会被 skip）。无 snapshotRoot 时不要写这条，Host 保持 `config: {}`，面板按现有逻辑报 snapshots unavailable。
4. remove 后：dump **不应**再出现 `@dsh-spaces/plugin`。若验收写过 id-only 覆盖，可删掉以免留下无效 warn；留下也不再启用插件。不要再期望 remove 清掉手动 insert。
5. README（分发 worker 所有）应删掉“无 `dsh.bundle.patch`、必须 Loader insert”的段落，改为 `dsh plugin add` 即启用；snapshotRoot 一节改为上面的 id-only 示例。

`--patch` 叠加层同样可以 id-only 覆盖，本包默认不写路径。
