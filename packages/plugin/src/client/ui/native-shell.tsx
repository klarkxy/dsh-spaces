import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { motion } from "motion/react";
import { FadeIn, Presence, fade } from "../../../../../src/shared/ui/motion";
import { SpaceGlyph } from "../../workbench/space-glyph";
import { defaultStorage } from "../../workbench/persistence";
import { attachHostLayout } from "../host-layout";
import type { NativeHostController } from "./native-controller";
import { HostLoadingPill } from "./host-guide";
import { HostRail, HostRailButton, HostRailDivider, HostRailList } from "./host-rail";
import { PressButton } from "../../../../../src/shared/ui/motion";
import { useServiceRestart } from "./service-restart";
import { NativeSpaceMenu } from "./native-space-menu";
import { nativeStartupLabel, nativeStatusText, nativeTexts } from "./native-texts";
import { inferSpacesLocale } from "../i18n";
import { NativeDialog } from "./native-dialog";
import { CreationRailEntry, CreationFailureDialog } from "./creation-rail";

/**
 * The desktop (Electron) host shell.
 *
 * The native guest lives in the container this shell renders; the container is
 * positioned by the host, so nothing here may transform, resize or re-place
 * it. The motion lives on the rail, on the guide and on the loading notice —
 * all of them siblings of the container.
 */

/** Shared layout id of the desktop selection pill. */
const RAIL_LAYOUT_ID = "dsh-native-rail-pill";

/** localStorage key of the remembered rail visibility. */
const RAIL_STORAGE_KEY = "dsh-spaces.native.rail";

export function NativeHostShell({ controller }: { controller: NativeHostController }): ReactElement {
  const [active, setActive] = useState(controller);
  return <NativeHostShellView controller={active} onRestarted={setActive} />;
}

