# Source provenance

The JSON/share-code blueprint concept and the raw-DEFLATE, Base64url, UTF-8 and bounded-decompression codec in `codec.mjs` are extracted/adapted from:

- Repository: https://github.com/klarkxy/dsh-spaces
- Source path: `src/adapters/node/blueprint-codec.ts` (its location at the referenced blob; since 2026-10-23 the current tree keeps it at `src/adapters/node/blueprint/blueprint-codec.ts`)
- Source blob: `c3e9a717dcf00ce1a7bab68dd53e7675c59712d2`
- Source license: MIT, copyright (c) 2026 DSH Spaces contributors.

The original MIT notice is retained in LICENSE. New code in this package is also MIT. The surrounding dsh-plugins repository's other packages retain their own licenses.

On 2026-10-09 this package moved back to `dsh-spaces/packages/blueprint`, retaining its public npm identity. The pure legacy `src/shared/blueprint.ts`, `src/core/domain/blueprint.ts` and `src/adapters/node/blueprint-codec.ts` implementations moved into `src/v1/` under the same MIT notice. The package's own authenticated HTTP adapter was retained because the published plugin-kit helper does not support this protocol's body allowance. Spaces execution and isolation remain outside this package.

The application engine, strict v2 JSON validation, optional policy, host adapter and client integration here target the official current-profile plugin manager. Spaces Supervisor, space creation, LLM connection bindings, workbench RPC, Electron integration and private filesystem write paths are not runtime dependencies and were not copied.

Upstream API inspection: deepseek-ai/deepseek-harness at `477b4f420553e8a52c2fbccc464d7561b239c443`, particularly `packages/boot/plugin-manager`, `packages/client/connection`, `packages/client/ui-plugin-manager`. This inspection is source evidence, not a claim that the same APIs are shipped by every npm or desktop version.
