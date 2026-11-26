import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { motion } from "motion/react";
import { UI_TOKENS_CSS } from "../../../../src/shared/ui/tokens";
import { FadeIn, Presence, fade } from "../../../../src/shared/ui/motion";
import { HostShellController } from "./host-shell-state";
import { attachHostLayout } from "./host-layout";
import { SpaceGlyph } from "../workbench/space-glyph";
import { HOST_LIGHT_MATERIAL_CSS, HOST_UI_TOKEN_CSS } from "./ui/material";
import { HostLoadingPill, HostShellPanel } from "./ui/host-guide";
import { HostRail, HostRailButton, HostRailDivider, HostRailList } from "./ui/host-rail";
import { hostTexts } from "./ui/host-texts";
import { CreationRailEntry, CreationFailureDialog } from "./ui/creation-rail";
import { CREATION_RING_CSS } from "../../../../src/shared/ui/creation-ring";
import { ATTENTION_RING_CSS } from "../../../../src/shared/ui/attention-ring";
import { HOST_ACTIVITY_GLOW_CSS } from "./ui/activity-glow";

/**
 * The additive space dock of a compatible host.
 *
 * The host keeps its own root, branding, native chrome and live conversation:
 * this shell only adds a rail and a surface. The portal frame keeps its
 * element, its parent and its mount order — it is never remounted, resized
 * or re-placed, because the space inside it would reload.
 */
