/**
 * The stage: space frames, the idle card and the chrome banners.
 *
 * The frames themselves are never animated: a transform or a filter on an
 * element that holds an iframe would move the space surface. Only the
 * siblings around them move.
 */

import React, { useRef, type ReactElement } from "react";
import type { WorkbenchSpace } from "../../../../../src/shared/workbench";
import { VisibleScale } from "../../../../../src/shared/ui/motion";
import { t, type WorkbenchLocale } from "../i18n";
import type { ViewFrameState } from "../view-session";
import { CopyButton, type WorkbenchViewProps } from "./shared";

export function WorkspaceFrames({ ui, controller }: WorkbenchViewProps): ReactElement {
  const locale = ui.locale;
  return (
    <div className="dsh-wb-frames" data-frames="true">
      {ui.frames.map((item) =>
        item.src ? (
          <WorkspaceFrame
            key={`${item.spaceId}:${item.generation}`}
            frame={item}
            visible={controller.views.isVisible(item.spaceId)}
            title={controller.space(item.spaceId)?.displayName ?? t(locale, "iframe.title")}
            onWindow={(win) => controller.registerIframeWindow(item.spaceId, item.generation, win)}
          />
        ) : null,
      )}
    </div>
  );
}

export function WorkspaceChrome({ ui, controller }: WorkbenchViewProps): ReactElement | null {
  const locale = ui.locale;
  const space = ui.selected === "home" ? undefined : controller.space(ui.selected);
  const pendingId = ui.pendingId;
  const pendingFrame = pendingId ? ui.frames.find((item) => item.spaceId === pendingId) : null;
  const showIdle = Boolean(space && space.status !== "running");
  if (!showIdle && !pendingFrame && !ui.viewError) return null;
  return (
    <>
      {showIdle && space && (
        <IdleCard locale={locale} space={space} writable={controller.canMutate()} controller={controller} />
      )}
      {pendingFrame?.status === "loading" && (
        <div className="dsh-wb-banner" role="status">
          {t(locale, "app.viewLoading")}
        </div>
      )}
      {pendingFrame?.status === "pending" && ui.visibleSpaceId !== pendingId && (
        <div className="dsh-wb-banner" role="status">
          {t(locale, "app.viewPending")}
        </div>
      )}
      {ui.viewError && (
        <div className="dsh-wb-banner" role="alert">
          <span>{t(locale, "app.viewFailed")}</span>
          <button type="button" className="dsh-wb-btn" onClick={() => controller.openDetail(ui.viewError!.spaceId)}>
            {t(locale, "app.errorDetails")}
          </button>
          <CopyButton
            locale={locale}
            className="dsh-wb-btn"
            text={() => ui.viewError?.message ?? t(locale, "app.viewFailed")}
            label={t(locale, "app.copyError")}
          />
          <button type="button" className="dsh-wb-btn" onClick={() => controller.openIndependent(ui.viewError!.spaceId)}>
            {t(locale, "app.openIndependent")}
          </button>
        </div>
      )}
    </>
  );
}

function WorkspaceFrame({
  frame,
  visible,
  title,
  onWindow,
}: {
  frame: ViewFrameState;
  visible: boolean;
  title: string;
  onWindow: (win: unknown) => void;
}): ReactElement {
  const ref = useRef<HTMLIFrameElement>(null);
  const bind = (): void => {
    onWindow(ref.current?.contentWindow ?? null);
  };
  return (
    <iframe
      ref={(element) => {
        ref.current = element;
        onWindow(element?.contentWindow ?? null);
      }}
      className="dsh-wb-frame"
      title={title}
      src={frame.src ?? undefined}
      data-space-id={frame.spaceId}
      data-generation={String(frame.generation)}
      data-visible={visible ? "true" : "false"}
      hidden={!visible}
      allow={frame.view ? `clipboard-write ${frame.view.origin}` : undefined}
      referrerPolicy="no-referrer"
      onLoad={bind}
    />
  );
}

/**
 * The idle card.
 *
 * A crashed space shows its failure reason, so that card is rendered in its
 * visible end state instead of fading in.
 */
function IdleCard({
  locale,
  space,
  writable,
  controller,
}: {
  locale: WorkbenchLocale;
  space: WorkbenchSpace;
  writable: boolean;
  controller: WorkbenchViewProps["controller"];
}): ReactElement {
  const titleKey =
    space.status === "starting"
      ? "app.startingTitle"
      : space.status === "crashed"
        ? "app.crashedTitle"
        : "app.idleTitle";
  const crashed = space.status === "crashed";
  return (
    <div className="dsh-wb-idle">
      <VisibleScale className="dsh-wb-dialog">
        <h2 className="dsh-wb-title">{t(locale, titleKey, { name: space.displayName })}</h2>
        {crashed ? <p className="dsh-wb-muted">{t(locale, "app.crashedBody")}</p> : null}
        {!space.managed && <p className="dsh-wb-notice">{t(locale, "app.unmanaged")}</p>}
        <div className="dsh-wb-actions">
          <button
            type="button"
            className="dsh-wb-btn primary"
            disabled={!writable || !space.managed || space.status === "starting" || space.status === "stopping"}
            onClick={() => controller.startSpace(space.id)}
          >
            {t(locale, "app.start")}
          </button>
          {crashed ? (
            <button type="button" className="dsh-wb-btn" onClick={() => controller.openDetail(space.id)}>
              {t(locale, "app.errorDetails")}
            </button>
          ) : null}
          <button type="button" className="dsh-wb-btn" onClick={() => controller.openRename(space.id)} disabled={!writable}>
            {t(locale, "app.rename")}
          </button>
          <button
            type="button"
            className="dsh-wb-btn danger"
            disabled={!writable || controller.isManagerId(space.id)}
            onClick={() => controller.preview({ kind: "space.delete", spaceId: space.id, removeData: false })}
          >
            {t(locale, "app.delete")}
          </button>
        </div>
      </VisibleScale>
    </div>
  );
}
