import React, { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { motion } from "motion/react";
import { FadeIn, Presence, fade } from "../../../../../src/shared/ui/motion";
import { SpaceGlyph } from "../../workbench/space-glyph";
import { HOME_DASHBOARD_SEALED } from "../../workbench/dashboard-sealed";
import { attachHostLayout } from "../host-layout";
import type { NativeHostController } from "./native-controller";
import { HostLoadingPill } from "./host-guide";
import { HostRail, HostRailButton, HostRailDivider, HostRailList } from "./host-rail";
import { PressButton } from "./press-button";
import { useServiceRestart } from "./service-restart";

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

export function NativeHostShell({ controller }: { controller: NativeHostController }): ReactElement {
  const [active, setActive] = useState(controller);
  return <NativeHostShellView controller={active} onRestarted={setActive} />;
}

function NativeHostShellView({ controller, onRestarted }: { controller: NativeHostController; onRestarted: (next: NativeHostController) => void }): ReactElement {
  const ui = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const restart = useServiceRestart(controller, onRestarted);
  const anchor = useRef<HTMLDivElement>(null), container = useRef<HTMLDivElement>(null), layout = useRef<ReturnType<typeof attachHostLayout> | null>(null);
  useEffect(() => {
    try { layout.current = attachHostLayout(anchor.current!); }
    catch { controller.stop(); return; }
    void controller.start(container.current!);
    return () => { controller.stop(); layout.current?.dispose(); };
  }, [controller]);
  useEffect(() => { layout.current?.cover(ui.selected !== "current" || ui.guide); }, [ui.selected, ui.guide]);
  const button = (target: string, label: string, glyph: React.ReactNode): ReactElement => (
    <HostRailButton
      key={target}
      layoutId={RAIL_LAYOUT_ID}
      label={label}
      current={ui.selected === target}
      currentValue="page"
      transitional={ui.pending === target}
      busy={ui.pending === target}
      disabled={ui.phase === "loading" || ui.phase === "launching"}
      onSelect={() => controller.select(target)}
    >
      {glyph}
    </HostRailButton>
  );  return <div ref={anchor} className="dsh-host-dock dsh-ui" data-spaces-native="true">
    <HostRail label="空间" layoutId={RAIL_LAYOUT_ID}>
      <HostRailButton
        layoutId={RAIL_LAYOUT_ID}
        label="Desktop · 默认空间"
        title="Desktop · 默认空间（始终置顶）"
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
        {ui.inventory?.spaces.filter(s => s.id !== ui.inventory?.managerId && s.id !== "desktop").map(s => (
          <HostRailButton
            key={s.id}
            layoutId={RAIL_LAYOUT_ID}
            label={s.displayName}
            current={ui.selected === s.id}
            currentValue="page"
            transitional={ui.pending === s.id}
            busy={ui.pending === s.id}
            status={s.status}
            onSelect={() => controller.select(s.id)}
          >
            <SpaceGlyph spaceId={s.id} icon={s.icon} />
          </HostRailButton>
        ))}
        <HostRailButton
          layoutId={RAIL_LAYOUT_ID}
          label="新建空间"
          title="新建空间"
          disabled={ui.phase === "loading" || ui.phase === "launching"}
          onSelect={controller.openCreate}
        >
          <span aria-hidden="true">＋</span>
        </HostRailButton>
      </HostRailList>
      {HOME_DASHBOARD_SEALED ? null : button("@dashboard", "看板", "▦")}
      {button("@settings", ui.phase === "failed" ? "设置 · 空间服务不可用（查看详情）" : "设置",
        <><span aria-hidden="true">⚙</span>{ui.phase === "failed" && <span className="dsh-native-service-error" aria-hidden="true">!</span>}</>)}
    </HostRail>
    <div ref={container} className="dsh-host-surface dsh-native-container" hidden={ui.selected === "current" || ui.guide} />
    {ui.guide && <Presence initial={false}>
      <motion.section
        key="dsh-native-guide"
        className="dsh-host-surface dsh-host-guide"
        aria-label="空间状态"
        initial={ui.error ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={ui.error ? { opacity: 1 } : { opacity: 0 }}
        transition={fade}
      >
        {ui.error
          ? <FadeIn as="p" appear={false} className="dsh-host-error" role="alert">{ui.error}</FadeIn>
          : <FadeIn as="p" className="dsh-host-guide-body">{ui.phase === "loading" ? "正在连接空间服务…"
            : ui.phase === "launching" ? "Spaces 管理服务没有在运行，正在随本次打开启动它…"
            : "初始化独立的 Spaces 管理服务后，即可在这里切换空间。"}</FadeIn>}
        {ui.detail ? <FadeIn as="p" appear={false} className="dsh-host-detail">{ui.detail}</FadeIn> : null}
        {ui.phase === "failed" && restart}
        {ui.phase === "initialize" && <PressButton type="button" className="dsh-host-action" onClick={() => void controller.initialize()}>初始化 Spaces</PressButton>}
        <PressButton type="button" className="dsh-host-action" onClick={controller.showCurrent}>当前应用</PressButton>
      </motion.section>
    </Presence>}
    {ui.pending && <HostLoadingPill label="正在打开空间" />}
    {ui.phase === "launching" && !ui.pending && <HostLoadingPill label="正在启动 Spaces 服务" />}
  </div>;
}
