import React, { useSyncExternalStore, type ReactElement } from "react";
import { FadeIn } from "../../../../../src/shared/ui/motion";
import type { HostShellController } from "../host-shell-state";
import { hostTexts } from "./host-texts";
import { PressButton } from "./press-button";

/**
 * The guide of the space dock.
 *
 * The guide states what the host confirmed and what it could not confirm. A
 * failure is rendered in its visible end state (`appear={false}`): an
 * entrance animation must never delay a real error.
 */

/** The guide panel of the portable host shell. */
export function HostShellPanel({ controller }: { controller: HostShellController }): ReactElement {
  const ui = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const t = hostTexts();
  return (
    <section className="dsh-host-guide" data-spaces-host-guide={ui.phase} data-dsh-spaces-guide={ui.phase}>
      <FadeIn as="h2" className="dsh-host-guide-title">
        {t.title}
      </FadeIn>
      {ui.error ? (
        <FadeIn
          as="p"
          appear={false}
          className="dsh-host-error"
          role="alert"
          data-dsh-spaces-error={ui.error}
        >
          {t[ui.error]}
        </FadeIn>
      ) : (
        <FadeIn as="p" className="dsh-host-guide-body">
          {ui.phase === "start"
            ? t.startBody
            : ui.phase === "loading" || ui.phase === "connecting"
              ? t.connecting
              : t.initBody}
        </FadeIn>
      )}
      {ui.detail && (
        <FadeIn as="p" appear={false} className="dsh-host-detail" data-dsh-spaces-detail="true">
          {ui.detail}
        </FadeIn>
      )}
      {ui.phase === "initialize" && (
        <PressButton
          type="button"
          className="dsh-host-action"
          data-dsh-spaces-action="initialize"
          onClick={() => void controller.initialize()}
        >
          {t.initialize}
        </PressButton>
      )}
      {ui.phase === "start" && (
        <PressButton
          type="button"
          className="dsh-host-action"
          data-dsh-spaces-action="initialize"
          onClick={() => void controller.initialize()}
        >
          {t.start}
        </PressButton>
      )}
      {ui.phase === "ready" && (
        <PressButton
          type="button"
          className="dsh-host-action"
          data-dsh-spaces-action="enter"
          onClick={() => controller.select(null)}
        >
          {t.manage}
        </PressButton>
      )}
      <PressButton type="button" className="dsh-host-action" onClick={controller.showCurrent}>
        {t.current}
      </PressButton>
    </section>
  );
}

/**
 * The loading notice of the space dock.
 *
 * It shows a shimmer while the dock waits for the space service; the notice
 * itself is announced immediately, the shimmer is decoration.
 */
export function HostLoadingPill({ label }: { label: string }): ReactElement {
  return (
    <div className="dsh-host-loading" role="status">
      <span className="dsh-host-loading-bar" aria-hidden="true" />
      <span className="dsh-host-loading-label">{label}</span>
    </div>
  );
}
