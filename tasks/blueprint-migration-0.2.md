# Blueprint ownership and DSH 0.2 migration

Authorized 2026-10-09: move Blueprint maintenance from dsh-plugins into this repository. Blueprint remains an independently installable DSH plugin. Spaces depends on Blueprint for space recipes, creation and blueprint import/export. Both target DSH 0.2.0-rc.2, the registry's current 0.2 release. After the independent Web retest, the user authorized a local commit. Push, publication and production installation remain outside the request.

## Boundary

- `packages/blueprint` owns `@klarkxy/dsh-blueprint`, its current-profile Creator tools and optional page, DSHBP2 protocol and explicit DSHBP1 compatibility exports.
- Spaces consumes the protocol exports and owns space identity, isolation, runtime inspection, installation, jobs and user-requested launch. Blueprint never imports Spaces.
- Existing DSHBP1 presets and receiver-local bindings remain supported. DSHBP2 stays an exact package identity and preferred-order document. A builtin identity is never converted to an npm download.
- Archive data import/export stays separate from a blueprint environment recipe. Existing user data and failed-operation evidence are preserved under `docs/let-it-crash.md`.
- Current uncommitted Blueprint source was copied with SHA-256 inventory before edits; unrelated dsh-plugins work remains outside migration ownership.

## Packaging decision

The current Blueprint source used an unpublished `dsh-plugin-kit` workspace dependency. Registry version 0.1.0 was inspected: its RPC helper fixes the body limit at 64 KiB and cannot accept Blueprint's 2 MiB codes or its current transport options. The standalone package therefore retains its own existing authenticated HTTP adapter, preserving the current admission, cancellation, error envelope and body limits. It does not copy the plugin-kit project or depend on a machine-local sibling checkout.

The pure v1 implementation moves without protocol changes. Its existing large domain module remains together for this format-preserving move; this does not introduce another format registry or generic migration framework.

## Acceptance — local migration complete

- [x] Independent packed package and declared exports, installed outside both repositories.
- [x] Existing v1 tests and v2 standalone tests.
- [x] Spaces v2 create/import/export including builtin identity and ordering checks.
- [x] DSH 0.2 type/build/contract regressions and isolated host workflows.
- [x] Actual browser creation and export/import workflow.
- [x] Old source/release ownership retired, unrelated dirty files preserved.
- [x] Independent integrated review, including final runtime-discovered corrections.

### Source, package and test evidence

- Blueprint tests: 94/94. Detached tarball installation verified plugin root, Core, codecs, v1/v2 document exports, schema and declarations with only published dependencies. Core's exported Blueprint types have an explicit package dependency.
- Combined Blueprint regression run: 220 passed, 8 skipped. Subsequently moved the legacy official-host cases from the obsolete 0.1.5 pin to actual 0.2.0-rc.2 and connected all four runtime/workbench test files to CI's explicit CLI path: 69 passed, no skips. The official group dependency is 1.0.4.
- Spaces suite: 129 passed, 1 skipped. LLM suite: 79 passed. SDK-focused checks: 107 passed, 4 platform symlink skips. Dashboard checks against the real SDK: 27 passed.
- Workbench suite initially had one outdated handoff fixture among 506 tests (503 passed, 2 skipped). The fixture now declares valid component bundles; its entire 18-test handoff suite passed afterward.
- Spaces type checks, full application type checks, Spaces packaging and Electron build passed. These are build evidence, not installed Desktop acceptance.
- Old Blueprint source: 33-file hash inventory matched before retirement. The old tree is retained under `H:/Code/dsh-plugins/.scratch/blueprint-migration-20261009/plugin`; 53 unrelated dirty files kept identical hashes. Retirement receipt: `.sandbox/blueprint-migration/source-retirement.json`.
- Independent review caught and verified repairs for bare DSH peer compatibility, Core's exported type dependency and disabled-condition ancestry. Final migration tests: 36/36 passed; reviewer independently reran 18 focused cases and both official-semantics probes. Failure markers and partial operation results remain preserved; no retry, rollback or recovery workflow was added.

### Final local artifacts

- Standalone Blueprint: `.sandbox/blueprint-migration/klarkxy-dsh-blueprint-0.2.0-alpha.1.tgz`, SHA-256 `5f0f949d252d731d7e3d5b39e91edb6fbdb69e90b27f07f8068870a620853ce4`. Final repack changes acceptance documentation only from the detached/runtime-tested source.
- Spaces: `.sandbox/blueprint-migration/spaces-pack-verified/dsh-spaces-plugin-0.4.0.tgz`, SHA-256 `12cae8ffbbf541feba5885a3d36be65b06c2ddf6d755d10b63321f0201c8bf41`. Verified embedded payload digest: `a1e6cbb872ba0325736cc99cdd8e724bf67f0c96d9ba192aabb5a681c14d09ba`.

### Actual host evidence and verification limits

Official CLI 0.2.0-rc.2 plus real Chromium loaded the independently packed Blueprint plugin. Its inventory, code generation, parsing, invalid-code feedback and Creator-request copy interaction passed. This does not certify model-driven Creator execution or installed Desktop behavior.

