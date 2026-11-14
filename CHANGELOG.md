# Changelog

All notable changes to DSH Spaces are recorded here. This project follows Keep a Changelog style; version ranges follow the repository's own 0.x policy.

## [0.5.0] — release candidate, not published

### Added

- Local rotating JSONL diagnostics for the host, Supervisor and managed-space output: `debug`/`info`/`error`/`fault` levels, seven-day or 100 MiB active-file rotation, seven-day/100 MiB archive retention, and an `info` default for npm/package builds. Credentials, bootstrap tokens and local paths are redacted before disk writes; log failures never trigger recovery.
- The Spaces plugin now runs inside compatible DSH Web and Desktop hosts, with the original application preserved and a space rail added.
- Four main-space Creator tools: `spaces_context`, `spaces_create_preview`, `spaces_create_execute` and `spaces_job` for one frozen, serial creation plan.
- Main-space space-control tools for lifecycle, plugin, runtime, model-sync and bounded UI automation work: `spaces_overview`, `spaces_inspect`, `spaces_logs`, `spaces_templates`, `spaces_import_preview`, `spaces_plan`, `spaces_execute`, `spaces_control_job` and `spaces_ui_*`.
- One-time main-space model sync (`models-sync` at creation, "Sync models from the main space" in workbench space detail, and `models.sync` in `spaces_plan`): copies the main space's `llm-pi-ai` routes, `llm-deepseek` settings, default model and the keys those routes reference so each space calls providers directly with its own configuration. Manual sync shows and rechecks a non-secret preview before any write. Running spaces use their own settings/credentials Remote interfaces, stay running and apply the new configuration to the next model request; stopped and crashed spaces use direct file writes. Login-grant and expression routes are skipped and listed in the preview and job result.
- The three space rails draw a breathing attention halo around a space whose sessions have a pending tool approval or `ask_user_question` card; the halo is presentation only and reports `unknown` when no fresh view-bridge report exists.
- Desktop rail open, start, stop, restart and "Open space settings" actions, plus preserved background service failure reporting.
- Ordinary templates and `.dshspace` sharing remain available; Browser Space and Spaces blueprint entry points remain sealed.

### Changed

- Plugin discovery now uses the published dsh-plugins catalog, including bilingual descriptions, categories and exact npm coordinates. The bundled snapshot excludes shared service libraries and example entries; installation rechecks published npm versions and honors the selected package source.
- Desktop startup preferences run only on a new Desktop launch, through the serialized job queue. Web launches and confirmed service-only restarts leave child spaces stopped. State decoding accepts the preference and defaults it to off for older service responses.
- Live model sync replaces same-named routes instead of keeping obsolete nested settings and verifies written configuration values. Diagnostic logging preserves Node's fatal rejection behavior and redacts known credential values before recording Remote failures.
- Live plugin batches preserve completed, failed and unattempted target outcomes. Completed offline plugin operations refresh the open space's plugin inventory.
- Space detail now shows the target's saved model state on General, including its default model, route count and incomplete settings. Running model sync confirmations state that the space stays running and the next request uses the new configuration; running plugin install, remove and toggle operations apply live through the space's `pluginManager` without stopping the space and let the user choose when to restart if needed (`cleanup-manager` and `space.runtime.set` retain their stop/restart confirmations).
- Space-scoped workbench plans validate only their affected target spaces rather than unrelated `stateRevision` changes and check plan TTL on submit so queued plans do not expire while waiting; workbench busy state is scoped per space so unrelated spaces can queue operations behind the single-writer job queue.
- Settings UX refinements: settings navigation is consolidated into four items (`Spaces`, `Templates`, `General` with collapsible `Advanced` settings for package source, plugin catalog URL and port range with dirty-state tracking, and `Maintenance` combining service status, jobs, Home backups, DSH runtimes, workbench logs and service stop); space rows open space settings on click and unify `Space settings`, lifecycle, `Export share file`, `Save as template`, move up/down, rename, icon and delete with an explicit data-removal checkbox under a single `⋯` / context menu (removing the duplicate export card from space detail); space detail keeps internal IDs under `Advanced`, shows manager-cleanup only when `@dsh-spaces/plugin` is misinstalled, and supports manual diagnostic refresh; `Create space` unifies `Blank`, `From template` and `.dshspace` `Import from file` modes with display-name-first input, auto-derived IDs, start-after-create and collapsible advanced fields, while `Templates` focuses on using or deleting saved local templates; plugin catalog cards group by category with installed badges, one-click latest preview install and inline version selection; common job progress messages are localized and backups explain their offline archive directory.
- UI copy cleanup across the workbench, Desktop rail, portable host guide and Browser preview: redundant explanatory paragraphs, scope-help modals and verbose policy disclaimers were removed or tightened in both Chinese and English while preserving action impact warnings and failure details.
- The default DSH runtime for new installations, the build SDK and CI now target `0.2.2-rc.1`; existing supported runtimes remain pinned per space, with `0.2.0-rc.2` as the minimum.
- Spaces upgrades use the host plugin manager, a normal service stop and a reopen; there is no in-app self-update or launcher handoff.
- Without a bound DSH CLI, Spaces now fails with a typed error instead of installing a managed CLI; the Node toolchain download makes a single attempt with no `curl` retries.
- An older space drops the retired `@dsh-spaces/llm-bridge` bundle once through the official `dsh plugin remove` at its next start; an interrupted removal keeps its alignment marker as evidence.
- Doctor JSON reports `writeBlocked` instead of the misleading `rollbackRequired`; the always-equal `writeAllowed` field and the unused recovery exit code `10` were removed.

### Removed

- Live main-model delegation and the legacy shared LLM connection library: the `@dsh-spaces/llm-bridge` component, the main host's LLM services and image helper entry, the `--llm-bridge-artifact` Supervisor flag, the `llm-policy.set` control operation and `hub/<id>/llm-policy.json` writes.
- Standalone desktop distribution and in-place upgrade from the 0.4.0 desktop application.
- Public recovery orchestration, snapshot/config restore, Doctor recover/unlock/rollback, legacy desktop leases and runtime `current.json` pointers.
- The unused `DSH_SPACES_PACKAGED` environment bypass of the real-Home write guard.

### Known limitations

- Browser Space and Spaces blueprint workflows are sealed in 0.5.0; their implementations remain in the repository.
- There is no in-place upgrade or migration from the 0.4.0 standalone desktop application; old spaces are not migrated.
- `@dsh-spaces/*` packages are not published to npm; the prebuilt plugin tarball is the install unit.
- Windows is the locally verified platform for this release; macOS and Linux are not certified, and remote HTTPS or arbitrary third-party native hosts remain unsupported.
- Existing ordinary-space bridges are not automatically realigned to a new component group; presence of a bridge does not prove version alignment.
- There is no automatic retry, restart, rollback, restore, repair or interrupted-job replay. Only the bounded Desktop service start/restart exception in the fault policy is allowed.
- Unregistered manual DSH processes are outside managed discovery and shutdown; backups cover known stopped managed spaces only.
- Space isolation is not a malicious-plugin sandbox, multi-tenant boundary or cross-machine high-availability mechanism.
- Real-Desktop end-to-end acceptance is still incomplete for `plugin.live.*` operations and the `spaces_ui_*` approval flows.

## [0.4.0] and earlier

See the historical release notes for [0.4.0](tasks/archive/releases/v0.4.0.md), [0.3.1](docs/releases/v0.3.1.md), [0.3.0](tasks/archive/releases/v0.3.0.md) and [0.2.0](tasks/archive/releases/v0.2.0.md).
