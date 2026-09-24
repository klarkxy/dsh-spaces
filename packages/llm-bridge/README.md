Host-side adapter that projects a Spaces shared LLM catalog into one Space. It is not a second supervisor, not an HTTP proxy, and not a view handshake.

It does four things:

- merge selected shared connections into the official `llm-pi-ai` effective Config through Cordis `internal/config`, keeping raw `entry.options.config` and the profile patch local-only
- resolve shared credential references from the global record store
- refuse official `settings` / `configEditor` / `credentials` writes that target a managed route
- report connection source and the catalog/policy revisions this Space started with

It does not install plugins, start another Supervisor, or operate another Space. Shared routes stay out of the Space profile patch. Fault policy: [docs/let-it-crash.md](../../docs/let-it-crash.md).

A frozen launch snapshot (`DSH_SPACES_LLM_SNAPSHOT`) is the process input. The plugin reuses native `SettingsForms` and `configEditor`; it does not recreate the removed rc2 `register` / `section` / `commit` provider. `attachOfficialLlm` installs the `llm/stream` guard; it does not replace `llm-pi-ai`. Missing official `llm-pi-ai` is reported, not silently installed. Uninstalling or leaving shared access does not delete the Home catalog or credentials.

The bundle patch inserts this plugin and adds `spacesLlmSnapshot` inject waiters on `llm-pi-ai` and `agent-default-model` so fiber schema resolution sees the waterfall on first mount. Do not project shared routes with `--patch` or `Loader` `entry.update`.
