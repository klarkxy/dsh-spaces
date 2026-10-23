# Workbench management API — one authoritative surface

Wave report for the 2026-10-23 architecture refactor. Scope: the management
API surface (`workbench/*`) that was declared by hand in several places, where a
missed edit was a silent runtime mismatch.

The wire behaviour is unchanged: same remote namespace and method strings, same
DTO shapes, same request validation, same error mapping. The proof is in §4.

---

## 1. Research findings

### 1.1 How `@Remote` registration really works

Source: `node_modules/@deepseek-ai/dsh-typert-protocol/lib/index.js` (0.2.1-rc.2).

- `Remote(name)` returns `remoteDecorator({kind:"direct"}, {exportName: name})`,
  which is `(method, context) => addMarkerInitializer(context, invocation, options)`.
- `addMarkerInitializer` reads exactly four things from the decorator context:
  `context.name` (must be a `string`), `context.private`, `context.static`, and
  `context.addInitializer(fn)`. These are the standard TC39 decorator
  members — nothing protocol-private.
- The initializer runs at **instance construction time**, not at class
  definition time. It takes `Object.getPrototypeOf(this)` and writes a frozen
  marker record onto the class prototype under the key
  `"@deepseek-ai/dsh-typert-protocol/remote-methods"`.
- `mark()` is **idempotent**: re-marking a method with identical options
  returns early; conflicting options throw. Re-running the initializers for a
  second instance therefore does not duplicate markers.
- `remoteMethods(service)` reads the **own** property of the **immediate**
  prototype and returns the markers in registration order.
- `exportName` is omitted from the marker when it equals the implementation
  member name. `@Remote("state")` on `state()` therefore records exactly
  `{method: "state", invocation: {kind: "direct"}}`.

**Consequence:** decorator metadata is a *runtime* fact of the prototype, not a
static-analysis artifact. Decorators here do **not** require static analysis,
so a definition table can drive the registration. This was the open question in
the brief, and the answer is favourable.

### 1.2 Which client declarations are runtime and which are type-only

- `TypertRemoteNamespace$workbench` and the `TypertRemoteMap` entries are
  **module augmentations** of `@deepseek-ai/dsh-typert-protocol` — pure type
  declarations with zero runtime effect.
- `TypertRemoteNamespace$workbench` is not declared by the protocol package at
  all; it is a repo-local interface merged in by the augmentation. The
  protocol's canonical namespace type is `TypertRemoteNamespace<"workbench">`,
  which is derived from `TypertRemoteMap`.
- The **actual** browser client is `createWorkbenchRemote()` in
  `packages/plugin/src/client/workbench-remote.ts`. It calls
  `connection.rpc.call("/api", "workbench/<method>", { args })` and used
  hand-written endpoint strings *and* hand-written payload key names.
- `TYPERT.invocations` in `packages/plugin/src/typert.host.ts` is the runtime
  descriptor table; `TYPERT_REMOTE.descriptors` is built from it.
- `tests/products/workbench-plugin.test.ts` reads the registration back through
  the public `remoteMethods()` API, so the marker list is asserted at runtime.

### 1.3 The surface was declared in nine places, not three

| # | Location | Kind | What it declared |
|---|---|---|---|
| 1 | `src/shared/workbench.ts` | type | the `WorkbenchApi` interface |
| 2 | `packages/plugin/src/host/workbench-manager.ts` | runtime | 15 `@Remote` decorated members |
| 3 | `packages/plugin/src/typert.remote-client.ts` | type | `TypertRemoteNamespace$workbench` + `TypertRemoteMap` |
| 4 | `packages/plugin/src/typert.host.ts` | runtime | 15 `TYPERT.invocations` rows |
| 5 | `packages/plugin/src/typert.host.ts` | runtime | `MANAGER_METHODS` |
| 6 | `packages/plugin/src/client/workbench-remote.ts` | runtime | the browser proxy (endpoints + payload keys) |
| 7 | `packages/plugin/src/host/workbench-http.ts` | runtime | `WORKBENCH_HTTP_METHODS` + the Host→Supervisor client |
| 8 | `src/adapters/node/server/workbench-http.ts` | runtime | `WORKBENCH_API_METHODS` (Supervisor gate) |
| 9 | `src/adapters/node/workbench-supervisor.ts` | runtime | the `dispatchRequest` switch |

### 1.4 How the server dispatch maps names to handlers

- `src/adapters/node/server/workbench-http.ts` matches
  `/api/workbench/<method>` and gates it with `isApiMethod()`, a membership
  test against `WORKBENCH_API_METHODS`; an unknown method is rejected before
  any handler runs. It then calls `host.dispatch(method, payload)`.
- `src/adapters/node/workbench-supervisor.ts#dispatchRequest` is a `switch` over
  the method name. Each branch does its own `expectKeys(body, [...])` check and
  its own supervisor-side parsing, then calls the supervisor method.
