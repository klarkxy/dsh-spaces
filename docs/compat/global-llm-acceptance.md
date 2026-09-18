# Global LLM first-version acceptance

Pinned runtime: `@deepseek-ai/dsh-*@0.1.5-rc.2`. Fault policy: [docs/let-it-crash.md](../let-it-crash.md). Plan: [docs/plans/global-llm-connections.md](../plans/global-llm-connections.md).

A01–A24 and A26–A30 are first-version gates. A25 is not delivered.

## Commands

```sh
npm run test:llm
npm run test:llm:integration
npm run test:llm:browser
npm run validate:llm:secrets
npm run validate:llm:distribution
```

Homes are temporary directories or `.sandbox`. These commands do not read or write `~/.dsh`.

## Matrix

| ID | Result | Evidence |
|---|---|---|
| A01 | pass | `tests/llm-multi-space.test.ts`, `tests/llm-integration.test.ts`: web has no shared route; A/B consume one snapshot |
| A02 | pass | `tests/llm-multi-space.test.ts`: A/B/web theme writes stay in their own settings files |
| A03 | pass | catalog is Home-level; UI copy and create-space submit `useSharedLlm` once (`tests/llm-ui.test.tsx`, `tests/llm-ui-dom.test.ts`) |
| A04 | pass | `tests/llm-multi-space.test.ts` plus `tests/llm-default-resolution.test.ts` and `tests/llm-space-settings.test.ts` |
| A05 | pass | running instance `catalogRevision !== catalog.revision` is pending; apply is an explicit restart (`tests/llm-api-auth.test.ts`, host `pendingRestart`) |
| A06 | pass | `tests/llm-stream.test.ts`, `tests/llm-integration.test.ts`: frozen snapshot keeps the old endpoint after catalog rotation |
| A07 | pass | `tests/llm-stream.test.ts`: local same-name models stay on their own mocks |
| A08 | pass | unsupported protocol refused; `requireOfficialLlmAdapter(null)` → `LLM_ADAPTER_MISSING`; supervisor never installs `llm-pi-ai` (`tests/llm-gates.test.ts`) |
| A09 | pass | `tests/llm-settings-bridge.test.ts`, `tests/llm-stream.test.ts`: missing record ignores same-name env |
| A10 | pass | official settings write to a managed route is rejected (`tests/llm-settings-bridge.test.ts`) |
| A11 | pass | forged reserved-prefix user routes do not become the resolved endpoint (`tests/llm-settings-bridge.test.ts`, stream hijack) |
| A12 | pass | `tests/llm-store.test.ts`, `tests/llm-concurrency.test.ts`: one commit, stale revision conflicts |
| A13 | pass | `tests/llm-api-auth.test.ts`: read-only dispatch refused |
| A14 | pass | leftover credential record reported; catalog stays original (`tests/llm-store.test.ts`) |
| A15 | pass | committed operation is not replayed; unknown stays unknown (`tests/llm-api-auth.test.ts`) |
| A16 | pass | new credential revision + frozen snapshot (`tests/llm-integration.test.ts`) |
| A17 | pass | `mode=all` and selected/disabled bindings block delete (`tests/llm-store.test.ts`) |
| A18 | pass | retired ids cannot be reused (`tests/llm-store.test.ts`) |
| A19 | pass | joined workers stream with no manager process; closing the Host does not spawn a control process (`tests/llm-integration.test.ts`) |
| A20 | pass | apply A keep / B fail / C skip (`tests/llm-api-auth.test.ts`) |
| A21 | pass | busy/unknown refuse apply before restart (`tests/llm-api-auth.test.ts`) |
| A22 | pass | `tests/llm-share.test.ts`: secret-free `llm.json`, explicit mapping, source ids are not refs |
| A23 | pass | `tests/llm-secret-leaks.test.ts`, `tests/llm-ui-dom.test.ts`, `validate:llm:secrets` |
| A24 | pass | discovery redirect / 2 MiB / 1000-model bounds (`tests/llm-api-auth.test.ts`) |
| A25 | not delivered | `LLM_CAPABILITIES.keyless === false`; UI shows keyless unsupported |
| A26 | pass | `tests/llm-space-settings.test.ts`: non-LLM YAML comments and unknown sections kept |
| A27 | pass | unknown catalog / snapshot / share / operations schema → `LLM_UNSUPPORTED_RUNTIME` |
| A28 | pass | `validate:llm:distribution` and `tests/llm-gates.test.ts` pack `@dsh-spaces/llm-bridge`. Desktop NSIS/electron installer is not this gate |
| A29 | POSIX pass; Windows not run | official writer uses `mode: 384` / `dirMode: 448`; POSIX `stat` is `0600`/`0700` (`tests/llm-credentials.test.ts`). Windows ACLs are not claimed |
| A30 | pass | no retry/rollback/restore/silent adapter install on LLM feature paths (`tests/llm-gates.test.ts`, `validate:llm:secrets`) |

## Residual limits (not claimed)

- Full official `dsh --profile` web-app processes against a paid model.
- Windows ACL inspection of the credential file.
- A25 keyless authentication as a product capability.
- npm publish of `@dsh-spaces/llm-bridge` or `@dsh-spaces/plugin`.
- Desktop installer (NSIS / DMG / AppImage) rebuild for this feature.

`0.1.5-rc.1` and unknown exact CLI versions refuse this new capability and must not break unjoined Spaces.