export const HOST_SHELL_CSS = `${UI_TOKENS_CSS}${HOST_UI_TOKEN_CSS}${HOST_LIGHT_MATERIAL_CSS}
[data-spaces-host-rail] > [data-spaces-host-covered] { visibility: hidden !important; pointer-events: none !important; }
.dsh-host-dock { position:fixed; inset:0; pointer-events:none; font:14px/1.5 system-ui; color:var(--host-text,var(--dsw-alias-label-primary,#202127)); }
.dsh-host-rail { pointer-events:auto; position:absolute; top:var(--dsh-frame-top-clearance,0px); bottom:0; left:0; width:72px; box-sizing:border-box; padding:10px 8px; display:flex; gap:8px; flex-direction:column; align-items:center; background:var(--dsw-alias-bg-base,var(--host-rail-bg,#f0f1f5)); border-right:0.5px solid var(--dsw-alias-border-l2,var(--host-border,#d6d8de)); transition:box-shadow var(--host-dur-base) var(--host-ease-standard); }
.dsh-host-rail[data-busy="true"] { box-shadow:inset -1px 0 0 0 color-mix(in srgb,var(--host-accent) 45%,transparent); }
.dsh-host-rail-divider { flex:none; width:28px; height:1px; margin:2px 0; background:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 14%,transparent)); }
.dsh-host-rail-list { flex:1; min-height:0; overflow-y:auto; width:100%; display:flex; flex-direction:column; align-items:center; gap:8px; }
.dsh-host-rail button { flex-shrink:0; width:48px; height:48px; border:1px solid transparent; border-radius:14px; background:transparent; color:inherit; font:inherit; cursor:pointer; overflow:hidden; }
.dsh-host-rail button:hover { background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent)); }
.dsh-host-rail button[aria-current=true] { border-color:transparent; background:var(--dsw-alias-interactive-bg-active,color-mix(in srgb,currentColor 10%,transparent)); }
.dsh-host-rail button:focus-visible { outline:2px solid currentColor; outline-offset:1px; }
.dsh-host-rail button:has(.dsh-wb-glyph-img) { padding:0; }
.dsh-host-rail .dsh-wb-glyph-img { display:block; width:100% !important; height:100% !important; max-width:100%; max-height:100%; object-fit:cover; }
.dsh-host-rail .dsh-wb-glyph { width:32px; height:32px; fill:currentColor; }
.dsh-host-surface { position:absolute; top:var(--dsh-frame-top-clearance,0px); bottom:0; left:var(--dsh-spaces-rail-width,72px); right:0; pointer-events:auto; background:var(--dsw-alias-bg-base,var(--host-bg,#fff)); color:var(--dsw-alias-label-primary,var(--host-text,#202127)); }
iframe.dsh-host-surface { width:calc(100% - var(--dsh-spaces-rail-width,72px)); height:calc(100% - var(--dsh-frame-top-clearance,0px)); border:0; }
.dsh-host-surface[hidden] { display:none !important; }
.dsh-host-guide { padding:24px; box-sizing:border-box; overflow:auto; color:var(--dsw-alias-label-primary,var(--host-text,#202127)); }
.dsh-host-guide button { padding:8px 14px; margin:8px 8px 8px 0; border:1px solid currentColor; border-radius:8px; background:transparent; color:inherit; cursor:pointer; transition:background-color var(--host-dur-fast) linear, border-color var(--host-dur-fast) linear, box-shadow var(--host-dur-base) var(--host-ease-standard); }
.dsh-host-guide button:hover:not(:disabled) { background:color-mix(in srgb,currentColor 10%,transparent); }
.dsh-host-guide button:focus-visible { outline:2px solid currentColor; outline-offset:1px; }
.dsh-host-loading { position:absolute; bottom:12px; left:calc(var(--dsh-spaces-rail-width,72px) + 12px); display:flex; align-items:center; gap:8px; padding:6px 12px; background:var(--dsw-alias-bg-base,var(--host-bg,#fff)); color:var(--dsw-alias-label-primary,var(--host-text,#202127)); pointer-events:none; border-radius:var(--host-radius-pill,999px); box-shadow:var(--host-elev-md,0 10px 26px -14px rgba(0,0,0,0.45)); }

/* Rail material: a hover morph and a sliding selection pill. */
.dsh-host-rail-btn {
  position:relative;
  transition:transform var(--host-dur-base) var(--host-ease-spring,cubic-bezier(0.34,1.56,0.64,1)), border-radius var(--host-dur-base) var(--host-ease-standard), background-color var(--host-dur-fast) linear, box-shadow var(--host-dur-base) var(--host-ease-standard);
}
.dsh-host-rail-btn:hover:not(:disabled) { border-radius:14px; }
.dsh-host-rail-btn:active:not(:disabled) { transform:scale(0.96); }
.dsh-host-rail-btn[aria-current] { box-shadow:none; }
.dsh-host-rail-btn > *:not(.dsh-host-rail-pill) { position:relative; z-index:1; }
.dsh-host-rail-pill {
  position:absolute; inset:0; z-index:2; pointer-events:none;
  border-radius:inherit;
  background:var(--dsw-alias-interactive-bg-active,color-mix(in srgb,currentColor 10%,transparent));
}

/* Guide and loading material. */
.dsh-host-guide-title { margin:0 0 8px; font-size:18px; font-weight:600; }
.dsh-host-guide-body { margin:0 0 8px; color:var(--host-text,var(--dsw-alias-label-secondary,#59636e)); }
.dsh-host-error { margin:0 0 8px; padding:8px 10px; border:1px solid var(--host-danger,var(--dsw-alias-label-error,#d1242f)); border-radius:8px; color:var(--host-danger,var(--dsw-alias-label-error,#d1242f)); overflow-wrap:anywhere; }
.dsh-host-detail { margin:0 0 8px; padding:8px 10px; border:1px solid var(--host-border,var(--dsw-alias-border-l3,#d6d8de)); border-radius:8px; font-family:var(--ds-font-family-code,ui-monospace,monospace); font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere; }
.dsh-host-action { background:transparent; }
.dsh-host-loading-bar {
  display:block; width:36px; height:4px; border-radius:var(--host-radius-pill,999px);
  background-color:color-mix(in srgb,var(--host-text,#202127) 12%,transparent);
  background-image:var(--host-shimmer,linear-gradient(100deg,transparent 20%,rgba(255,255,255,0.35) 42%,transparent 64%));
  background-size:200% 100%;
  animation:dsh-ui-shimmer 1.6s linear infinite;
}
.dsh-host-loading-label { white-space:nowrap; }
${CREATION_RING_CSS}
${ATTENTION_RING_CSS}
${HOST_ACTIVITY_GLOW_CSS}
`;

/** Shared layout id of the portable selection pill. */
const RAIL_LAYOUT_ID = "dsh-host-rail-pill";

