> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。
# XP 嵌入兼容适配（审计重试交接）

日期：2026-09-12。分支：`codex/spaces-pluginization`。角色 executor。未 Git、未发版、未改 root 接口/构建/UI、未改 fixture、未跑真实 DSH/Chromium。只写本叶三文件。

状态：**模块审计项已修，单测可复跑。产品未通过。** 根作者接入安装预览并做真实 Chromium 后才能验收。

## 结论

`dsh-client-ui-theme-xp@0.1.1` 不能原生在 iframe 里当桌面。适配仍是显式、仅针对该空间的 `client.js` 替换；内部聊天 iframe 保持聊天模式。hint 只证明此视图受监督，不授管理权。

## 产物

- `D:\0 code\dsh-spaces\src\adapters\node\xp-compatibility.ts`
- `D:\0 code\dsh-spaces\tests\xp-compatibility.test.ts`
- `D:\0 code\dsh-spaces\tasks\workbench-xp-compatibility-worker.md`

未改：`D:\0 code\dsh-spaces\tests\fixtures\xp-original\{client.js,package.json,LICENSE}`

## 本轮修正

1. **有效轻量桥 hint**：`parentOrigin` + `spaceId` + `generation` + `channel` 均须存在且通过 `packages/view-bridge/src/env.ts` 同类规则（loopback `127.0.0.1` origin、`PROFILE_NAME_RE` / `web`、非负 `Number.isSafeInteger` generation、channel `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`）。仅 `{parentOrigin}` 为 false。`parentOrigin` origin 须不同于 `location.origin`。
2. **`frameElement` getter 抛错** → 身份未知 → `false`，不再当 `null` 放行。
3. **`XP_EMBED_COMPATIBILITY_NOTE`** 一句中文，给用户维护预览；不含 SHA/路径。hash 只在导出常量与 `.dsh-spaces-xp-compat.json`。英文可选，无新翻译层。
4. **测试改读** `tests/fixtures/xp-original/`。fixture 87 129 字节、MIT、original SHA256 不变。
5. **`applied`**：本次调用是否替换了 `client.js`。首次 `true`，幂等 `false`，hashes 相同。异常路径不改未知原包。

## API

```ts
applyXpEmbedCompatibility(home, spaceId): {
  applied: boolean; // first-call-only：这次是否写下 client.js
  packageName: "dsh-client-ui-theme-xp";
  version: "0.1.1";
  originalSha256: string;
  patchedSha256: string;
}

XP_EMBED_COMPATIBILITY_NOTE
// 当前 XP 主题不能原生在 iframe 里作为桌面运行；确认后只会为这个空间做桌面嵌入适配，内部聊天窗口保持原样。

XP_ORIGINAL_CLIENT_SHA256  // 64f1f7e3555237c637112091647932e1418aca5f0d3ba399e261d94a33c83ee0
XP_PATCHED_CLIENT_SHA256   // b87a28bc1650668e019e2588e2bac5c1259f1e0a631ca8ed2601d4be66eec8e3
XP_COMPAT_RECORD_NAME      // .dsh-spaces-xp-compat.json
XpCompatibilityError.code  // invalid-input | not-found | unsupported | hash-mismatch | out-of-profile
```

用户主流程只用 NOTE。验收文档由 root 写 hash。

## 验证

```
npx tsx --test tests/xp-compatibility.test.ts
npx tsc --noEmit --strict --skipLibCheck --module ESNext --moduleResolution bundler --target ES2022 --isolatedModules --allowImportingTsExtensions --esModuleInterop --types node src/adapters/node/xp-compatibility.ts
```

覆盖：原 8 项（portable fixture 替代 sandbox Home）+ 残缺/非法 hint + `frameElement` getter 抛错。fixture 在 apply 后仍为 original hash。

## 未验证

真实 Chromium、安装预览接线、外侧空间栏切换、真实 pnpm 全局 store。未宣称产品通过。
