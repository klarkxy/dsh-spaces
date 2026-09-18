# Global LLM compatibility matrix

Pinned runtime for this feature: **`@deepseek-ai/dsh-*@0.1.5-rc.2`**.

Inspection used the published npm tarballs, not the upstream default-branch source. Master APIs that are not in this tarball are not claimed.

## Package versions

| Package | Version | Result |
|---|---|---|
| `@deepseek-ai/dsh-settings` | 0.1.5-rc.2 | required |
| `@deepseek-ai/dsh-settings-file` | 0.1.5-rc.2 | required |
| `@deepseek-ai/dsh-credentials` | 0.1.5-rc.2 | required |
| `@deepseek-ai/dsh-credentials-local` | 0.1.5-rc.2 | required |
| `@deepseek-ai/dsh-llm` | 0.1.5-rc.2 | required |
| `@deepseek-ai/dsh-llm-pi-ai` | 0.1.5-rc.2 | required |
| `@deepseek-ai/dsh-agent-default-model` | 0.1.5-rc.2 | required |
| `@deepseek-ai/dsh-client-connection` (repo peer) | 0.1.5-rc.2 | already pinned |

## Public extension points used

| Seam | 0.1.5-rc.2 export | Used how | Status |
|---|---|---|---|
| Settings path | `resolveSpec({ path, dshHome })` | per-Space `hub/<name>/settings.yaml` | pass |
| Settings layers | `SettingsProvider.register(ns, schema, { base })` | inject shared routes into base | pass |
| Settings install | `installSection` calls `this.register` | override `register` is enough | pass |
| Settings writes | `update` / `replace` / `mutate` | reject managed routes | pass |
| Settings file | `FileSettingsProvider` load/publish | detect reserved-prefix hijack | pass |
| Credentials path | `LocalCredentialProvider.resolveSpec({ path })` | per-Space local store | pass |
| Credential records | `readRecord` / `modifyRecord` / `describe` | shared keys stay on records | pass |
| Credential refs | `resolve` env > file > dotenv | **must not** be used for `SPACES_LLM_*` | pass (wrapper) |
| llm-pi-ai protocols | `supportedProtocols()` | `openai-completions`, `openai-responses`, `anthropic-messages` | pass |
| Default model | `agent-default-model` settings | Space user layer overrides injected global default | pass |

## Protocol matrix

| Protocol | Constructed by `llm-pi-ai@0.1.5-rc.2` | Shared connection v1 |
|---|---|---|
| `openai-completions` | yes | allowed |
| `openai-responses` | yes | allowed |
| `anthropic-messages` | yes | allowed |
| `azure-openai-responses` | compat-only, not in `supportedProtocols()` | refused |
| `openai-codex-responses` | compat-only, not in `supportedProtocols()` | refused |
| native `deepseek-official` / other adapters | local-only | not auto-converted |

`none` authentication is not product-enabled until A25 passes. The prototype can project a `kind: "none"` connection but does not advertise keyless as delivered.

## Isolation matrix

| Space | Settings path | Credentials path | Shared LLM |
|---|---|---|---|
| web | official home `settings.yaml` (unpatched) | official home `.credentials.yaml` | off unless explicitly joined |
| new workbench | `hub/<name>/settings.yaml` | `hub/<name>/.credentials.yaml` | policy-selected snapshot at start |
| existing workbench without the new patch rows | still home files until the isolation patch is rewritten | same | not auto-joined |

`PatchWriter.verify` still requires only session/storage roots so an old workbench can start. `applyIsolationPatch` now writes settings and credentials paths for new creates and explicit patch rewrites. `assertDumpConfigIsolated` is the full check used by P0 tests.

## Runtime versions

| CLI / SDK | Shared LLM | Unjoined Space |
|---|---|---|
| `0.1.5-rc.2` | enable after P0–P6 gates | unchanged |
| `0.1.5-rc.1` | refuse this new capability | unchanged; do not break |
| unknown exact version | refuse this new capability | unchanged |

## Evidence commands

```sh
npm run test:llm
npm run typecheck:spaces
npm run test:spaces
```

P0 did not spawn full `dsh --profile` web-app processes for a paid model request. The multi-process proof uses three Node processes, each with the published `0.1.5-rc.2` settings and credentials providers.
