# Changelog

All notable changes to DSH Spaces are recorded here. This project follows Keep a Changelog style; version ranges follow the repository's own 0.x policy.

## [Unreleased]

## [0.5.0] — release candidate, not published

### Added

- The Spaces plugin now runs inside compatible DSH Web and Desktop hosts, with the original application preserved and a space rail added.
- Four main-space Creator tools: `spaces_context`, `spaces_create_preview`, `spaces_create_execute` and `spaces_job` for one frozen, serial creation plan.
- Main-space space-control tools for lifecycle, plugin, runtime, model-policy and bounded UI automation work: `spaces_overview`, `spaces_inspect`, `spaces_logs`, `spaces_templates`, `spaces_import_preview`, `spaces_plan`, `spaces_execute`, `spaces_control_job` and `spaces_ui_*`.
- Main-model inheritance for new ordinary Web spaces without copying main-space credentials.
- Desktop rail open/start/stop/restart actions and preserved background service failure reporting.
- Ordinary templates and `.dshspace` sharing remain available; Browser Space and Spaces blueprint entry points remain sealed.

### Changed

- The default DSH runtime for new installations, the build SDK and CI now target `0.2.2-rc.1`; existing supported runtimes remain pinned per space, with `0.2.0-rc.2` as the minimum.
- Spaces upgrades use the host plugin manager, a normal service stop and a reopen; there is no in-app self-update or launcher handoff.
- Without a bound DSH CLI, Spaces now fails with a typed error instead of installing a managed CLI; the Node toolchain download makes a single attempt with no `curl` retries.
- Doctor JSON reports `writeBlocked` instead of the misleading `rollbackRequired`; the always-equal `writeAllowed` field and the unused recovery exit code `10` were removed.

### Removed

- The legacy shared LLM connection library and its space bindings. Current model sources are main-space inheritance and local/session selection.
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
