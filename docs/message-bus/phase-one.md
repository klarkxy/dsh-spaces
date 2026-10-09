# Cross-Space request/response: phase one

> Historical phase-one acceptance record. The current branch also includes [static capabilities](./static-capabilities.md) and Browser Space; current status and remaining local acceptance are in [the task checklist](../../tasks/todo.md). Phase-one stop/publishing notes below describe that earlier checkpoint.

## Scope

A Host plugin in a Supervisor-owned ordinary Space can asynchronously call one
explicitly installed operation in another running ordinary Space. This is a local,
in-memory request/response transport, not a capability registry. No discovery,
broadcast, streaming, persistence, replay, reconnect, browser API, shared model,
external/manual Space adoption, or cross-machine transport is implemented.

The existing Supervisor `CooperativeChildren` private Node IPC channel is reused.
No listener, credential, bearer, persistent permission store, or management API is
added. Supervisor binds identity to the exact owned `ChildProcess`; request bodies
cannot choose their source. Manager and unmanaged processes are not bus peers.
A replacement process with the same Space ID is a new session; outstanding work
for the retired session fails and its replies cannot satisfy new calls.

## Host API

The existing `@dsh-spaces/view-bridge` Host plugin exposes the Cordis service
`spaceMessages` when launched with the existing valid view environment and an IPC
parent connection. It is not exported to browsers through Typert/Remote.

```ts
export const inject = ['spaceMessages'];
export function apply(ctx) {
  // In target Space beta: opt in exact source Space IDs. Empty list denies all.
  ctx.spaceMessages.handle('notes.read', ['alpha'], async (params, caller) => {
    // Validate the business arguments here. caller.spaceId is Supervisor-bound.
    return { text: 'example', requestedBy: caller.spaceId };
  });
}
// In source Space alpha:
const result = await ctx.spaceMessages.request('beta', 'notes.read', { id: '42' }, 5000);
```

Operations have explicit local handlers only, with no evaluation of names or
parameters as code. Duplicate operation names are rejected. A handler is removed
when its registering Cordis plugin is disposed (or by its returned disposer).
Permissions are deny-by-default, target-owned exact Space allowlists. The trust
boundary is the whole Host process: installed plugins in the same Space are not
isolated from each other. This phase does not introduce per-plugin or multi-user
identities or silently grant access to an existing operation.

## Contract and resource bounds

- Caller request IDs and Supervisor-generated routing IDs are separate. Responses
  must arrive from the exact target session. Wrong-session and late replies are ignored.
- Strict plain JSON values only, max 64 KiB UTF-8 per whole envelope, max depth 32
  and 16,384 nodes. Sparse/decorated arrays, accessors, non-JSON values, custom
  prototypes, symbols and cycles are rejected before send. Handler arguments and
  responses cross a detached JSON boundary.
- Default timeout: 10 seconds; explicit integer timeout: 1–60,000 ms.
- At most 128 pending router calls, 128 pending calls per client, and 128 executing
  handlers per target. Hung handlers continue to consume execution admission after
  response bookkeeping expires. No unbounded replacement work is admitted.
- Timeout, response, exit, disconnect, and disposal release the applicable pending
  entries and timers. Provider errors are returned as `operation-failed`, without
  exposing error text or secrets. Other error codes: `invalid-input`,
  `target-unavailable`, `operation-not-found`, `unauthorized`, `timeout`,
  `disconnected`, `overloaded`.
- A timeout or lost connection does **not** prove that an operation did not run or
  cancel its side effects. A handler may still complete. There is no automatic retry
  or undo. This follows [let it crash](../let-it-crash.md).

## Verification and limits

`tests/space-message-bus.test.ts` uses real Node child processes over IPC for
bidirectional concurrency, permission/error responses, timeout/late completion,
exit/disconnect, and same-ID replacement; it also probes malformed JSON, forged
responses, disposal, failed sends and bounded hung handlers.

`tests/space-message-supervisor.test.ts` uses the actual Supervisor lifecycle and
real Cordis/view-bridge services in two minimal Host processes. It checks routing,
caller identity, denied calls, and unregister-on-plugin-dispose. Its CLI metadata,
patch preparation, and HTTP readiness are fixtures: this is not a full official
DSH Host or GUI/distribution acceptance test. Both files run in `test:workbench`.

No real `~/.dsh`, default `web`, sessions or storages are used. Changes remain local
for phase-one review; no push, PR, merge, deployment, or phase-two work is implied.

### Local acceptance, 2026-10-09

Base and remote observed SHA: `c8e831e970f5b9ac64c8a7be527bdd42cd69ed53`.
Local branch: `feat/minimal-space-message-bus` (uncommitted review diff).
Node: 24.19.0. Lockfile unchanged; `npm ci` used writable temporary caches.

- `npm run typecheck:spaces`, `npm run typecheck`, `npm run build`: passed on final code.
- `node --import tsx --test tests/space-message-bus.test.ts tests/space-message-supervisor.test.ts tests/cooperative-children.test.ts tests/dashboard-supervisor.test.ts tests/supervisor-reopen.test.ts`: 41 passed, 0 failed/skipped. This includes all 10 new bus tests and final custom-array-prototype rejection regressions.
- Full `test:spaces` file list via `node --import tsx --test`: 139 passed, 3 skipped, 0 failed.
- Full `test:workbench` file list via `node --import tsx --test`: 516 tests, 511 passed, 5 failed. The same five failures reproduced on an untouched archive of the base SHA using the same installed dependencies (85 tests in the affected baseline files: 80 passed, 5 failed).
- `git diff --check`: passed. The existing shutdown test that constructs a runtime with `Object.create` now explicitly initializes its real message router; its 10-test file passed.

The `tsx` CLI itself cannot open its auxiliary Unix pipe in this execution sandbox
(`EPERM`). The supported Node `--import tsx` entry runs the exact same script file
lists without that auxiliary CLI pipe; test assertions are unchanged.

The five base-reproduced failures are:

1. `workbench-supervisor-handoff`: failed stop / failed persistence / durable success fixture cannot load `@deepseek-ai/dsh-app-boot`.
2. `workbench-supervisor`: default entry origin cold restart, unconfirmed stop.
3. `workbench-supervisor`: shutdown persists job then releases rights, timeout.
4. `workbench-supervisor`: unconfirmed final persistence shutdown, timeout.
5. `workbench-supervisor`: later launch reads dump-config fresh, unconfirmed stop.

Full workbench is therefore **not green**. Those existing failures were not changed
or hidden. No GUI, Windows/macOS, official full DSH CLI install, packaged native Host,
long-running stress, or distribution install acceptance was run for this feature.
