# B5 组件 payload 清单（Grok 施工叶）

2026-09-20。叶子只写了这五个文件：

- `src/adapters/node/component-payload.ts`
- `tests/component-payload.test.ts`
- `scripts/build-spaces.mjs`
- `scripts/pack-spaces-plugin.mjs`
- `tasks/merge-b5-component-payload.md`

未改 Git、bootstrap、`package.json`、electron-builder / `electron.vite.config.ts`、shared DTO、Supervisor 读取路径。未读真实 `~/.dsh`，未委派 Bridge，未跑 `build:spaces` 或全套测试。

现行故障政策仍是 [let it crash](../docs/let-it-crash.md)。构建合同：[merge-contract-v2.md](merge-contract-v2.md)「构建与正常升级」。架构审查结论：扩展现有 `lib/supervisor/manifest.json`，不增加通用组件 registry。

## 结论

同一份 Supervisor 兼容清单现在是 **schemaVersion 2 / protocolVersion 2** 的五组件不可变 payload。顶层仍保留 `version` + `entry: "index.js"`，现有 `readPayloadManifest` 可以继续只读这两项。typed 数据覆盖 Supervisor、manager-plugin、view-bridge、llm-bridge、installation-worker：包名、从各 `package.json` 读到的精确版本、入口、文件 sha256（64 位小写 hex）、size、`source: "bundled"`、`protocolVersion: 2`。

清单**不包含自己的摘要**。整体 `digest` 由校验函数对稳定 manifest 与 declared file hashes 计算，不写回 JSON。缺组件、缺资产、未知 schema/protocol/组件名、重复路径、绝对路径、`..`、NUL、符号链接/junction、大小或摘要不符，一律抛 `ComponentPayloadError`，不返回 null，不 seed。

## 精确 API（给主 Agent 集成）

```ts
import {
  writeComponentPayloadManifest,
  validateComponentPayload,
  copyComponentPayload,
  COMPONENT_PAYLOAD_MANIFEST_REL, // "lib/supervisor/manifest.json"
} from "../adapters/node/component-payload";

// payloadRootLib = plugin package 的 lib 目录
// packageRoot    = dirname(payloadRootLib)
const written = writeComponentPayloadManifest("packages/plugin/lib");
const checked = validateComponentPayload("packages/plugin/lib");
const copied = copyComponentPayload("packages/plugin/lib", destPackageRoot);
```

`ValidatedComponentPayload`：

| 字段 | 含义 |
|---|---|
| `manifest` | 已规范化的 v2 对象 |
| `digest` | 64 hex，稳定 manifest + 声明文件哈希 |
| `files` | 精确声明集合（不含 manifest 自身），按 path 排序 |
| `packageRoot` | `dirname(payloadRootLib)` 的真实目录 |
| `payloadRootLib` | 传入的 `lib` 真实目录 |

`copyComponentPayload(sourceLib, destPackageRoot)` 只按清单列文件复制到新不可变 package 根，再校验。dest 已存在且 digest 相同则直接返回；dest 已存在但内容不同则拒绝、不覆盖。复制中途失败保留 dest 作诊断，不删除不明目录。它不是通用复制器：源树里的 `src/`、`node_modules/` 不会被选中。

构建侧：`build-spaces.mjs` 在 supervisor / view-bridge / llm-bridge 资源都进 plugin 包之后，把本模块 esbuild 到临时 scratch，再调用 `writeComponentPayloadManifest`。缺资产则构建失败。生成结果同时写到 `packages/plugin/lib/supervisor/manifest.json`，并回拷 `packages/supervisor/lib/manifest.json`。为读精确 Supervisor 版本，构建会把 `packages/supervisor/package.json` 放进 `lib/supervisor/package.json`。

## 桌面打包（本叶未改 packaging 配置）

应复制**同一个 plugin packageRoot**（`packages/plugin`，不是只拷 `lib`）到 `resources/spaces-payload`。main 消费：

```text
resources/spaces-payload/lib
```

即 `validateComponentPayload(join(process.resourcesPath, "spaces-payload", "lib"))`。

当前 `resolveSpacesPayloadRoot` 在 packaged 时仍返回 `resources/spaces-payload`（没有 `/lib`），且 `package.json` `build.extraResources` 尚未接入。那是后续包装 worker / 主 Agent 的接线，不在本叶。开发态继续是 `packages/plugin/lib`。

`copyComponentPayload` 是之后 bootstrap 整组 immutable 拷贝的 port。**本叶未改 `supervisor-bootstrap.ts`。** 现有冷启动仍只按 Supervisor 子目录 + v1 `version`/`entry` 复制。

## 实测

未跑 `build:spaces`（其它 worker 正在迁移 types）。命令：

```text
npx tsx --test tests/component-payload.test.ts
node scripts/pack-spaces-plugin.mjs --preflight
```

结果：

- 组件测试 **14 pass / 0 fail / 1 skip**
- pack preflight **PASS**（静态必需文件存在、dry-run 含 payload、排除嵌套 tgz）。当前工作树里的 `packages/plugin/lib/supervisor/manifest.json` 仍是旧 v1 `{version,entry}`，因为没有跑 `build:spaces`。preflight 只检查文件存在，不要求磁盘上已经是 schemaVersion 2。

覆盖：完整五组件 dummy fixture；缺 llm-bridge；缺 installation-worker；v1 拒绝；未知 schema/protocol；篡改哈希；`..` / 绝对路径 / 清单自引用；重复路径 / 未知组件名 / `latest`；copy 不带 `src/` 与 `node_modules/`；dest 已有不同内容不覆盖。

Windows 文件符号链接：本机 `symlinkSync(..., "file")` 得到 **EPERM**，该用例 skip，文案为 `external file symlink is not testable on this Windows account`。**目录 junction 可测且已拒绝。**

未跑真实 tarball 安装、Electron extraResources、最终安装包。不得把本叶说成制品已通过。

## 主 Agent 后接

1. 在 types 稳定后跑 `npm run build:spaces`，确认生成的 v2 清单五组件齐全、digest 为 64 hex、现有 Supervisor 仍能读 `version`/`entry`。
2. 包装：`packages/plugin` → `resources/spaces-payload`；main `payloadRoot` 改为 `.../spaces-payload/lib`。
3. 之后把 bootstrap 的整组拷贝换成 `copyComponentPayload`（本叶未做）。
4. 不要 npm publish。pack 脚本仍声明 `unpublished: true`。
