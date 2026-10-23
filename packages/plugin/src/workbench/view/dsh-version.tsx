/**
 * The DSH version section of one space.
 *
 * It lives in its own module because the space detail page and the settings
 * surface both show it: a space pins its own DSH version, and the pinned
 * version can only be switched with a preview.
 */

import React, { useState, type ReactElement } from "react";
import { gte as semverGte } from "semver";
import { SPACES_MIN_DSH_VERSION } from "../../../../../src/shared/runtime";
import { InlineErrors } from "../inline-error";
import { t } from "../i18n";
import type { WorkbenchController, WorkbenchUiState } from "../store";
import type { WorkbenchSpace } from "../../../../../src/shared/workbench";

export function DshVersionSection({
  ui,
  controller,
  space,
}: {
  ui: WorkbenchUiState;
  controller: WorkbenchController;
  space: WorkbenchSpace;
}): ReactElement {
  const locale = ui.locale;
  const pin = space.dshVersion;
  const host = ui.state?.dshVersion ?? null;
  const floor = pin && semverGte(pin, SPACES_MIN_DSH_VERSION) ? pin : SPACES_MIN_DSH_VERSION;
  const candidates = ui.runtimes
    .filter((runtime) => runtime.compatible && semverGte(runtime.version, floor))
    .map((runtime) => runtime.version);
  const versions = [
    ...new Set([...(pin && semverGte(pin, SPACES_MIN_DSH_VERSION) ? [pin] : []), ...candidates]),
  ];
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const target = selectedTarget && versions.includes(selectedTarget)
    ? selectedTarget
    : pin && versions.includes(pin)
      ? pin
      : host && versions.includes(host)
        ? host
        : (versions[0] ?? "");
  const ready = ui.runtimesStatus === "ready";
  const disabled = !controller.canMutate() || controller.isBusy() || !ready || !target;
  return (
    <section data-dsh-version="true">
      <h3>{t(locale, "detail.dshVersion")}</h3>
      <p>{pin ?? t(locale, "detail.dshNotPinned")}</p>
      {ui.runtimesStatus === "loading" ? <p role="status">{t(locale, "app.loading")}</p> : null}
      {ui.runtimesStatus === "error" ? (
        <p className="dsh-wb-alert" role="alert">{ui.readError.runtimes ?? t(locale, "app.genericError")}</p>
      ) : null}
      <InlineErrors ui={ui} origin={`detail:${space.id}:dsh`} />
      <label className="dsh-wb-field">
        {t(locale, "detail.dshTarget")}
        <select data-dsh-target="true" value={target} disabled={!ready} onChange={(event) => setSelectedTarget(event.target.value)}>
          {versions.map((version) => (
            <option key={version} value={version}>{version}</option>
          ))}
        </select>
      </label>
      <p className="dsh-wb-muted">{t(locale, "detail.dshHint")}</p>
      <button
        type="button"
        className="dsh-wb-btn"
        disabled={disabled}
        onClick={() => controller.preview({ kind: "space.runtime.set", spaceId: space.id, version: target })}
      >
        {t(locale, "detail.dshPreview")}
      </button>
    </section>
  );
}
