# Acceptance record

## Spaces repository migration — 2026-10-09

Current maintenance lives in `packages/blueprint` in dsh-spaces. The standalone
package targets official DSH 0.2.0-rc.2 and remains installable without Spaces.
Version 0.2.0-alpha.1 is a local unpublished candidate.

- 94/94 standalone tests passed. v1 compatibility code and schema now ship through
  explicit package exports; Spaces consumes the shared document interfaces.
- A packed tarball installed outside both repositories passed plugin/Core/codec,
  v1/v2 document, schema and dependency checks. There is no workspace-only runtime
  dependency or reverse import into Spaces.
- Actual official 0.2 host and Chromium admitted the plugin and exercised inventory,
  export/code generation, parsing, invalid-code feedback and Creator-request copy.
- Native Creator execution, permission denial and guarded ordering retain automated
  coverage; a model-driven live Creator import and installed Desktop were not tested.
- No npm publication, production installation or real DSH Home access occurred.

The repository's `tasks/archive/blueprint-migration-0.2.md` separates Spaces integration
acceptance from this standalone evidence. Local test artifacts live under
`.sandbox/blueprint-migration/` and `.sandbox/blueprint-live-acceptance/`.

## Historical redesign evidence — 2026-09-30

This record separates offline checks from real-host acceptance. The implementation now
uses environment-independent protocol/Profile Core, Creator guidance and tools, native
`plugin_manager` for package operations, a guarded permutation-only order adapter, and
an optional read-only plugin page. The old additive preview/apply engine is removed.
DSHBP2 fields, encoding, limits and checked-in vectors remain compatible.

### Completed checks

- 86/86 Blueprint tests passed on Windows using bundled Node and
  `node --test --test-isolation=none plugins/dsh-blueprint/tests/*.test.mjs`.
  Coverage includes strict JSON/code validation, malformed whitespace bounds,
  portable vectors, installed-identity export, optional Core loading, authenticated
  HTTP RPC, retired mutation endpoint rejection, Creator prompt lifecycle,
  protocol tool registration/disposal, native approval argument/denial/cancellation,
  page registration/parsing/copy-request behavior and late-reply invalidation.
- Order adapter tests use isolated temporary profiles and injected official helpers:
  exact permutation, no omission/addition/disablement, stale state checked under lock,
  protected positions and segment boundaries, metadata preservation, no-op,
  HMR-before-file-lock sequencing, root reconciliation, startup restart requirements,
  cancellation before/after commit, missing helper contracts, partial application failure,
  private-safe failure reports, and no rollback/retry.
- Package build passed through `pnpm --filter @klarkxy/dsh-blueprint run build`.
  The script checks all shipped JavaScript modules; no transpilation is required.
- Plugin settings registration regression: 1/1 passed.
- Editor plugin integration/build regressions: 16/16 passed across four test files.
- `git diff --check` passed (Git emits existing LF/CRLF conversion notices).
- `npm pack --dry-run --ignore-scripts` passed: Core, tools, order adapter, skill,
  optional Client, protocol and vectors are included; retired engine and tests/cache
  are not packaged. This check does not publish or install anything.
- Independent read-only review found no confirmed actionable defect in the redesigned
  implementation and verified the native approval/locking/reconciliation call paths.

### Official evidence and execution constraints

Public exports and native reference implementations were read from installed official
CLI **0.1.7-rc.2**: sandbox `approveEscalation`; plugin-manager `saveManifest` exported
through `./operations`; atomic `withFileLock`; app-boot `readProfilePatches` and
`reconcileProfilePatches`. Runtime Inspect confirmed tools, pluginManager, sandboxPolicy,
agentPresets, HMR and keyed `plugins.bundle.config` contracts.

Official documentation consulted:

- [Tools](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/tools.md)
- [Dynamic Cordis](https://deepseek-harness.github.io/deepseek-harness/en/develop/practice/dynamic-cordis.md)
- [Client modules](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/client-modules.md)
- [Slots](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/slots.md)
- [Cordis lifecycle](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/index.md)

Website docs are current/unpinned. Matching-tag remote retrieval failed with a network
provider error, so version-specific helper evidence came from installed rc.2 types and
source instead. Desktop asar reads failed tool-side; its exact runtime version remains
unverified. Some Client Inspect requests timed out; no Agent-send API was assumed.

Normal isolated Node tests/esbuild encountered the sandbox's child-process `EPERM`
boundary. Package tests were run without subprocess isolation; editor regressions and
pnpm build completed after exact-command one-shot native approval. Session permissions
were not changed. pnpm warned that the repository's root `pnpm` settings are ignored
by the supplied pnpm version; no unrelated package-manager settings were altered.

### Remaining acceptance

- Actual loading of this redesigned source/tarball in a real DSH host, complete Creator
  import with native package operations and permission denial, and post-merge runtime
  diagnostics have **not** been tested.
- Real desktop browser layout/copy interaction and ACP/SDK/headless startup/restart
  scenarios have **not** been tested. Offline VM UI tests are not browser certification.
- Protected positions/segments are conservative structural guards, not a proof of all
  reordered patch semantics. The stamp covers manifest and bundle catalog, not every
  overlay or patch content revision. HMR reconciliation rereads current complete layers.
- Native install/enable may already have succeeded before a later ordering failure.
  `saved` and `application` are reported separately; no whole-import transaction exists.
- No production profile, installation, credentials, publication, deployment or current
  GUI artifacts were changed. The full workspace check was not claimed green; existing
  unrelated edits were preserved.

## Historical evidence — previous page-only additive implementation

On 2026-09-28, the former implementation had 97 passing tests and isolated packed-host
browser checks with a host list-toolbar patch. Those checks exercised fixed append-only
imports, previews, one-use plans and page confirmation. They do **not** certify the new
Creator execution policy or the removed engine. Historical local evidence under
`.scratch/blueprint-fix/` is not a shipped asset. The optional bundle page now needs no
list-toolbar host patch.
