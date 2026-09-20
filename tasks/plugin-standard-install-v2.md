# Standard install verifier — protocol v2

Leaf: `scripts/verify-plugin-standard-install.mjs` only (plus this report). No source/UI, Git, config, credentials, real `~/.dsh`, other scripts, or `build`.

Primary already moved Node modules and typechecked. This leaf migrates the **official CLI real-install verifier** onto workbench protocol v2. Real browser/CLI run stays with Primary after source integration.

## Contract reused (not reinvented)

- Mutation context: `{ serviceEpoch, expectedRevision }` (64-hex), same as `workbenchMutationContextSchema`.
- Preview/submit HTTP body: `{ request, context }` / `{ command, requestId, context }`. Supervisor `expectKeys` rejects missing context.
- Stop: `preview({ kind: "service.shutdown" }, context)` then `submit({ kind: "plan.execute", planId }, requestId, context)`. `controller.shutdown` is unsupported.
- State: `protocolVersion: 2`; no `recoveryRequired`.
- View: `entryOrigin` + path-only `entryPath` + `?epoch=`; child `origin` is not the iframe src.
- Guide UI: `[data-dsh-spaces-guide]`, `[data-dsh-spaces-action="initialize"|"enter"]`, `[data-dsh-spaces-error] [role=alert]`.
- Workbench: outer `iframe#manager-frame` then `.dsh-workbench` / `.dsh-wb-rail`.

## Shutdown proof (PASS only if all hold)

1. Public `job` reaches a terminal status **and** `status === "succeeded"` (poll errors are not rewritten into success).
2. Owner pid from this Home's `run/owner.json` is **dead** (`ESRCH`).
3. `endpoint.json` is missing or not a valid v2 endpoint (`version === 1` is invalid, not a fallback).
4. This Home's supervisor ports are closed.

`forceCleanOwned` (taskkill / `stopOwned` of the harness web child) runs in `finally` as **cleanup**. If it has to kill a still-alive supervisor pid, the run **must not PASS**.

## Preserved product path

Official `dsh plugin --profile web add` of the packed tarball → Playwright click initialize (no path args) → one `spaces-hub` manager → `space.create` / `space.start` on public v2 API → ordinary space gets `@dsh-spaces/view-bridge` only → repeat **enter** does not add a second manager → web restart re-enters the same manager → `dsh plugin --profile web remove` drops bundle.

Web path protection: `profiles/web` is never the manager; `sessions` / `storages` names and Home `.credentials.yaml` / `.anonymous-user-id` **presence** must match the post-add fingerprint. Credential bytes are never read.

Disposable Home only (`refuseRealHome`). No model calls. Does not import `verify-workbench-product.mjs`.

## Commands (this leaf)

```
node --check scripts/verify-plugin-standard-install.mjs
node scripts/verify-plugin-standard-install.mjs --syntax
node scripts/verify-plugin-standard-install.mjs --preflight
```

`--syntax` / `--preflight`: no DSH web, no supervisor, no Playwright, no shared build. Full `node scripts/verify-plugin-standard-install.mjs` is Primary after integration.

## Checks run

| Command | Result |
| --- | --- |
| `node --check scripts/verify-plugin-standard-install.mjs` | PASS |
| `node scripts/verify-plugin-standard-install.mjs --syntax` | PASS (10 static proofs: v2 contract, context/endpoint/view parsers, Home/path guards, no machine paths) |
| `node scripts/verify-plugin-standard-install.mjs --preflight` | FAIL closed at `pack --preflight`: `ComponentPayloadError: Component payload schemaVersion must be 2`. All v2/static proofs before pack passed. Packed `packages/plugin/lib` is still schema v1 until Primary rebuilds. Not rewritten as PASS. |
| Full official CLI + Playwright install | not run (Primary after source integration) |

## Diff

- `scripts/verify-plugin-standard-install.mjs` — 404 insertions, 101 deletions
- `tasks/plugin-standard-install-v2.md` — this report (new)

## Not done here

- Other `scripts/verify-workbench-*.mjs` still contain `controller.shutdown` (out of this leaf).
- `package.json` already has `validate:plugin-install`; not edited.
- No Git write, no real Home, no UI/source edits, no build.
