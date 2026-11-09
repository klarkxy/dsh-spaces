/**
 * Creation rail entries shared by the desktop and portable host rails.
 *
 * A queued or running create job renders a placeholder with a segmented
 * progress ring; a failed job seen while it was active renders red and opens
 * the failure dialog. Presentation only — nothing here submits a command.
 */

import React, { type ReactElement } from "react";
import { spaceCreateStep, type PortalCreation } from "../../../../../src/shared/space-host";
import { CreationRing } from "../../../../../src/shared/ui/creation-ring";
import { PressButton } from "../../../../../src/shared/ui/motion";
import { SpaceGlyph } from "../../workbench/space-glyph";
import { HostRailButton } from "./host-rail";
import { NativeDialog } from "./native-dialog";
import { nativeTexts } from "./native-texts";

/** Rail label and tooltip for one creation entry. */
export function creationRailLabel(creation: PortalCreation): string {
  const texts = nativeTexts();
  const fill = (template: string) => template.replace("{name}", creation.displayName);
  if (creation.status === "failed") return fill(texts.creationFailed).replace("{error}", creation.error ?? "");
  if (creation.status === "queued") return fill(texts.creationQueued);
  const step = spaceCreateStep(creation.phase);
  const stepName = creation.phase === "install" ? texts.creationStepInstall
    : [texts.creationStepPrepare, texts.creationStepConfig, texts.creationStepView, texts.creationStepModels][step.index] ?? "";
  return fill(texts.creationRunning)
    .replace("{n}", String(step.index + 1))
    .replace("{total}", String(step.total))
    .replace("{step}", stepName) + (creation.message ? ` — ${creation.message}` : "");
}

/** One creation placeholder in the rail. */
export function CreationRailEntry({
  creation,
  layoutId,
  onSelect,
}: {
  creation: PortalCreation;
  layoutId: string;
  onSelect: () => void;
}): ReactElement {
  const label = creationRailLabel(creation);
  const step = spaceCreateStep(creation.phase);
  return (
    <HostRailButton
      layoutId={layoutId}
      label={label}
      title={label}
      spaceId={creation.spaceId}
      onSelect={onSelect}
    >
      <SpaceGlyph spaceId={creation.spaceId} icon={creation.icon} />
      <CreationRing index={step.index} total={step.total} status={creation.status} />
      {creation.status === "failed" ? <span className="dsh-wb-creation-failed" aria-hidden="true">!</span> : null}
    </HostRailButton>
  );
}

/** The failed-creation dialog: reason, view-task and dismiss actions. */
export function CreationFailureDialog({
  creation,
  onView,
  onDismiss,
  onClose,
}: {
  creation: PortalCreation;
  onView: () => void;
  onDismiss: () => void;
  onClose: () => void;
}): ReactElement {
  const texts = nativeTexts();
  const title = texts.creationFailedTitle.replace("{name}", creation.displayName);
  return (
    <NativeDialog label={title} onCancel={onClose}>
      <h3>{title}</h3>
      <p>{creation.error}</p>
      <div className="dsh-native-confirm-actions">
        <PressButton type="button" className="dsh-host-action" onClick={onView}>{texts.creationViewTask}</PressButton>
        <PressButton type="button" className="dsh-host-action" onClick={onDismiss}>{texts.creationDismiss}</PressButton>
      </div>
    </NativeDialog>
  );
}
