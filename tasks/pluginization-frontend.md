# Pluginization frontend — Spaces panel (Kimi scope)

Date: 2026-09-11. Scope owned here: `packages/plugin/src/client/**`, `tests/spaces-panel.test.tsx`, this file. Everything else (build, metadata, host, Git) belongs to the coordinator/backend workers.

## What exists

- `packages/plugin/src/client/index.tsx` — plugin entry. Exports `inject = ["slots", "connection"]` and `apply(ctx)`. Registers:
  - `sidebar.panellist` list entry `{ name, id: "dsh-spaces", order: 100, label: "Spaces" }` with `SpacesPanelIcon` (owner props `{ size, active }`).
  - `main` keyed entry `{ name: "main", key: "dsh-spaces" }` rendering `SpacesMainPanel`.
  - Both go through `ctx.slots.inject(name, () => ctx.slots.register(...))`, matching shipped client.js usage so registration lands after the declaring shell mounts.
- `remote.ts` — `createSpacesRemote(ctx.connection)` bridges `ClientConnectionRpc.call("/api", "spaces/<method>", { args })` to the shared `SpacesControlApi` (`src/shared/spaces-control.ts`, consumed read-only). Payloads: overview `{ args: {} }`, detail/verify `{ args: { id } }`, create `{ args: { input } }`.
- `state.ts` — framework-free `SpacesPanelStore`: loading/ready/error/refreshing overview, selection, detail, create pending, verify pending/result. Two generation counters (`overviewGeneration`, `detailGeneration`) invalidate every superseded async completion — including a same-selection reload resolved out of order. Capability gates require `canCreate === true` / `canVerify === true` at call time against the latest snapshot; create never touches the transport when not explicitly allowed; verify is non-host only.
- `components.tsx` + `styles.ts` — presentational views, DOM-free and SSR-safe. Scoped under `.dsh-spaces-*` classes, `--dsw-*` theme tokens with static fallbacks, responsive grid (sidebar/detail stacks under 720px), `prefers-reduced-motion`, accessible roles (`status`/`alert`, `aria-current`, `aria-busy`, labelled form fields, sr-only status text). Renders capabilities/reasons, host badge, isolation/status, plugins+versions, snapshot metadata, diagnostics; create/verify controls appear only when allowed and never for the host.
- `panel.tsx` — `SpacesMainPanel` binds the store via `useSyncExternalStore` (server snapshot supplied); first load runs in an effect.
- `icon.tsx` — sidebar glyph, `aria-hidden`, `currentColor`.

## Error policy

Only whitelisted backend codes render their message verbatim: `spaces/read-only`, `spaces/host-denied`, `spaces/invalid-input`, `spaces/not-found`, `spaces/already-exists`, `spaces/locked`, `spaces/unavailable` (aligned with the Host worker's RemoteError codes). Unknown codes, transport throws and malformed payloads collapse to one generic message; raw internals/paths/credentials never reach the DOM (`remote.ts`, `displayMessage`).

## Upstream evidence

- Runtime: disposable install CLI 0.1.5-rc.1, SDK 0.1.5-rc.2 at `.../spaces-runtime-install-fIEaas/versions/0.1.5-rc.1/node_modules/@deepseek-ai`.
- `dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts`: `sidebar.panellist` list slot, `SidebarPanelIconOwnerProps { size, active }`, per-id panel metadata.
- `dsh-client-ui-layout/lib/types/client/index.d.ts`: keyed `main` slot, `ctx.layout`, `GlobalStandardProps.usePanelInfo`.
- `dsh-cordis-client-runner/lib/client.js` slot catalog: concrete `register({ name: 'sidebar.panellist', id, order, label }, …)` and `register({ name: 'main', key }, …)` examples; key domain open (`conversation` taken).
- `dsh-client-connection` `ClientConnectionRpc.call` + shipped `dsh-api-gateway/lib/client.js` `invoke()`: `connection.rpc.call("/api", endpoint, { args }, signal)` with `{ ok, value } | { ok: false, error: { code, message, details } }`.
- React: ordinary `react` / `react/jsx-runtime` imports, externalized by the coordinator's build into `require(...)` inside the `window.__ModuleLoader__.load` factory (as in shipped client.js). No theme/react facade is used. Local type-only augmentation imports (`dsh-client-ui-{renderer,layout,sidebar}/client`, `dsh-client-connection/client`) type `ctx.slots`/`register` against the real SDK; they erase at build time.

## Build requirements (coordinator-owned)

- Bundle `packages/plugin/src/client/index.tsx` as the client entry; externalize exactly `react` and `react/jsx-runtime` (host module loader supplies them); wrap output in `window.__ModuleLoader__.load({ id, factory(require) { … } })` CommonJS factory form. JSX automatic or classic runtime both work (sources carry a default React import for classic).
- The relative import `../../../../src/shared/spaces-control` must be bundled inline (it is ours, not external); no Node/Electron APIs are imported anywhere under `src/client`.
- Package metadata (coordinator): `dsh.client.inject` lists the renderer, layout, sidebar and connection package IDs; platform web. This package dependency list is distinct from the client module's service-level `inject = ["slots", "connection"]`.

## Verification

- `npx tsx --test tests/spaces-panel.test.tsx` — 22/22 pass (2026-09-11): transport endpoint/payload shape, known-code passthrough, unknown/transport/malformed sanitization, refresh/auto-select, error-with-data retention, same-selection reverse-order staleness (the reproduced `pending[1]`-then-`pending[0]` case), cross-selection staleness, superseded-refresh rollback guard, create/verify capability gates (no transport call when disallowed), stale verify discard, and SSR accessible-structure coverage of every view state.
- `npx tsc --noEmit -p tsconfig.spaces.json` — clean, including the client plugin sources.

## Not in scope (Phase 1 boundary)

No lifecycle/install/restore, no iframe embedding, no host mutation, no locale namespace registration (English copy only for this MVP), no Git/Bridge actions.
