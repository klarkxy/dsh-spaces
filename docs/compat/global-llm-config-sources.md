# Global LLM config source table

Measured against `klarkxy/dsh-spaces` `be9b7a59` (includes plan baseline `861cf4e9`) and the published npm packages at **`0.1.5-rc.2`**. This table is about where configuration actually comes from. It is not inferred from Home, `sessions/`, or `storages/` layout.

## Launch path

`ProcessManager.start` still spawns `dsh --profile <name>` with the **same** `DSH_HOME` for `web` and every workbench. That only proves the process environment. It does not prove the settings or credentials document path.

Official `0.1.5-rc.2` providers resolve those documents themselves:

| Provider | Package | Default path | Custom path |
|---|---|---|---|
| Settings | `@deepseek-ai/dsh-settings-file` | `<dshHome>/settings.yaml` | `config.path` wins (`resolveSpec`) |
| Credentials | `@deepseek-ai/dsh-credentials-local` | `<dshHome>/.credentials.yaml` | `config.path` wins (`resolveSpec`) |

`dsh --dump-config` on this repo's captured web tree shows the plugins with **no path override**:

```text
- id: settings
  name: '@deepseek-ai/dsh-settings-file'
- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
```

So before this change, every profile that shared `DSH_HOME` shared one settings document and one credential document. Session and storage isolation did not separate them.

## Authority after P0

| Data | Authority | Consumer | Writer |
|---|---|---|---|
| Shared connections and model catalog | `<home>/.dsh-spaces-control/llm/catalog.json` | Joined Spaces | Home write owner |
| Shared keys | `<home>/.dsh-spaces-control/llm/credentials.yaml` | Host-side llm-bridge | Secret-only global API (later phases) |
| Space binding | `<space data root>/llm-policy.json` | That Space's bridge | Authorized policy update |
| Workbench local settings | `hub/<name>/settings.yaml` | That Space | Official settings writes in that Space |
| Workbench local credentials | `hub/<name>/.credentials.yaml` | That Space | Official local credential writes |
| web settings / credentials | official home files | web | official web UI / API |
| Space default model | Space `agent-default-model` user section | That Space | Space settings |
| Session model | existing session state | agent / session | session operations |
| Applied catalog/policy revision | instance runtime status | management UI | launcher / instance report |

There is no per-Space copy of the shared provider document. Shared routes exist only in the in-memory settings **base**.

## Composition layers used by the prototype

Official `SettingsProvider` resolves `schema defaults → composition base → user section`.

`llm-pi-ai@0.1.5-rc.2` calls `settings.installSection(...)`, which registers with `base: entry`. `SpacesFileSettingsProvider` overrides the public `register()` method and merges selected shared routes into that base for `llm-pi-ai` (and the applicable global default into `agent-default-model`). Other namespaces pass through.

## What P0 did not run

- Full official CLI `dsh --profile` processes talking to a paid model.
- `rc.1` shared-LLM enablement. Unjoined Spaces on any exact CLI version keep their previous non-LLM behavior.