- The switch had **no exhaustiveness check**: a method present in the gate list
  but missing from the switch fell through and returned `undefined`, which the
  HTTP layer serialised as `{"ok":true}`.

---

## 2. Decision: a shared api-definition module (mechanism a)

**Chosen: (a) one shared api-definition module, consumed at runtime and at the
type level.** Not (b) a checked-in codegen script.

Why:

1. **The facts are needed in both worlds.** The surface facts are: method
   name, wire argument names and their order, argument DTO types, result DTO
   types, per-parameter codec, per-parameter Typert type symbol. The runtime
   consumers (descriptor rows, marker registration, request bodies) need the
   codecs; the type-level consumers (the interface, the client declarations)
   need the DTO types. One table can carry both, because a runtime value can
   double as a type witness (`value: undefined as unknown as T`).
2. **Codegen would have to reproduce schema *identity*.** `TYPERT.invocations`
   hands the *same* zod schema objects to the Gateway that the Host client
   validates with. A generator would have to emit imports that keep that
   identity, and would still need the 15 method *implementations* somewhere to
   paste them from — so the generated file would either embed business logic or
   point at a second hand-written list. That is more magic, not less.
3. **Option (b)'s usual motivation does not apply.** Codegen exists because
   decorators/annotations need static analysis. §1.1 shows they do not here.
4. **The definition is split by layer, not by duplication.** `src/shared` stays
   browser-safe and free of zod; the zod codecs live in the host layer. The two
   halves are joined by a *mapped type*, so the link is checked by the
   compiler rather than by convention.

### 2.1 The two halves

**`src/shared/workbench.ts` — the canonical definition** (browser-safe, no
runtime dependency, no zod):

```ts
export const WORKBENCH_API = {
  detail: {
    args: [{ name: "spaceId", value: undefined as unknown as string }] as const,
    result: undefined as unknown as SpaceDetail,
  },
  // ... 15 methods
} as const;
```

`args` lists the wire arguments in wire order. `name` is the wire argument
name; `value` is a type witness that is `undefined` at runtime and only pins
the argument's DTO type. Derived from it:

- `WorkbenchApiMethod` — the method union.
- `WORKBENCH_API_METHODS` — the method names in wire order (`Object.keys`).
- `WorkbenchApiArgs<K>` / `WorkbenchApiResult<K>` / `WorkbenchApiArgNames<K>`.
- `WorkbenchApiOptionalMethod` / `WorkbenchApiRequiredMethod`.
- `WorkbenchApi` — the contract, now a **derived type** instead of a
  hand-written interface.

**`packages/plugin/src/host/workbench-api.ts` — the wire codecs** (new): one
entry per method, holding the zod schema and the Typert type symbol of every
parameter and of the result. It is typed as

```ts
export const WORKBENCH_API_CODECS: {
  [K in WorkbenchApiMethod]: {
    params: { [P in WorkbenchApiArgNames<K>]: WorkbenchApiCodec };
    result: WorkbenchApiCodec;
  };
} = { ... };
```

so the following are **compile errors**, not silent mismatches:

- a method missing from the codec table;
- a parameter missing, extra, or renamed (the keys *are* the canonical wire
  names);
- a parameter in the wrong position (the descriptor rows are built by walking
  the canonical argument order).

### 2.2 How the host registration is derived

`@Remote` is a decorator, but its marker is produced by a plain function that
consumes the standard decorator context. `registerWorkbenchRemoteMethods()`
drives that same contract for every canonical method, so the registered set
*is* the canonical definition:

```ts
const decorator = Remote(method);
decorator(implementation, {
  kind: "method", name: method, private: false, static: false,
  addInitializer(initializer) { initializer.call(host); },
});
```

Because `exportName === method`, the recorded marker is byte-identical to the
one the decorator produced (`{method, invocation:{kind:"direct"}}`, no
`exportName` field). After the loop the marker list is read back through the
public `remoteMethods()` and compared with the canonical list; a mismatch
throws instead of registering a wrong surface.

---

## 3. Files changed and the derivation flow

