# Minimal static capability queries

This second increment adds target-specific static declarations to the private bus.
It is not a central/dynamic registry: no all-Space scan, subscription, broadcast,
persistence, automatic binding or new credential exists.

```ts
ctx.spaceMessages.handle('browser.listTabs', ['coding'], async () => [], {
  description: 'List tabs in this Browser Space.',
});
const capabilities = await ctx.spaceMessages.capabilities('browser');
const tabs = await ctx.spaceMessages.request('browser', 'browser.listTabs', {});
```

The optional fourth `handle` argument is `{ description: string }`; omitted metadata
preserves old handlers with an empty description. Metadata is detached at registration.
The query returns `{ operation, description }[]` only for operations authorized for
the Supervisor-bound source Space. Denied operation names, allowlists, and credentials
are not disclosed. The later request independently checks its current registration
and permissions: discovery never grants authority. Disposal removes both the handler
and declaration. Unknown/offline targets report `target-unavailable`.

Queries use reserved operation `spaces.capabilities` with null parameters on the
same bounded IPC transport. Plugins cannot register that name. One Space permits at
most 128 handlers, each description at most 256 JSON-encoded bytes including quotes
and escapes; even the maximal catalog fits the 64 KiB envelope. Clients validate
returned shapes, duplicate/reserved names and bounds. Business argument contracts
remain documented per operation, without schema execution or arbitrary code.

Tests cover real two-process filtering, stale queries after disposal, continued
call authorization, malformed queries/results, immutable descriptions, limits, and
maximal catalogs. The real Supervisor/Cordis fixture also exercises the service API.
These are minimum native Host fixtures, not full official DSH Host or GUI acceptance.

Local stage-two verification (Node 24.19.0): the 12 bus/Supervisor tests and
43-test related lifecycle combination passed; spaces/node/web type checks and full
build passed before the subsequent native Browser adapter work. No push or PR.
