# @dsh-spaces/supervisor

Independent workbench supervisor. It binds `127.0.0.1`, holds Home run rights, and serves the stable entry plus `/api/workbench/<method>`.

This package is Node-only. Browser callers never receive filesystem paths, CLI commands, child launch tokens, or the host bearer.

## Launch / attach

Spawn the CLI (view-bridge / DSH bootstrap should use this, not a second HTTP scaffold):

```
node packages/supervisor/src/index.ts --home <abs> --bin <abs-dsh-bin.js> --node <abs-node> --port 0
```

Same process API:

```ts
import { createWorkbenchSupervisor, parseSupervisorArgs, supervisorCliArgs } from "@dsh-spaces/supervisor";

const handle = await createWorkbenchSupervisor({
  home,
  bin,
  nodeExe,
  port: 0,
  controlToolRoot,
  supervisorAssetRoot,
  pluginArtifact,
  viewBridgeArtifact,
  snapshotWorkerFile,
  snapshotRoot,
});
// handle.origin is a clean http://127.0.0.1:<port>
// handle.bootstrapUrl is a one-time Node-only bootstrap; do not put it in DTOs
await handle.close();
```

`supervisorCliArgs(options)` rebuilds the argv for a child spawn.

## Flags (all Node-only paths)

| Flag | Meaning |
| --- | --- |
| `--home` | Canonical DSH home. Required. Refuses `~/.dsh` unless explicitly allowed in-process. |
| `--bin` | Selected DSH `bin.js`. Version is read from the adjacent package.json; `0.1.5-rc.1` only. |
| `--node` | Node executable used to spawn DSH. |
| `--port` | Supervisor listen port. `0` picks an ephemeral port. Always `127.0.0.1`. |
| `--control-tool-root` | Bind toolchain / runtime store outside snapshot-replaced trees. |
| `--supervisor-asset-root` | Optional static assets for the stable entry. |
| `--plugin-artifact` | File path of `@dsh-spaces/plugin` for the manager profile. |
| `--view-bridge-artifact` | File path of the view-bridge package for manager and ordinary spaces. |
| `--snapshot-worker` | Snapshot worker file used when composing maintenance ports. |
| `--snapshot-root` | Snapshot directory. Default `{home}/.dsh-spaces-snapshots`. |

Root build/manifest wiring is owned by the integrating agent. This package does not rewrite the desktop Electron entry.

## Auth

- Browser: one-time `/bootstrap/<token>` or `/?token=` → HttpOnly SameSite=Strict cookie named `dsh-auth-<sha256(127.0.0.1:port)>` → 303 `/`.
- Manager host proxy: bearer in `{home}/.dsh-spaces-control/host.bearer`. Never copied into browser DTOs.
- Origins: supervisor entry and the live manager origin. Ordinary workspace origins are rejected for management APIs. No arbitrary URL proxy.

## Build need

Compile `packages/supervisor/src/index.ts` to `packages/supervisor/lib/index.js` the same way as `@dsh-spaces/doctor`. Root `package.json` / tsconfig / electron-builder files are not owned by this leaf.
