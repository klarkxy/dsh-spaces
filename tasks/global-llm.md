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

## Later phases

- P1 catalog / policy stores and CAS
- P2 official adapter streaming through the bridge
- P3 management APIs and apply plan
- P4 global model center UI
- P5 explicit adoption and secret-free export
- P6 release gates

Do not add retries, fallbacks, restore entry points, or a second settings copy per Space.