| File | Change | Derived from |
|---|---|---|
| `src/shared/workbench.ts` | new: `WORKBENCH_API`, `WORKBENCH_API_METHODS`, `WORKBENCH_API_METHOD`, `WorkbenchApiArgs/Result/ArgNames`, `WorkbenchApiOptionalMethod/RequiredMethod`; `WorkbenchApi` is now derived | — (the source) |
| `packages/plugin/src/host/workbench-api.ts` | **new**: `WORKBENCH_API_CODECS` (zod codec + type symbol per method/parameter/result) | `WORKBENCH_API` (mapped type) |
| `packages/plugin/src/host/workbench-manager.ts` | the 15 `@Remote` decorators replaced by `registerWorkbenchRemoteMethods()`; the class now `implements WorkbenchApi` | `WORKBENCH_API_METHODS` |
| `packages/plugin/src/typert.host.ts` | the 15 hand-written `invocation(...)` rows replaced by `workbenchInvocations`; `MANAGER_METHODS` derived | `WORKBENCH_API` + `WORKBENCH_API_CODECS` |
| `packages/plugin/src/typert.remote-client.ts` | `TypertRemoteNamespace$workbench` and the `TypertRemoteMap` workbench entries are now mapped types over the canonical definition | `WORKBENCH_API` |
| `packages/plugin/src/client/workbench-remote.ts` | endpoint strings and named payload keys are derived; the 15 methods stay an explicit, type-checked literal | `WORKBENCH_API` |
| `packages/plugin/src/host/workbench-http.ts` | `WORKBENCH_HTTP_METHODS` derived; the Host→Supervisor client validates and names every argument from the canonical codecs | `WORKBENCH_API` + `WORKBENCH_API_CODECS` |
| `src/adapters/node/server/workbench-http.ts` | `WORKBENCH_API_METHODS` re-exported from the canonical list | `WORKBENCH_API_METHODS` |
| `src/adapters/node/workbench-supervisor.ts` | `dispatchRequest` gained a `default` branch with a `never` assignment, so a method missing from the switch is a compile error | `WorkbenchApiMethod` |

Derivation flow:

```
src/shared/workbench.ts  (WORKBENCH_API — names, argument order, DTO types)
        │
        ├──▶ WorkbenchApi                         (mapped type)
        ├──▶ TypertRemoteNamespace$workbench      (mapped type)
        ├──▶ TypertRemoteMap["workbench/*"]       (mapped type)
        ├──▶ WorkbenchManagerHost markers         (runtime, Remote decorator contract)
        ├──▶ TYPERT.invocations workbench rows    (runtime, + WORKBENCH_API_CODECS)
        ├──▶ createWorkbenchRemote payloads       (runtime)
        ├──▶ createWorkbenchHttpClient bodies     (runtime, + WORKBENCH_API_CODECS)
        ├──▶ WORKBENCH_API_METHODS (Supervisor)   (runtime)
        └──▶ dispatchRequest exhaustiveness        (compile-time)

packages/plugin/src/host/workbench-api.ts  (WORKBENCH_API_CODECS — zod codecs + type symbols)
        └──▶ typed as a mapped type over the canonical definition
```

### 3.1 What is *not* derived, and why

- **The 15 method implementations** in `WorkbenchManagerHost` and in the two
  clients stay explicit literals. They hold the business logic, and they are
  type-checked against the derived `WorkbenchApi`, so a missing or renamed
  method is a compile error rather than a silent gap.
- **The `dispatchRequest` handlers** stay a switch: they hold the supervisor's
  business logic and its own parsers. Only the exhaustiveness check is derived.
- **The guide Remote** (`workbenchGuide/*`) is a different service and a
  different namespace; it was left untouched.

---

## 4. Wire-identity proof

A probe (`.sandbox/wire-identity-probe.ts`) was run against the **pre-change
tree** (extracted from `git archive HEAD` into `.sandbox/head-before/`, with
`node_modules` linked in) and against the **post-change tree**, and the two
JSON dumps were compared.

The dump records, for the current tree:

- the 15 registered Typert markers (`method`, `exportName`, `mode`,
  `invocation`) read back through the public `remoteMethods()`;
- all 24 descriptor rows (`namespace/method`, descriptor `id`, source
  location, parameter names and wire names, codec mode, type symbol);
- for every parameter and result codec: a **JSON Schema digest**
  (`z.toJSONSchema`) **and** a **validation-behaviour digest** (the
  `safeParse` outcome — success value or issue codes and paths — over 37 fixed
  probe values, which is what actually proves unknown-field rejection and enum
  membership are unchanged);
- the 15 browser-client RPC calls (endpoint string + named payload);
- the 15 Host→Supervisor HTTP requests (URL path + JSON body + bearer).

Result:

```
before sha256 = 1D5F944439E47369DB6134D4D3B9E76443AF2DEF074EF016FCA7BBF80CEBAA99
after  sha256 = 1D5F944439E47369DB6134D4D3B9E76443AF2DEF074EF016FCA7BBF80CEBAA99
IDENTICAL = True
```

The dumps are byte-identical: 15 markers, 24 invocations, 15 RPC calls,
15 HTTP calls. The recorded HTTP bodies also confirm the pre-existing
transport quirk is preserved — `llm` and `llmCredential` send their request as
the **whole body**, while every other method sends named fields:

```
/api/workbench/state       {}
/api/workbench/detail      {"spaceId":"space-x"}
/api/workbench/submit      {"command":…,"requestId":…,"context":…}
/api/workbench/llm         {"method":"describe"}
/api/workbench/llmCredential {"method":"discoverModels","draft":…,"secret":"s"}
```

