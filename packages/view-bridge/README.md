# @dsh-spaces/view-bridge

Lightweight DSH Host plugin for ordinary spaces. It provides the parent view handshake and bounded, allowlist-controlled cross-space request/response messaging. It does not create a manager, start a supervisor, or expose workbench writes.

Handshake or origin failure is reported as a view error. The bridge does not reconnect, restart the supervisor, or recover the parent. Independent origin checks stay. Fault policy: [docs/let-it-crash.md](../../docs/let-it-crash.md). Current architecture baseline: [docs/architecture.md](../../docs/architecture.md).

## Role and handshake

The bridge establishes the view session between an ordinary space and its parent surface. The session is identified by the public service epoch, the space ID and the run generation of that instance, plus a per-run channel. A new process for the same space name is a different instance, not a continuation of the old one.

The bridge carries no management authority. It cannot start or stop spaces, install plugins, change Home settings, or address the management API. Only the manager profile exposes management capabilities.

Cross-space messages use Supervisor-bound source identities and target-owned exact allowlists. Discovery is filtered by the same permissions and never grants authority. Calls are bounded, in-memory request/response operations without persistence, replay, broadcast or automatic retry; a timeout does not prove that the target did not execute.

## Installation and versions

This package is **not** the user install unit. Users add the prebuilt `@dsh-spaces/plugin` tarball to ordinary `web`, then click **初始化 Spaces** / **Initialize Spaces**. The supervisor installs this bridge onto an ordinary space when that space does not have one yet.

An already-installed space bridge is **not** automatically re-aligned to the current component group. A space that already has a bridge keeps it until the user performs an explicit maintenance operation; the actual bridge state must be shown rather than assumed. The manager plugin is the one component that is aligned with the current group before the manager starts.

The space's pinned DSH runtime version and the Spaces component group version are two separate coordinates. The manager follows the host; an ordinary space keeps its exact pinned DSH version and changes it only through a user-initiated switch.

## Distribution

`@dsh-spaces/supervisor` stays private. Do not `npm publish` this repo root. This scoped package is not on the npm registry yet — there is no `pnpm add @dsh-spaces/view-bridge` from npmjs.

Pack the complete component group from the repository root with `pnpm run pack:plugin`. Users do not install this bridge as a separate package.
