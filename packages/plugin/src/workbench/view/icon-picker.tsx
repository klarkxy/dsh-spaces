/**
 * The space icon picker.
 *
 * It offers the avatar library, the known glyphs and a local image upload.
 * The picker reports the pending and failed states of an upload so that the
 * form around it can refuse to submit while an image is still being read.
 */

import React, { useRef, useState, type ReactElement } from "react";
import { SPACE_AVATARS, defaultSpaceAvatar } from "../../../../../src/shared/space-avatars";
import { readLocalIcon } from "../fit-icon";
import { isDataImageIcon, KNOWN_GLYPHS } from "../icons";
import { t, type WorkbenchLocale } from "../i18n";
import { SpaceGlyph } from "../space-glyph";

export type IconPickState = "idle" | "pending" | "failed";

export function IconPicker({
  locale,
  value,
  spaceId = "",
  onChange,
  onState,
}: {
  locale: WorkbenchLocale;
  value?: string;
  spaceId?: string;
  onChange: (icon: string) => void;
  onState?: (state: IconPickState) => void;
}): ReactElement {
  const [preview, setPreview] = useState(value ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  const publish = (icon: string): void => {
    request.current += 1;
    setPending(false);
    setError(null);
    setPreview(icon);
    onStateRef.current?.("idle");
    onChange(icon);
  };

  const acceptFile = (file: File): void => {
    const id = ++request.current;
    setPending(true);
    setError(null);
    onStateRef.current?.("pending");
    void readLocalIcon(file).then((result) => {
      if (id !== request.current) return;
      setPending(false);
      if (!result.ok) {
        setError(t(locale, result.reason === "too-large" ? "app.iconTooLarge" : "app.iconInvalid"));
        onStateRef.current?.("failed");
        return;
      }
      setPreview(result.icon);
      setError(null);
      onStateRef.current?.("idle");
      onChange(result.icon);
    }).catch(() => {
      if (id !== request.current) return;
      setPending(false);
      setError(t(locale, "app.iconInvalid"));
      onStateRef.current?.("failed");
    });
  };

  return (
    <div className="dsh-wb-icon-picker" data-icon-picker="true">
      <p>{t(locale, "create.avatars")}</p>
      <div className="dsh-wb-glyphs dsh-wb-avatars" role="group" aria-label={t(locale, "create.avatars")}>
        {SPACE_AVATARS.map(avatar => <button key={avatar.id} type="button" className="dsh-wb-rail-btn"
          title={avatar[locale]} aria-label={avatar[locale]}
          aria-pressed={(preview && preview !== "whale" ? preview : defaultSpaceAvatar(spaceId).image) === avatar.image}
          onClick={() => publish(avatar.image)}><SpaceGlyph icon={avatar.image} /></button>)}
      </div>
      <p>{t(locale, "create.glyph")}</p>
      <div className="dsh-wb-glyphs" role="group" aria-label={t(locale, "create.icon")}>
        {KNOWN_GLYPHS.filter(glyph => glyph !== "whale").map((glyph) => (
          <button
            key={glyph}
            type="button"
            className="dsh-wb-rail-btn"
            aria-pressed={!isDataImageIcon(preview) && (preview || "whale") === glyph}
            aria-label={t(locale, `icon.${glyph}` as const)}
            onClick={() => publish(glyph)}
          >
            <SpaceGlyph icon={glyph} />
          </button>
        ))}
      </div>
      <label className="dsh-wb-field">
        {t(locale, "create.upload")}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          disabled={pending}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = "";
            if (file) acceptFile(file);
          }}
        />
      </label>
      {pending ? <p role="status">{t(locale, "create.iconShrinking")}</p> : null}
      {error ? <p className="dsh-wb-alert" role="alert">{error}</p> : null}
      {isDataImageIcon(preview) ? (
        <span className="dsh-wb-icon-preview">
          <img className="dsh-wb-glyph-img" src={preview} alt="" draggable={false} />
        </span>
      ) : null}
      <button type="button" className="dsh-wb-btn" onClick={() => publish("")}>
        {t(locale, "icon.default")}
      </button>
    </div>
  );
}
