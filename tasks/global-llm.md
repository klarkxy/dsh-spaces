# Global LLM connection library

Plan: [docs/plans/global-llm-connections.md](../docs/plans/global-llm-connections.md).
Fault policy: [docs/let-it-crash.md](../docs/let-it-crash.md).

`web` is not the owner of global model settings. Shared connections live in a Home-level catalog. Each Space keeps its own settings, plugins, sessions, and runtime.

## P0 — pin compatibility and config scopes

- [x] Inspect published `0.1.5-rc.2` settings / credentials / llm-pi-ai tarballs.
- [x] Record the actual settings and credentials path providers. Do not infer them from Home or session/storage roots.
- [x] Patch new workbench isolation to give each Space its own settings and credentials files.
- [x] Add `@dsh-spaces/llm-bridge` prototype: base injection, shared write refuse, credential split.
- [x] Contract tests plus a three-process prototype (`web` unjoined, A/B joined).
- [ ] Full official CLI multi-profile run against a live adapter stream (P2).

## P1 — catalog, policy, and CAS

- [x] Persist one catalog original under `.dsh-spaces-control/llm/catalog.json`.
- [x] Persist Space policy next to that Space's data root; web uses the Home root.
- [x] Persist shared secrets in the official credential document, records only.
- [x] Stable IDs, schema validation, atomic write, revision conflict, delete reference checks.
- [x] `mode=all` is a live reference; disabled selected bindings still block delete.
- [x] Credential write then failed catalog publish leaves the original catalog and reports the leftover record.

## P2 — official adapter streaming

- [x] Freeze a catalog/policy snapshot per Space process.
- [x] Attach official `llm` + `llm-pi-ai` without replacing the adapter.
- [x] `llm/stream` guard refuses hijacked managed routes.
- [x] Two Spaces stream one shared mock through the official adapter; local same-name models stay distinct.

## P3 — management APIs and apply plan

- [x] Supervisor/HTTP `llm` (redacted) and `llmCredential` (secret-only) methods.
- [x] Write owner required; workspace origins cannot call management APIs.
- [x] Operation status `committed` / `not-found` / `unknown`; lost responses are not replayed.
- [x] `llm.apply` jobs are secret-free; busy/unknown Spaces refuse apply; batch A keep / B fail / C skip.
- [x] Explicit discover/test with 15s / 2 MiB / no-redirect / 1000-model bounds.

## P4 — global model center and Space selection

- [x] Workbench settings → Models and connections (list, four-step editor, discover/test copy, delete preview).
- [x] Space binding: all / selected / none, inherit or choose default, local vs shared groups.
- [x] New-space wizard preselects use-global; web and existing spaces stay unjoined unless submitted.
- [x] Manager-Host `llmCredential` remote for Key / draft discover; secrets stay off StoredJob.
- [x] Desktop settings tab and create checkbox reuse the same DTO and Host service.

## Later phases

- P5 explicit adoption and secret-free export
- P6 release gates

Do not add retries, fallbacks, restore entry points, or a second settings copy per Space.