/** Additive shell-overlay occupant. The host's root and document are never replaced. */
export function PortableHostShell({ controller }: { controller: HostShellController }): ReactElement {
  const ui = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const anchor = useRef<HTMLDivElement>(null), layout = useRef<ReturnType<typeof attachHostLayout> | null>(null);
  const [layoutError, setLayoutError] = useState(false);
  const t = hostTexts();
  useLayoutEffect(() => {
    if (!anchor.current) return;
    try { layout.current = attachHostLayout(anchor.current); }
    catch { setLayoutError(true); return; }
    return () => { layout.current?.dispose(); layout.current = null; };
  }, []);
  useLayoutEffect(() => { layout.current?.cover(ui.visible !== "current"); }, [ui.visible]);
  useEffect(() => {
    if (layoutError || !layout.current) return;
    controller.start();
    const listen = (event: MessageEvent) => controller.handleMessage(event);
    window.addEventListener("message", listen);
    return () => { window.removeEventListener("message", listen); controller.stop(); };
  }, [controller, layoutError]);
  const creations = controller.visibleCreations();
  const creatingIds = new Set(creations.map(c => c.spaceId));
  const spaces = ui.inventory?.spaces.filter(s => s.id !== ui.inventory?.managerId && s.id !== ui.role?.profileId && !creatingIds.has(s.id)) ?? [];
  // A guide that reports a failure is never faded: an animation must not delay
  // or soften a real error.
  const failed = ui.error !== null || layoutError;
  return <div ref={anchor} className="dsh-host-dock dsh-ui" data-spaces-host-dock="true" data-spaces-host-phase={ui.phase} data-spaces-host-error={ui.error ?? undefined} data-host-glow={ui.hostGlow ?? undefined}>
    <div className="dsh-host-glow" aria-hidden="true" data-glow={ui.hostGlow ?? undefined} data-surface={ui.visible === "current" ? "current" : undefined} />
    <span className="dsh-host-glow-status" role="status" aria-live="polite">{ui.hostGlow === "attention" ? t.attention : ui.hostGlow === "working" ? t.working : ""}</span>
    <HostRail label={t.title} layoutId={RAIL_LAYOUT_ID} busy={ui.pending !== null}>
      <HostRailButton layoutId={RAIL_LAYOUT_ID} label={ui.hostGlow === "attention" ? `${t.current} · ${t.attention}` : ui.hostGlow === "working" ? `${t.current} · ${t.working}` : t.current} current={ui.visible === "current"} pinned glow={ui.hostGlow} onSelect={controller.showCurrent}>
        <SpaceGlyph spaceId={ui.role?.profileId ?? ""} icon={ui.inventory?.spaces.find(space => space.id === ui.role?.profileId)?.icon} />
      </HostRailButton>
      <HostRailDivider />
      <HostRailButton layoutId={RAIL_LAYOUT_ID} label={t.home} current={ui.visible === "portal" && ui.selected === null} onSelect={() => controller.select(null)}>⌂</HostRailButton>
      <HostRailList>
        {spaces.map(space => <HostRailButton key={space.id} layoutId={RAIL_LAYOUT_ID}
          label={space.attention === "required" ? `${space.displayName} · ${t.attention}` : space.displayName}
          current={ui.visible === "portal" && ui.selected === space.id} status={space.status} attention={space.attention}
          spaceId={space.id} onSelect={() => controller.select(space.id)}>
          <SpaceGlyph spaceId={space.id} icon={space.icon} />
        </HostRailButton>)}
        {creations.map(creation => (
          <CreationRailEntry key={creation.jobId} creation={creation} layoutId={RAIL_LAYOUT_ID} onSelect={() => controller.openCreation(creation)} />
        ))}
      </HostRailList>
      <HostRailButton layoutId={RAIL_LAYOUT_ID} label={t.manage} onSelect={controller.showGuide}>⋯</HostRailButton>
    </HostRail>
    {ui.portal && <iframe className="dsh-host-surface" title="Spaces surface" data-spaces-host-surface="true" src={ui.portal.src}
      ref={element => controller.registerFrame(element?.contentWindow ?? null)} referrerPolicy="no-referrer" allow="clipboard-write"
      hidden={ui.visible !== "portal"} />}
    {(ui.visible === "guide" || layoutError) && <Presence initial={false}>
      <motion.div
        key="dsh-host-guide"
        className="dsh-host-surface"
        initial={failed ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={failed ? { opacity: 1 } : { opacity: 0 }}
        transition={fade}
      >{layoutError ? <FadeIn as="section" appear={false} className="dsh-host-guide" role="alert">{t.unsupported}</FadeIn> : <HostShellPanel controller={controller} />}</motion.div>
    </Presence>}
    {ui.creationFailed && <CreationFailureDialog creation={ui.creationFailed}
      onView={() => { controller.closeCreationFailed(); controller.select(null); }}
      onDismiss={() => controller.dismissCreation(ui.creationFailed!.jobId)}
      onClose={controller.closeCreationFailed} />}
    {ui.pending !== null && <HostLoadingPill label={t.loading} />}
  </div>;
}

export { HostShellPanel };
