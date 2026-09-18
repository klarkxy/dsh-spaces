# @dsh-spaces/llm-bridge

Host-side adapter that projects a Spaces shared LLM catalog into one Space. It is not a second supervisor, not an HTTP proxy, and not a view handshake.

It does four things:

- inject selected shared connections into the official `llm-pi-ai` settings **base**
- resolve shared credential references from the global record store
- refuse official `settings` / `credentials` writes that target a managed route
- report connection source and the catalog/policy revisions this Space started with

It does not install plugins, start another Supervisor, or operate another Space. Shared routes stay out of the Space user settings file. Fault policy: [docs/let-it-crash.md](../../docs/let-it-crash.md).

This package is not the user install unit yet. P0 pins the official `0.1.5-rc.2` seams; later phases pack it with the standard plugin flow.