Actual Spaces workflows exposed and corrected three defects beyond SDK compilation: official dynamic `disabled` conditions incorrectly blocked migration; a new submission could claim a historical completed job before its response arrived; and a redirected manager iframe lost clipboard-write delegation because the bare iframe directive was bound to the initial Supervisor origin. The final code preserves known disabled states, correlates requests before submission, observes authoritative jobs after an uncertain transport response, and delegates clipboard write only to the verified manager origin. Long share codes wrap without changing their contents.

Package validation now reports a fixed known cause by error code, never raw installer/archive messages. The local nonstandard fixture tarball was correctly rejected before installation; it used `fixture-package/` instead of npm's canonical `package/`. Both failed jobs remain failed. A new fixture version produced by `npm pack` passes strict validation and is used for the final npm workflow.

Before the final candidate, actual Chromium passed builtin v2 creation, exact identity/order export, JSON download, exported-code import into another stopped space and independent standalone decoding. v1 session-title presets survived creation, export and independent parsing without local isolation paths.

The final packed candidate in a fresh isolated Home passed:

- Initialization on actual official DSH 0.2.0-rc.2 and creation of a space with the canonical npm fixture 0.2.0; new spaces remain stopped.
- Default v2 export with exact npm identity and bundle order, successful real copy-button interaction, and JSON download.
- Import of the actual exported code and upload of its downloaded JSON into two new spaces, both successful and stopped.
- Long-code layout at 1280×720: `clientWidth=scrollWidth=720`, `overflow-wrap:anywhere`, original text unchanged.
- A deliberately invalid archive after prior successful jobs: switching to Generate and back still displays the current space `delivery-bad`, fixed manifest-missing cause, failed package stage, and unexecuted presets/start. Prior successes are not displayed as this request's result.
- Normal `service.shutdown` completed successfully for both successful test groups; the final Supervisor and manager stopped through the product operation. Browsers and the separate original test host were then closed as test cleanup.

Final screenshots and machine-readable evidence: `delivery-npm-export.png`, `delivery-export-result.txt`, `delivery-roundtrip-result.txt`, `delivery-invalid-archive-failure.png`, and `delivery-failure-state.json` under `.sandbox/blueprint-live-acceptance/`. The npm fixture cache was prepared before Spaces launch; this proves the real verified-cache/install/UI path, not a live public-registry download. Registry transport remains covered by automated tests.

`final-identity-and-integrity.json` confirms the final archive hash, actual CLI/plugin versions, standalone Core decoding agreement and absence of `profiles/web`, default `sessions` and default `storages` in every final test Home. `delivery-shutdown.json` records the successful normal shutdown job. `final-cleanup.json` confirms no remaining tested listeners/processes and no final Home owner/endpoint records.

Installed Desktop, model-driven Creator execution, multi-platform distributions, remote CI/publication and sustained operation were not tested in this local migration.

Additional final failure regressions: 100 passed, 4 file-symlink skips; historical-job, submit-transport and fixed-error-cause probes independently passed review. Clipboard browser regressions: 7/7 passed, including the production three-origin portal, the previous failing bare-origin policy, missing parent delegation and continued clipboard-read denial; HTTP regressions: 9/9 passed. Failed candidate Homes and logs are retained; tests do not replay interrupted operations.

Evidence is under `.sandbox/blueprint-migration/` and `.sandbox/blueprint-live-acceptance/`. No real DSH Home was read or written. Initial test setup lacked the official Documents workspace override; the directory predated the test, and child writes were not established. Fresh Homes use an explicit sandbox workspace directory. No commit, publication or production install was performed.

### Independent Web retest and local commit — 2026-10-09

The user requested another actual Web test, then authorized a local commit. The current source was rebuilt and packed; its Spaces archive SHA-256 still matches `12cae8ffbbf541feba5885a3d36be65b06c2ddf6d755d10b63321f0201c8bf41` above. Official DSH 0.2.0-rc.2 and a fresh Chromium session used a new isolated Home.

Four creation jobs succeeded: npm fixture, exported share code, downloaded JSON file, and v1 session-title presets. Builtin identities and bundle order survived v2 export/import. Actual copy-button interaction followed by keyboard paste matched the share code exactly; at 1280×720 the code's client and scroll widths both measured 720 px. The v1 export retained all three session-title values, and the standalone decoder agreed with its JSON contents.

A fifth job deliberately used an invalid archive. It failed with the fixed manifest-missing cause for the current space; presets and startup were not run, and switching tabs did not show a historical success. Browser errors and warnings were both zero. All new spaces remained stopped; protected default paths were absent. Normal `service.shutdown` succeeded, and test host, Supervisor, owned child processes, listeners and owner/endpoint records were absent after cleanup.

Fresh evidence: `.sandbox/web-retest-20261009/result.json`, `cleanup.json`, downloaded blueprints and screenshots. Test artifacts remain outside Git. The npm fixture was cached before launch; this does not prove a live registry download. Installed Desktop, model-driven Creator and sustained operation remain untested. This commit records local delivery only; no push or publication was requested.
