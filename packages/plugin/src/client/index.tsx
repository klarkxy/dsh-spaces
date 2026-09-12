import { createElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
// Type-only augmentation imports (erased at build; no runtime cost):
// renderer contributes the ctx.slots SlotRegistry face, layout the keyed
// 'main' SlotMap entry + GlobalStandardProps, sidebar the 'sidebar.panellist'
// list entry. Registration below is checked against those real contracts.
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import { inferSpacesLocale, t } from "./i18n";
import { SpacesPanelIcon } from "./icon";
import { SpacesMainPanel } from "./panel";
import { createSpacesRemote } from "./remote";

/**
 * DSH client plugin entry for Spaces.
 *
 * Registration evidence (CLI 0.1.5-rc.1 / SDK 0.1.5-rc.2):
 * - `sidebar.panellist` is an additive root-scope LIST slot declared by
 *   ui-sidebar; each entry id addresses the matching `main` panel. Register
 *   options: { name, id, order, label } (dsh-client-ui-sidebar
 *   lib/types/client/contract/slots.d.ts + shipped slot catalog example).
 * - `main` is a root-scope KEYED slot declared by ui-layout; registration
 *   takes { name, key } (dsh-client-ui-layout lib/types/client/index.d.ts +
 *   shipped slot catalog example; key domain is open, "conversation" taken).
 * - Both registrations go through `ctx.slots.inject(name, () => register(...))`
 *   so they land after the declaring shell mounts (shipped client.js usage).
 * - `ctx.connection.rpc.call("/api", endpoint, { args })` is the Remote
 *   invocation path (dsh-client-connection ClientConnectionRpc + the shipped
 *   dsh-api-gateway invoke()).
 */

/** Panel identity shared by the sidebar entry and the main panel key. */
export const SPACES_PANEL_ID = "dsh-spaces";
/** English fallback; live sidebar text comes from the label thunk. */
export const SPACES_PANEL_LABEL = "Spaces";

/** Services required before this plugin starts (cordis inject list). */
export const inject = ["slots", "connection"];

/**
 * Client plugin body: bridge ctx.connection to the Spaces Remote API, add the
 * Spaces row to the sidebar panel list, and register the matching main panel.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const connection: ConnectionHandle = ctx.get("connection");
  const remote = createSpacesRemote(connection);
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: SPACES_PANEL_ID,
        order: 100,
        // Thunk re-reads browser language; in-panel switch does not notify the host sidebar.
        label: () => t(inferSpacesLocale(), "panel.title"),
      },
      SpacesPanelIcon,
    ),
  );
  ctx.slots.inject("main", () =>
    ctx.slots.register({ name: "main", key: SPACES_PANEL_ID }, () =>
      createElement(SpacesMainPanel, { remote }),
    ),
  );
}