---

## 5. The parallel validation sets — in scope only if cleanly addressable

There are three validation sets, and they are **not** interchangeable:

| Set | Transport | Strictness |
|---|---|---|
| `packages/plugin/src/host/workbench-schemas.ts` (Zod) | Typert Remote + Host client | strict objects, `.strict()` rejects unknown fields |
| `src/shared/workbench-product-schemas.ts` (Zod) | product protocol | already layered: `workbench-schemas.ts` imports and re-exports it, so there is no duplication between the two |
| `src/adapters/node/supervisor/input.ts` (hand-written parsers) | Supervisor HTTP dispatch | **different rules** |

The third set is a genuinely different validator for the same payloads, not a
second copy of the first:

- `parseId` rejects `/`, `\` and `..`; the Zod `jobIdSchema` does not.
- `parseSpaceName` goes through `parseSpaceId` from the products service; the
  Zod `spaceIdSchema` is a plain regex.
- `parsePlanRequest` explicitly rejects `controller.release`,
  `controller.shutdown`, `snapshot.restore`, `config.restore`,
  `runtime.upgrade` and `runtime.install` as `workbench/unsupported`; the Zod
  `workbenchPlanRequestSchema` simply does not declare those kinds.

Unifying them would change validation strictness or error codes, which the
brief forbids, so **the three validation sets are left as they are**. What was
done instead is that the *surface* (which methods exist, with which argument
names) is now single-sourced, and the Supervisor dispatch is now checked for
exhaustiveness against that surface. The remaining duplication is inside the
validators, not in the API surface.

---

## 6. Validation

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | 0 | node + web projects clean |
| `npm run typecheck:spaces` | 0 | clean |
| `npm run typecheck:tests` | 0 | clean |
| `npm run build` | 0 | all bundles built |
| `npm run test:workbench` | 0 | 575 tests, 573 pass, 0 fail, 2 skipped (271 s) |
| `npm test` | 0 | 267 tests, 267 pass, 0 fail, 0 skipped (54 s) |
| `npm run test:spaces` | 0 | 149 tests, 148 pass, 0 fail, 1 skipped (22 s) |
| wire-identity probe (HEAD vs. working tree) | 0 | byte-identical dumps (§4) |

### 6.1 Notes on the test run

The `tests/` tree was being reorganised into subdirectories by another worker
during this wave, and `package.json`'s test scripts moved with it. The suites
above were run against the reorganised tree with the updated scripts.

---

## 7. Leftovers and risks

1. **`MANAGER_METHODS` type widened.** It was a literal tuple
   (`readonly ["state", …]`); it is now `readonly WorkbenchApiMethod[]`, because
   a literal tuple cannot be derived from a table without a lying cast. The
   *values* and their order are unchanged. It is a public export of the
   `@dsh-spaces/plugin` package (`./typert`).
2. **`WorkbenchApi` is a type alias, not an interface.** Same members, same
   signatures, `llm` and `llmCredential` still optional. Parameter *labels* are
   no longer shown in editor tooltips (the derived tuple carries positions, not
   names); the parameter names live in the canonical table and in the wire
   payloads. `interface X extends WorkbenchApi` still works (verified against
   `tests/ui/workbench-ui.test.tsx`'s `SpyApi`).
3. **A pre-existing schema/type divergence was found and left alone.**
   `llmApiResultSchema` accepts an optional `catalogRevision` on the
   `operationStatus` result, which the TypeScript `LlmOperationStatusResult`
   does not declare — so `z.output<typeof llmApiResultSchema>` is *wider* than
   `LlmApiResult`. The other 11 result/parameter codecs match their DTO types
   exactly (checked with an exact-type probe). Because of this one divergence
   the codec table cannot assert `z.ZodType<ExactDto>` uniformly; the codec
   result is bridged to the DTO type with one cast, exactly as the previous
   code did for the two LLM methods.
4. **The remote registration depends on the decorator *contract*, not on the
   decorator *syntax*.** `registerWorkbenchRemoteMethods()` drives
   `Remote(name)` with a conformant `ClassMethodDecoratorContext`. If a future
   protocol release changed `Remote` to stop using `context.addInitializer`, the
   markers would silently not be recorded — which is why the marker list is
   read back with the public `remoteMethods()` and compared with the canonical
   list at construction time, turning that failure into a loud error. The
   protocol is pinned to `0.2.1-rc.2`.
5. **The guide Remote is still hand-written** (`workbenchGuide/*`, its own
   namespace and its own descriptors). It was out of scope.
6. **The Supervisor's hand-written parsers** still duplicate the Zod codecs
   with different strictness (§5). Closing that gap changes validation
   behaviour and needs its own decision.
