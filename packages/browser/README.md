# @dsh-spaces/browser

> Release status: Browser Space entry points are sealed in Spaces 0.5.0. The create UI, Browser creation/catalog requests, startup and native presentation are disabled. The implementation and tests below are retained for future acceptance, not advertised as an enabled feature in this release. The Browser package keeps its independent 0.4.0 product version.

Browser is a separate DSH Space base, distributed as a DSH bundle. It owns one blank home tab at startup and opens an HTTP(S) URL in a new tab through its `browser.openURL` capability; `browser.listTabs` lists tabs. The total limit is 16, including Home. There is no close-tab command and no restore across Space restarts. Its configuration starts from an empty profile and loads Browser, authenticated transport, credentials scoped to the Space, plugin management, configuration forms and the slot renderer. It does not load the official dsh-base or dsh-web-app bundles, Session, Agent, model adapters or chat UI. It reuses the official DSH Web Host, Cordis, authenticated Connection RPC and slot renderer; the independent root, the small tab state and the cross-Space operations are local implementations. It does not extract the official Session-sidebar Browser component. The package has no model integration, Playwright bridge, DOM extraction, or content access.

Fault policy: [docs/let-it-crash.md](../../docs/let-it-crash.md). Current architecture baseline: [docs/architecture.md](../../docs/architecture.md).

## Ownership and cross-Space permission

The Browser Host requires a Supervisor-owned Space with the lightweight view bridge and private Node IPC. A plain `dsh web` profile launched outside that ownership does not supply the space message service and will not activate the Browser Host.

The Space's own configuration must explicitly name allowed source Space IDs in `config.allowedSpaces`; the default empty list denies all cross-Space callers. The Host-only space message service performs caller authentication and checks the exact source allowlist on every operation. Static capability descriptions are filtered by the same allowlist. The Browser UI uses DSH's authenticated same-Space Remote. Tabs live only for the current Space process lifetime.

To permit a Space named `coding` to call this Browser Space, edit the Browser Space's own configuration while it is stopped and replace the entire config with `config: { allowedSpaces: [coding] }`, then start it. Do not set a wildcard and do not copy the manager's plugin into the Browser Space. The source Space must already have the lightweight view bridge so its Host can use the space message capability for `browser.openURL` and for capability queries. Permission changes take effect only after the Browser Space starts with the new config. No all-Spaces grant exists.

## Web mode limits

`requestedUrl` is the address used when a tab is opened. In Web mode, each page is an iframe. Sites may block embedding, and cross-origin links and redirects inside the iframe are not observable by the Browser Space. Therefore `url` and the address shown in Web mode remain the opening address, not necessarily the iframe's current page. The UI labels this as a Web preview and explains that some sites refuse embedding, with an explicit external-open route for blank or refused pages. This is a visible limitation notice, not automatic detection of a cross-origin failure cause. No claim is made that arbitrary websites can be displayed or that Web mode can read their content.

## Official Desktop presentation

Official Windows Desktop 0.2.1-rc.2 uses its supported browser lease API to create sandboxed guests in the outer plugin document, without a privileged guest preload or nested webview tags. The authenticated portal accepts presentation only from its registered manager, which verifies the selected child identity and clips the viewport. Closed, bounded fragments carry presentation requests and correlated observations; they grant no management or script execution API. A/B/A tab switching keeps live guests and page navigation updates the URL/title. After the view is hidden, the presentation lease expires within roughly 2.5 seconds and destroys its guests. A later presentation uses a new isolated partition identity; the official Desktop retains partition storage in memory until it exits, so long-absence page/sign-in state is not promised and immediate storage erasure is not claimed. Failed tabs are not reacquired during that host lifetime. Installed Desktop acceptance, including pages that prohibit iframe embedding, is recorded in [the acceptance report](../../tasks/archive/node24-desktop-20261020.md).

## Installation and versions

This package is not the user install unit: users add the prebuilt `@dsh-spaces/plugin` tarball to their host profile and initialize Spaces. In New Space, choose **Browser** as the base, then its product version. The version list comes from the actual bundled Browser release (currently 0.4.0), independently of official Web versions. The Browser package declares its exact DSH framework dependency in `dsh.spacesBase.runtimeVersion` (currently 0.2.1-rc.2). The registry records both coordinates; selecting a Browser release never treats its version as a DSH CLI version. The DSH runtime switch is unavailable for Browser because that dependency belongs to the base release.

The Space details retain normal plugin installation and removal. Browser plugins can register into `browser.toolbar` and `browser.overlay`, both additive root-scoped DSH slots. These are DSH plugins, not Chrome extensions. For example, a client plugin can use `ctx.slots.inject('browser.toolbar', () => ctx.slots.register({ name: 'browser.toolbar', id: 'my-action' }, () => /* React element */ null))`. Disposing the plugin removes its UI contribution.

Templates and shares carry `source.base` and `source.baseVersion`; import creates the same base before installing extensions. An unavailable Browser release fails explicitly. The base itself is protected from ordinary plugin removal and is not exported as a manual plugin requirement. No old-space migration is performed.

An already-installed Browser plugin is **not** automatically re-aligned to the current component group. A Space that already has it keeps it until the user performs an explicit maintenance operation; the actual component state must be shown rather than assumed. The manager plugin is the one component aligned with the current group before the manager starts.
