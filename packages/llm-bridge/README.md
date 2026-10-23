Host-side LLM facade for a Space. New ordinary spaces use the main host's model through an authenticated Supervisor channel; legacy shared and local policies keep their existing paths.

Main inheritance uses an explicit v2 policy. Providers appear under `spaces-main:<provider>` and `spaces-main/default` follows the current main default. Official UI `model/selection` events and Agent options supply explicit controls before request freezing. Choosing Default clears the explicit reasoning choice. The main host owns the official prepared call, adapter and credentials; none of its provider profiles or keys are copied to the child.

The facade owns its displayed model route. Its replay envelope preserves native response state and blocks losslessly with the exact upstream route. The main plugin validates that route, unwraps it, then lets the original SDK apply native replay filtering. Unwrapped local history, including a same-named local provider, does not prove a main origin. Source-session attachment authorization and path/integrity checks run before source files are projected or source images are read.

An interrupted call fails and releases its resources. There is no retry, reconnect, alternate provider or interrupted-job replay. The original SDK remains an external dependency.

The legacy shared-policy path continues to:

- merge selected shared connections into the official `llm-pi-ai` effective Config through Cordis `internal/config`, keeping raw `entry.options.config` and the profile patch local-only
- resolve shared credential references from the global record store
- refuse official `settings` / `configEditor` / `credentials` writes that target a managed route
- report connection source and the catalog/policy revisions this Space started with

It does not install plugins, start another Supervisor, or operate another Space. Shared routes stay out of the Space profile patch. Fault policy: [docs/let-it-crash.md](../../docs/let-it-crash.md).

For the legacy shared-policy path, a frozen launch snapshot (`DSH_SPACES_LLM_SNAPSHOT`) is the process input. The plugin reuses native `SettingsForms` and `configEditor`; it does not recreate the removed rc2 `register` / `section` / `commit` provider. `attachOfficialLlm` installs the `llm/stream` guard; it does not replace `llm-pi-ai`. Missing official `llm-pi-ai` is reported, not silently installed. Uninstalling or leaving shared access does not delete the Home catalog or credentials.

The bundle patch inserts this plugin and adds `spacesLlmSnapshot` inject waiters on `llm-pi-ai` and `agent-default-model` so fiber schema resolution sees the waterfall on first mount. Do not project shared routes with `--patch` or `Loader` `entry.update`.