function NativeHostShellView({ controller, onRestarted }: { controller: NativeHostController; onRestarted: (next: NativeHostController) => void }): ReactElement {
  const ui = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const restart = useServiceRestart(controller, onRestarted, ui.serviceStopRequest);
  const texts = nativeTexts();
  const [menu, setMenu] = useState<{ spaceId: string; x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const menuSpace = ui.inventory?.spaces.find(space => space.id === menu?.spaceId);
  const anchor = useRef<HTMLDivElement>(null), container = useRef<HTMLDivElement>(null), layout = useRef<ReturnType<typeof attachHostLayout> | null>(null);
  useEffect(() => {
    try { layout.current = attachHostLayout(anchor.current!); }
    catch { controller.stop(); return; }
    void controller.start(container.current!);
    return () => { controller.stop(); layout.current?.dispose(); };
  }, [controller]);
  useEffect(() => { layout.current?.cover(ui.selected !== "current" || ui.guide); }, [ui.selected, ui.guide]);
  const [railCollapsed, setRailCollapsed] = useState(() => defaultStorage().getItem(RAIL_STORAGE_KEY) === "collapsed");
  useEffect(() => { defaultStorage().setItem(RAIL_STORAGE_KEY, railCollapsed ? "collapsed" : "expanded"); }, [railCollapsed]);
  const railToggleLabel = railCollapsed ? texts.railExpand : texts.railCollapse;
  const railLocked = ui.phase === "stopping" || !!ui.operation;
  const startupLabel = nativeStartupLabel(ui.phase, texts);
  const button = (target: string, label: string, glyph: React.ReactNode): ReactElement => (
    <HostRailButton
      key={target}
      layoutId={RAIL_LAYOUT_ID}
      label={label}
      current={ui.selected === target}
      currentValue="page"
      transitional={ui.pending === target}
      busy={ui.pending === target}
      disabled={railLocked}
      onSelect={() => controller.select(target)}
    >
      {glyph}
    </HostRailButton>
  );  return <div ref={anchor} className="dsh-host-dock dsh-ui" data-spaces-native="true" data-rail-collapsed={railCollapsed || undefined}>
    <button type="button" className="dsh-native-rail-toggle" aria-label={railToggleLabel} title={railToggleLabel} aria-expanded={!railCollapsed} onClick={() => setRailCollapsed(current => !current)}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
        <path d="M6 2.5v11" />
      </svg>
    </button>
    <HostRail label={texts.rail} layoutId={RAIL_LAYOUT_ID}>
      <HostRailButton
        layoutId={RAIL_LAYOUT_ID}
        label={texts.desktopMain}
        title={texts.desktopMainPinned}
        current={ui.selected === "current"}
        currentValue="page"
        pinned
        spaceId="desktop"
        onSelect={controller.showCurrent}
      >
        <SpaceGlyph spaceId="desktop" />
      </HostRailButton>
      <HostRailDivider />
      <HostRailList>
        {(() => { const creations = controller.visibleCreations(); const creatingIds = new Set(creations.map(c => c.spaceId));
          return <>
        {ui.inventory?.spaces.filter(s => s.id !== ui.inventory?.managerId && s.id !== "desktop" && !creatingIds.has(s.id)).map(s => (
          <HostRailButton
            key={s.id}
            layoutId={RAIL_LAYOUT_ID}
            label={`${s.displayName} · ${nativeStatusText(controller.spaceStatus(s.id), texts)}${ui.operation?.spaceId === s.id ? ` · ${texts.operating}` : ""}${s.attention === "required" ? ` · ${texts.attention}` : ""}`}
            current={ui.selected === s.id}
            currentValue="page"
            transitional={ui.pending === s.id}
            busy={ui.pending === s.id || ui.operation?.spaceId === s.id}
            disabled={!!ui.operation && ui.operation.spaceId !== s.id}
            status={controller.spaceStatus(s.id)}
            attention={s.attention}
            spaceId={s.id}
            onSelect={() => controller.select(s.id)}
            onContextMenu={event => { if (railLocked) return; event.preventDefault(); setMenu({ spaceId: s.id, x: event.clientX, y: event.clientY }); }}
            onKeyDown={event => {
              if (railLocked || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
              event.preventDefault(); const bounds = event.currentTarget.getBoundingClientRect();
              setMenu({ spaceId: s.id, x: bounds.right, y: bounds.top });
            }}
          >
            <SpaceGlyph spaceId={s.id} icon={s.icon} />
            <span className="dsh-native-space-status" data-status={controller.spaceStatus(s.id)} aria-hidden="true" />
          </HostRailButton>
        ))}
        {creations.map(creation => (
          <CreationRailEntry key={creation.jobId} creation={creation} layoutId={RAIL_LAYOUT_ID} onSelect={() => controller.openCreation(creation)} />
        ))}
        </>; })()}
        <HostRailButton
          layoutId={RAIL_LAYOUT_ID}
          label={texts.newSpace}
          title={texts.newSpace}
          disabled={railLocked}
          onSelect={controller.openCreate}
        >
          <span aria-hidden="true">＋</span>
        </HostRailButton>
      </HostRailList>
      {button("@settings", ui.phase === "service-stopped" ? texts.settingsStopped : ui.phase === "failed" ? texts.settingsUnavailable : texts.settings,
        <><span aria-hidden="true">⚙</span>{ui.phase === "failed" && <span className="dsh-native-service-error" aria-hidden="true">!</span>}</>)}
      {startupLabel && <p className="dsh-native-startup-status" role="status" aria-live="polite" aria-label={startupLabel} data-startup-phase={ui.phase}>{startupLabel}</p>}
    </HostRail>
    {menu && menuSpace && <NativeSpaceMenu space={menuSpace} x={menu.x} y={menu.y} busy={!!ui.operation || ui.phase !== "ready"}
      supportsSpaceActions={controller.supportsSpaceActions}
      onClose={closeMenu} onAction={action => { closeMenu(); void controller.spaceAction(menuSpace.id, action); }}
      onSettings={() => { closeMenu(); controller.openSpaceSettings(menuSpace.id); }} />}
    {ui.operationError && <div className="dsh-native-operation-error" role="alert">{ui.operationError}
      <button type="button" aria-label={texts.dismissOperationError} onClick={controller.dismissOperationError}>×</button></div>}
    <div ref={container} className="dsh-host-surface dsh-native-container" hidden={ui.selected === "current" || ui.guide} />
    {ui.guide && <Presence initial={false}>
      <motion.section
        key="dsh-native-guide"
        className="dsh-host-surface dsh-host-guide"
        aria-label={texts.guideLabel}
        initial={ui.error ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={ui.error ? { opacity: 1 } : { opacity: 0 }}
        transition={fade}
      >
        {ui.error
          ? <FadeIn as="p" appear={false} className="dsh-host-error" role="alert">{ui.error}</FadeIn>
          : <FadeIn as="p" className="dsh-host-guide-body">{nativeStartupLabel(ui.phase, texts)
            ?? (ui.phase === "stopping" ? texts.guideStopping
            : ui.phase === "service-stopped" ? texts.guideStopped
            : ui.phase === "loading" ? texts.guideLoading
            : texts.guideLoading)}</FadeIn>}
        {ui.detail ? <FadeIn as="p" appear={false} className="dsh-host-detail" data-reason="primary" aria-label={texts.failurePrimary}>{texts.failurePrimary}{"\n"}{ui.detail}</FadeIn> : null}
        {ui.failedAt ? <FadeIn as="p" appear={false} className="dsh-host-detail" data-reason="failed-at" aria-label={texts.failureTime.trimEnd()}>{texts.failureTime}{new Intl.DateTimeFormat(inferSpacesLocale() === "zh" ? "zh-CN" : "en", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(ui.failedAt))}</FadeIn> : null}
        {ui.cleanupDetail ? <FadeIn as="p" appear={false} className="dsh-host-detail" data-reason="cleanup" aria-label={texts.failureCleanup}>{texts.failureCleanup}{"\n"}{ui.cleanupDetail}</FadeIn> : null}
        {typeof ui.instanceRetained === "boolean" ? <FadeIn as="p" appear={false} className="dsh-host-detail" data-reason="instance" aria-label={texts.failureInstance}>{texts.failureInstance}{"\n"}{ui.instanceRetained ? texts.instanceRetainedYes : texts.instanceRetainedNo}</FadeIn> : null}
        {["failed", "service-stopped"].includes(ui.phase) && restart.action}
        <PressButton type="button" className="dsh-host-action" onClick={controller.showCurrent}>{texts.backToMain}</PressButton>
      </motion.section>
    </Presence>}
    {restart.dialog}
    {ui.spaceConfirmation && <NativeDialog label={texts.confirmInterruptLabel} onCancel={controller.cancelSpaceAction}>
      <h3>{(ui.spaceConfirmation.request.action === "stop" ? texts.stopTitle : texts.restartTitle).replace("{name}", ui.inventory?.spaces.find(row => row.id === ui.spaceConfirmation?.request.spaceId)?.displayName ?? ui.spaceConfirmation.request.spaceId)}</h3>
      <p>{ui.spaceConfirmation.activity === "busy" ? texts.confirmBusyBody : texts.confirmUnknownBody}{texts.confirmInterruptTail}</p>
      <div className="dsh-native-confirm-actions"><PressButton type="button" className="dsh-host-action" onClick={controller.cancelSpaceAction}>{texts.cancel}</PressButton>
        <PressButton type="button" className="dsh-host-action danger" onClick={controller.confirmSpaceAction}>{ui.spaceConfirmation.request.action === "stop" ? texts.stopSpace : texts.restartSpace}</PressButton></div>
    </NativeDialog>}
    {ui.creationFailed && <CreationFailureDialog creation={ui.creationFailed}
      onView={() => { controller.closeCreationFailed(); controller.select("@settings"); }}
      onDismiss={() => controller.dismissCreation(ui.creationFailed!.jobId)}
      onClose={controller.closeCreationFailed} />}
    {ui.notice && <div className="dsh-native-operation-notice" role="status">{ui.notice}</div>}
    {ui.pending && <HostLoadingPill label={texts.openingSpace} />}
    {ui.operation && <HostLoadingPill label={`${ui.operation.action === "stop" ? texts.stoppingSpace : ui.operation.action === "restart" ? texts.restartingSpace : texts.opening} ${ui.inventory?.spaces.find(s => s.id === ui.operation?.spaceId)?.displayName ?? ui.operation.spaceId}`} />}
  </div>;
}
