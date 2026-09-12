# DSH Spaces Web plugin — Phase 1

Spaces adds a navigation entry and a separate management panel inside DSH Web. The official chat interface remains available. The Host performs filesystem and CLI operations; the browser receives only typed, limited business data.

## Build and install

From the repository root:

```sh
npm ci
npm run typecheck:spaces
npm run build:spaces
npm pack ./packages/plugin
```

Install the packed tarball with the official plugin command. Pass an **absolute** path: `dsh plugin` runs `pnpm` with cwd = the profile directory, so a relative `./….tgz` is resolved against the profile, not the shell cwd. The launcher forwards remaining arguments to pnpm. Workbench templates set `autoInstallPeers: false`; keep `--config.auto-install-peers=true` so Host peers resolve:

```sh
dsh plugin --profile coding add D:/path/to/dsh-spaces-plugin-0.2.0.tgz --config.auto-install-peers=true
dsh --profile coding
```

On Windows, CLI `0.1.5-rc.1` forwards pnpm arguments through a shell without preserving path quoting. Put the tarball at an absolute path **without spaces or shell metacharacters** (for example `D:/dsh-packages/`) before running this command; outer shell quotes alone do not fix the forwarding. The distribution acceptance script stages byte-identical tarball contents in an isolated safe temporary path and records both paths and the SHA-256 hash. It still installs through `dsh plugin add`.

`dsh.bundle.patch` (`./cordis.patch.yml`) makes `dsh plugin add` append this package to `dsh.profile.bundles` and compose `id: dsh-spaces`. Do not add a second Loader `insert` in the profile patch. Do not treat a manual tarball extract or a directory junction as an install.

Development and acceptance must use a disposable `DSH_HOME`. Installation changes the selected profile's plugin set. No registry publication is required for a local tarball.

## Remove

```sh
dsh plugin --profile coding remove @dsh-spaces/plugin
```

That drops the dependency and the bundle layer, so the composed tree no longer contains `id: dsh-spaces`. If the profile patch has an optional id-only `snapshotRoot` overlay, delete that row to avoid a skipped-patch warning; leaving it does not keep the plugin loaded.

## Scope

- View spaces, host identity, capability restrictions, plugin package information and isolation diagnostics.
- Create and verify non-host spaces only when the Host has confirmed its identity, supported runtime and configuration.
- Read snapshot metadata from an explicitly configured `snapshotRoot` belonging to this DSH home. Without that setting the panel reports snapshot information as unavailable. See [Host configuration: snapshotRoot](#host-configuration-snapshotroot).
- The current host cannot be verified or changed through these mutation endpoints. Unknown versions are read-only; interrupted operations remain visible for recovery.

The first preview does not start/stop other profiles, change their plugin sets, restore snapshots, install runtimes or embed other DSH instances in iframes. Those desktop features remain in the desktop application.

The verified integration target is CLI `0.1.5-rc.1` with the installed `0.1.5-rc.2` SDK contracts. Version matching alone does not grant write permission. Other combinations need separate runtime verification.

## Host configuration: snapshotRoot

`SpacesHost` takes an optional constructor config (`packages/plugin/src/host/spaces-service.ts`):

```ts
export interface SpacesHostConfig {
  snapshotRoot?: string;
}
```

Cordis Loader entry options (`@deepseek-ai/cordis-plugin-loader`) pass that object as `config`. The class has no `static Config` Standard Schema; Cordis `resolveConfig` therefore leaves the value unchanged (`@deepseek-ai/cordis` `lib/index.js`: if `runtime.Config` is missing, the raw config is used).

`dsh plugin add` already inserts `id: dsh-spaces` with `config: {}` from this package's bundle patch. To set a snapshot root, overlay **that id** in the host profile's `cordis.patch.yml`. Include's `applyEntryPatches` replaces the whole `config` object (not a deep merge) and skips the patch if `name` does not match. Do not add a second `insert`, and do not set `name` on the overlay:

```yaml
# profiles/<host>/cordis.patch.yml — after the isolation rows
- id: dsh-spaces
  config:
    snapshotRoot: "D:/absolute/path/to/snapshots"
```

`--patch` overlays may use the same id-only form. This package does not ship a filesystem path.

`NodeSpacesControl` (`src/adapters/node/spaces-control.ts`) then:

| `snapshotRoot` | Result |
| --- | --- |
| omitted / blank | `diagnostics` code `SNAPSHOTS_UNAVAILABLE`; `snapshots: []` |
| not absolute, a symlink, missing, or not a directory | `SNAPSHOTS_UNREADABLE`; `snapshots: []` |
| absolute real directory | UUID child dirs whose `manifest.json` matches this DSH home, lists the requested space in `profiles`, and has an ISO `createdAt` |

The directory does not have to live inside `DSH_HOME`. Desktop stores snapshots under userData; Host only requires an absolute real directory. Each `manifest.json` `home` field must still match the operating DSH home (`samePath`), so a root from another home is ignored rather than mixed in.

Quote the path in YAML (Windows paths contain backslashes and may contain spaces). Relative paths are rejected. Do not point `snapshotRoot` at a junction.

A local tarball install records a `file:` spec in the profile `package.json`. The Host plugin list hides path-like specs, so the panel version shows as unknown even though the packed `package.json` version is `0.2.0`.

## Architecture

`src/core` holds shared isolation/registry rules and maintenance/recovery application logic. Node adapters provide filesystem, process and lock access. The plugin exposes the `spaces` Remote namespace with `overview`, `detail`, `create` and `verify`; no command, path or arbitrary package-install endpoint exists.

Desktop, plugin and standalone diagnosis commands use the same per-home operation lock. Ordinary external `dsh` commands do not participate in that protocol; avoid concurrent manual profile edits. The Web preview does not claim to supervise external processes.

Browser bundles use DSH's module loader and its React instance. They contain neither Electron nor Node adapters. Launch tokens, cookies, raw configurations and raw logs are not part of the control API.

## Recovery

Use the standalone `@dsh-spaces/doctor` package when the plugin cannot load. A dead owner's lock requires an explicit unlock command; incomplete or ambiguous ownership remains blocked. Full snapshot recovery and rollback remain in the desktop recovery flow for this preview.
