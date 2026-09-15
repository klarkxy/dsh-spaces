# Spaces pluginization — Phase 0 + Phase 1

## Current policy (2026-09-15)

Fault policy: [docs/let-it-crash.md](../docs/let-it-crash.md). Activity ledger: [todo.md](todo.md).

Shared isolation, Host plugin, thin desktop, diagnostics, single-writer lock, and fail-closed unknown state remain. **Restore-core, independent rescue, restore CLI, snapshot restore, and Doctor recover/rollback/unlock are not current requirements.** Phase 2/3 must not be built as a recovery product. Remaining runtime work is R1–R6, pending.

> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。

Source: user-approved direction in “评估插件化必要性”, conversation `6aa38ae2-c7fc-83ec-8054-15d81964ac72`.
Branch: `codex/spaces-pluginization`, based on `dfe9ae0ed760ee1e6fe9e9d9e5d057e9451981b7`.

## Delivery scope

Extract host-independent domain/application/ports and reusable Node adapters. Keep all existing Electron features and storage formats. Ship a real installable DSH Host + Web plugin with an additive sidebar entry and independent main panel. Its first API exposes observation, diagnostics and creation/verification of non-host spaces. Preserve independent desktop lifecycle and add a minimal standalone doctor **diagnostics** entry point. Desktop recovery and doctor recover/rollback are historical Phase 0/1 facts, not current requirements.

If Phase 2 continues, it is Web lifecycle control, plugin install/remove, and runtime install/upgrade **without** snapshot restore, rollback, rescue, or interrupted-job resume. **Snapshot restore is 已撤销 (2026-09-15), not deferred Phase 2 work.** Multi-space browser embedding belongs to a separate Phase 3 design. Neither is silently enabled in this MVP.

## Ownership

- Codex: orchestration, shared contract, Git, integration audit and final acceptance.
- Grok through Agent Bridge: core, Node/Desktop/Host adapters, CLI, tests and runtime acceptance evidence.
- Kimi through Agent Bridge: DSH-native browser entry, panel, frontend states and frontend checks.
- Workers do not own Git or invoke Agent Bridge. Write scopes are assigned before implementation; do not overwrite another worker's files.

## Required boundaries

- Derive host identity on the Host side. Never trust client-supplied host identity, paths, commands, package specs or capability claims.
- Unknown runtime/configuration is read-only; explicitly display why capabilities are restricted.
- Deny mutation of the current Host. Browser DTOs must not contain launch tokens, cookies, credential URLs or raw configuration/log secrets.
- Every participating Desktop/Host/CLI writer shares one cross-process lock for the same DSH home. Account for startup/background mutations, not only RPC handlers.
- Keep incomplete operations visible and fail closed. Do not automatically steal a live/ambiguous owner's lock.
- All development and acceptance use disposable homes; do not access production DSH data or invoke models.

## Acceptance

1. Record existing test baseline before edits; distinguish environment failures.
2. Confirm actual installed upstream DSH contracts, not invented shims.
3. Verify shared core is consumed by Desktop and Host, and browser output has no Node/Electron imports.
4. Exercise current-host denial, unknown-version read-only, invalid input, lock contention/release/crash residue and sanitized DTOs.
5. Build and install the packaged plugin into a disposable real DSH profile; verify actual sidebar/main panel and Remote API behavior.
6. Run relevant existing regressions, type checks, desktop build and a desktop runtime smoke.
7. Record evidence and remaining platform limits. No release or push is requested.

## Progress

- [x] Read complete referenced conversation and repository constraints.
- [x] Create requested isolated development branch.
- [x] Dispatch Grok backend and Kimi frontend discovery.
- [x] Agree concrete contracts and implementation scopes (`src/shared/spaces-control.ts`).
- [x] Implement shared core, adapters, plugin and doctor.
- [x] Integrate and independently audit.
- [x] Complete automated and real runtime acceptance.

Final evidence and explicit limits: [pluginization-acceptance.md](pluginization-acceptance.md). Phase 0/1 are implemented. Phase 2, if continued, is lifecycle/plugin/runtime **without** restore. Snapshot restore, Doctor recover/unlock/rollback, and desktop recovery are **已撤销** (2026-09-15), not later-phase work. Current binaries still contain them (R5). Phase 3 multi-space embedding remains a separate design.

## 2026-09-12 continuation — distributable preview

User requests Grok construction with Codex orchestration and acceptance. Preserve Phase 0/1 scope; complete the distribution gaps before Phase 2.

- Grok `distribution_frontend_zh`: client and focused panel tests; Chinese/English UI. Task `task_abaa0ba490`, session `sess_fd1d8ccf7d`.
- Grok `distribution_install`: new distribution validation script and plugin README; actual plugin-manager installation/replacement/removal and snapshot configuration. Task `task_291ff9bca7`, session `sess_f7f8ec176d`.
- Grok `distribution_windows_package`: desktop smoke script supporting a packaged executable and real UI checks. Task `task_0145580b53`, session `sess_9f846651b5`.
- All workers use the executor role instructions through Bridge, Grok default configured model with requested high effort (user model override); no history fork, no Git ownership, no production data or publication. Codex owns shared manifests, build output, integration, final report and local Git delivery. Real browser/Electron acceptance runs serially.

Completion gates: installed artifact RPC/UI; clean uninstall so the official DSH UI remains usable (that is ordinary uninstall, not product restore); Chinese/English behavior; unknown-runtime behavior where an actual compatible-to-load unsupported runtime is available; actual packaged Windows runtime; updated evidence and reviewable local commits. Do not claim untested installer OS registration or untested platforms as accepted. Snapshot restore is not a completion gate.

Completed local acceptance on 2026-09-12: 89 focused tests, TypeScript/build, real Chinese/English browser flow, official CLI add/reinstall/remove with automatic bundle activation, same-profile official RPC after removal, real CLI 0.1.5-rc.2 read-only refusals with unchanged config, and actual Windows installer payload running with `app.isPackaged === true`. See [trial acceptance](pluginization-trial-acceptance.md). Grok added the bundle in `task_bb40507f9e`; the distribution audit correction was `task_c7dcbc522c`. Codex tightened missing-target/error-code and uninstall-overlay checks and addressed the observed upstream shell-path forwarding failure in the acceptance harness.

## Baseline and upstream evidence

- Existing complete test suite: 180 passed, zero failed/skipped; `.sandbox/pluginization-baseline-full.log`. Localhost/process tests fail under the restricted execution sandbox and pass with normal process/network access; the restricted run was stopped and is not a product regression.
- Existing TypeScript checks passed before extraction.
- The previously installed managed CLI 0.1.1-rc.2 has an older sidebar API. The disposable runtime used in prior acceptance contains CLI 0.1.5-rc.1 and resolved DSH SDK packages 0.1.5-rc.2. Its actual declarations confirm `sidebar.panellist` is additive and `main` is keyed.
- Upstream browser artifacts use `window.__ModuleLoader__.load({ id, factory(require) { ... } })`; `react` and `react/jsx-runtime` are supplied by the host module loader. An ESM bundle or a second React copy is not equivalent.
- Upstream `dsh-host-plugin-inventory` provides concrete `TypertRemoteService` and `typert.host` invocation descriptor examples. Integration must use those real contracts.
