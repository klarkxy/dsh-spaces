import React, { useState, type FormEvent, type ReactElement } from "react";
import { motion } from "motion/react";
import type { SpacesCapabilities } from "../../../../../src/shared/spaces-control";
import { spring } from "../../../../../src/shared/ui/motion";
import { localizeSafeText, t, type SpacesLocale } from "../i18n";
import { modeLabel } from "./labels";

/**
 * The creation form and the capability card of the Spaces panel.
 *
 * Both are pure views: the form owns its own input state and reports a
 * trimmed submission, the capability card only states what the host confirmed.
 */

/** Props of the capability card. */
export function Capabilities({
  locale,
  capabilities,
}: {
  locale: SpacesLocale;
  capabilities: SpacesCapabilities;
}): ReactElement {
  return (
    <div className="dsh-spaces-capabilities" aria-label={t(locale, "capabilities.label")}>
      <div className="dsh-spaces-mode">
        <strong>{modeLabel(locale, capabilities.mode)}</strong>
        {capabilities.dshVersion && (
          <span className="dsh-spaces-version">DSH {capabilities.dshVersion}</span>
        )}
      </div>
      {capabilities.reasons.length > 0 && (
        <ul className="dsh-spaces-reasons" aria-label={t(locale, "capabilities.reasons")}>
          {capabilities.reasons.map((reason) => (
            <li key={reason}>{localizeSafeText(locale, reason)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Props of the creation form. */
export interface CreateFormProps {
  locale: SpacesLocale;
  capabilities: SpacesCapabilities | null;
  pending: boolean;
  error: string | null;
  onCreate: (input: { name: string; displayName?: string }) => void;
}

export function CreateForm({
  locale,
  capabilities,
  pending,
  error,
  onCreate,
}: CreateFormProps): ReactElement {
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const allowed = capabilities?.canCreate === true;
  const canSubmit = allowed && !pending && name.trim().length > 0;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!canSubmit) return;
    const trimmedDisplay = displayName.trim();
    onCreate({ name: name.trim(), ...(trimmedDisplay ? { displayName: trimmedDisplay } : {}) });
    setName("");
    setDisplayName("");
  };
  return (
    <form className="dsh-spaces-form" aria-label={t(locale, "create.form")} onSubmit={submit}>
      <h3 className="dsh-spaces-section-title">{t(locale, "create.title")}</h3>
      <label className="dsh-spaces-field">
        {t(locale, "create.name")}
        <input
          type="text"
          name="dsh-spaces-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={!allowed || pending}
          required
          autoComplete="off"
        />
      </label>
      <label className="dsh-spaces-field">
        {t(locale, "create.displayName")}
        <input
          type="text"
          name="dsh-spaces-display-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          disabled={!allowed || pending}
          autoComplete="off"
        />
      </label>
      {!allowed && <p className="dsh-spaces-muted">{t(locale, "create.denied")}</p>}
      {error && (
        <p className="dsh-spaces-alert" role="alert">
          {localizeSafeText(locale, error)}
        </p>
      )}
      <motion.button
        type="submit"
        className="dsh-spaces-submit"
        disabled={!canSubmit}
        aria-busy={pending || undefined}
        whileHover={canSubmit ? { scale: 1.03 } : undefined}
        whileTap={canSubmit ? { scale: 0.97 } : undefined}
        transition={spring}
      >
        {pending ? t(locale, "create.pending") : t(locale, "create.submit")}
      </motion.button>
    </form>
  );
}
