/**
 * The drop zone of the import section.
 *
 * The zone is the visible target of a drag and a drop; the file picker is a
 * native input that stays in the accessibility tree, so the same action is
 * reachable with the keyboard and with a screen reader.
 */
import React, { useRef, useState, type DragEvent, type ReactElement } from "react";
import { t, type WorkbenchLocale } from "../i18n";
import { PressableButton } from "../feature-motion";

export function TemplateDropZone({
  locale,
  onFile,
}: {
  locale: WorkbenchLocale;
  onFile: (file: File) => void;
}): ReactElement {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      className="dsh-wb-dropzone"
      data-templates-dropzone="true"
      data-drag-over={dragging ? "true" : undefined}
      onDragOver={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files?.[0];
        if (file) onFile(file);
      }}
    >
      <p className="dsh-wb-dropzone-title">{t(locale, "templates.drop.title")}</p>
      <p className="dsh-wb-muted">{t(locale, "templates.drop.hint")}</p>
      <PressableButton
        as="button"
        type="button"
        className="dsh-wb-btn"
        onClick={() => inputRef.current?.click()}
      >
        {t(locale, "templates.drop.choose")}
      </PressableButton>
      <input
        ref={inputRef}
        className="dsh-wb-visually-hidden"
        type="file"
        accept=".dshspace,.json,.txt,application/zip,application/json,text/plain"
        aria-label={t(locale, "templates.drop.choose")}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onFile(file);
        }}
      />
    </div>
  );
}
