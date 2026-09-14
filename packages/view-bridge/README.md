# @dsh-spaces/view-bridge

Lightweight DSH Host plugin for ordinary workspace iframes. It only does the parent handshake. It does not create a manager, start a supervisor, or expose workbench writes.

This package is **not** the user install unit. Users add the prebuilt `@dsh-spaces/plugin` tarball to ordinary `web`, then click **初始化 Spaces** / **Initialize Spaces**. The supervisor copies this payload onto ordinary spaces. See [plugin standard install](../../docs/plugin-standard-install.md).

`@dsh-spaces/supervisor` stays private. Do not `npm publish` this repo root. This scoped package is not on the npm registry yet — there is no `pnpm add @dsh-spaces/view-bridge` from npmjs.

Pack from the repository root with `node scripts/pack-spaces-plugin.mjs` (destination outside this directory, path without spaces). Do not `npm pack` into `packages/view-bridge`.
