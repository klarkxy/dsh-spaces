# Blueprint

[简体中文](README.zh-CN.md)

Maintained in [dsh-spaces/packages/blueprint](https://github.com/klarkxy/dsh-spaces/tree/main/packages/blueprint). This remains an independently installable plugin for DSH **0.2.0-rc.2 or later**, currently built against **0.2.1-rc.2**. Spaces depends on its protocol exports; Blueprint has no Spaces runtime dependency.

Share a plugin set as exact versions plus a preferred order. Paste a blueprint code into **Creator mode** together with your import intent, and the Agent merges it into the current profile's bundle collection. The Core part does not need Web — the Plugins page is an optional export and read-only parsing view. Blueprint does not provide Spaces, a separate application or a background Agent orchestrator.

**Source preview: the redesigned implementation has not completed real-host end-to-end acceptance.** The checks already run and the items still outstanding are listed in [ACCEPTANCE.md](ACCEPTANCE.md).

## Use

- **Merge in Creator.** In Creator (`cordis`), send the code with an intent such as “Merge this blueprint into my current plugin composition, preserve local bundles, and resolve versions and order yourself.” The Agent does not ask you to review a routine merge plan; native safety approvals still apply.
- **Plugin page.** Open **Plugins → Blueprint** to export the installed identities you select, in the order you prefer. The import view only parses the artifact, shows the package identities and preferred order, and prepares a copyable merge request. Paste and send that request in Creator: copying neither starts a model nor changes the profile.
- Local bundles the blueprint does not mention are preserved by default. A package listed in `packages` but absent from `bundles` only asks to be installed; it never asks to disable the same-name bundle in the receiving profile.

## Environment-independent Core

One package ships the Host Core plus an optional Web Client, so there is no separate UI package to install. What ACP, SDK and headless can do depends on their own plugin compositions. Environment independence does not mean that every deployment exposes the same services or can activate plugins immediately.

| Tool | Capability |
| --- | --- |
| `blueprint_parse` | Decode and validate a blueprint code, without reading a profile |
| `blueprint_encode` | Validate v2 JSON and encode a code, without installing or publishing |
| `blueprint_catalog` | Read the current profile's bundle identities, complete selected order and stale-state stamp |
| `blueprint_generate` | Export the selected installed identities with exact versions, in the preferred order |
| `blueprint_apply_order` | Creator only: permute the complete currently selected bundle order; it does not install, add or disable |

A tool appears once the services it needs exist:

- `blueprint_parse` and `blueprint_encode` need `tools` alone.
- `blueprint_catalog` and `blueprint_generate` also need the native `pluginManager` and `profileContext`.
- `blueprint_apply_order` also needs `sandboxPolicy` and `agentPresets`, and escalates through the native sandbox gate.

Creator prompt guidance is optional: it registers when `systemPrompt` and `agentPresets` are available, and injects only in Creator. The read-only Web page attaches only when the connection, Web server and profile services are available. Its UI is keyed by the npm package name at `plugins.bundle.config`, so no host toolbar patch is needed.

## Native execution and permissions

Install, update, enable, disable and remove all go through the native `plugin_manager`; Blueprint never duplicates the installer. The Agent picks compatible versions and ordering from verified metadata and your intent. If it settles on a version other than the exact one the blueprint records, it reports that deviation and leaves the original artifact unchanged.

The order tool only permutes bundles that are already selected. It rejects omissions, duplicates, unknown names, a stale state and changes to protected positions. It then passes the same danger-full-access, per-call escalation gate as native management, and afterwards uses the official file lock, the atomic manifest save and the optional HMR exclusive queue. The order is always: install and enable first, read a fresh catalog stamp, then apply the new order.

Saving configuration and activating at runtime are two different outcomes. Live environments reread the complete patch layers and reconcile activation; startup-only environments report that a restart is required. A failed application can leave saved configuration or partial runtime changes behind. There is no cross-plugin transaction, no automatic rollback and no retry of a mutation. Check the current state before you recover a lost response. The stamp covers the manifest and the bundle catalog, not the content of every patch file.

Agent autonomy never grants package scripts, version-risk exemptions or any permission that blueprint metadata asks for. Codes carry no signatures, encryption or author authentication, and descriptions are untrusted data, not instructions.

## Discovery and reusable defaults

To discover candidates, use metadata tools such as `dsh_plugins_search` / `dsh_plugins_fetch` from [`@klarkxy/dsh-dev-index`](https://www.npmjs.com/package/@klarkxy/dsh-dev-index), and verify the exact version and bundle declaration of each one. Search results and declared compatibility are not runtime proof. Never guess a version or silently swap a source. Portable sources are `npm` and `builtin`, not local links or git/tarballs.

Reusable settings belong in native composition/preset packages, with explicit component rows. Dependencies alone do not recursively activate every dependency bundle. Later layers take precedence, and a row patch replaces its whole `config` rather than deep-merging it. Profile and home overrides stay effective. Never ship credentials or machine-private data as defaults.

## Format and compatibility

The [protocol](PROTOCOL.md) defines the fields, the encoding, the limits and the test vectors. DSHBP2 / `formatVersion: 2` are unchanged, so existing codes stay readable. Autonomous merge in Creator is a new execution policy: the old page `preview` / `apply` / `result` endpoints are retired, not quietly repurposed for reordering.

```json
{
  "kind": "dsh-blueprint",
  "formatVersion": 2,
  "metadata": { "name": "Example" },
  "packages": [{ "name": "example-plugin", "version": "1.2.3", "source": "npm" }],
  "bundles": ["example-plugin"]
}
```

The package name above is illustrative. Settings, credentials, row states and nested blueprints are not transported. A code is the literal prefix `DSHBP2:` followed by raw-DEFLATE UTF-8 JSON in unpadded canonical Base64url. Limits: 2 MiB input, 1 MiB decoded JSON, 64 container levels. Strict parsing rejects duplicate members, unsafe numbers, prototype keys, malformed Unicode, noncanonical Base64url and trailing compressed data.

`./core` retains `validate` and adds `parseBlueprint`, `encodeBlueprint` and `BlueprintCore`. `./codec` retains `encode` / `decode`.

## Development and source installation

```sh
cd packages/blueprint
npm install
npm test
npm run build
npm pack
# Use the actual archive path and an explicit target profile:
dsh plugin --profile <target-profile> add <absolute-archive-path>
```

Official packages are provided by the runtime: this plugin declares them as optional peers with open lower bounds and never bundles its own copy. The current source targets the installed official CLI `0.2.1-rc.2`; historical tests on `0.1.7-rc.2` are recorded separately in [ACCEPTANCE.md](ACCEPTANCE.md). Tests run in isolated temporary directories, never against a production profile. Syntax or offline contract checks are not real-host certification.

## Protocol consumers

`./core` and `./codec` retain the standalone v2 API. `./document` validates either supported document and exposes `blueprintRecipe()` as a pure view of already validated data; keep its `document` for persistence/sharing. This entry is browser-safe. `./document-codec` is the Node encoder/decoder for DSHBP1, DSHBP2 and JSON. Unknown versions fail explicitly.

`./v1`, `./v1/types`, `./v1/codec` and `./schemas/blueprint-v1.schema.json` retain the complete legacy preset format. Spaces imports these public interfaces and implements its own space creation, isolation and installation. The standalone Creator tools still use v2 current-profile merge semantics. Exporting plugin identities as v2 does not transport configuration or user data.

MIT licensed. The retained codec attribution is in [NOTICE.md](NOTICE.md); the licence text is in [LICENSE](LICENSE).
