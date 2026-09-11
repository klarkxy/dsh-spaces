import { BrowserWindow, dialog, nativeImage, type WebContents } from "electron";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { t } from "../shared/i18n";
import {
  MAX_SPACE_ICON_FILE_BYTES,
  MAX_SPACE_ICON_SVG_BYTES,
  SPACE_ICON_SIZE,
  toSpaceIconDataUrl,
} from "../shared/space-icon";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "svg"] as const;

export async function pickSpaceIcon(sender: WebContents): Promise<string | null> {
  const options = {
    title: t("icon.choose"),
    properties: ["openFile"] as Array<"openFile">,
    filters: [{ name: t("icon.images"), extensions: [...IMAGE_EXTENSIONS] }],
  };
  const win = BrowserWindow.fromWebContents(sender);
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  const file = result.filePaths[0];
  if (result.canceled || !file) return null;
  return encodeSpaceIconFile(file);
}

export function encodeSpaceIconFile(file: string): string {
  const size = statSync(file).size;
  if (size <= 0) throw new Error(t("errors.iconInvalid"));
  if (size > MAX_SPACE_ICON_FILE_BYTES) throw new Error(t("errors.iconTooLarge"));
  if (extname(file).toLowerCase() === ".svg") {
    const bytes = readFileSync(file);
    if (bytes.length > MAX_SPACE_ICON_SVG_BYTES) throw new Error(t("errors.iconTooLarge"));
    return toSpaceIconDataUrl("svg+xml", bytes);
  }
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) throw new Error(t("errors.iconUnreadable"));
  const { width, height } = image.getSize();
  const maxSide = Math.max(width, height);
  const scaled =
    maxSide > SPACE_ICON_SIZE
      ? image.resize({
          width: Math.max(1, Math.round((width * SPACE_ICON_SIZE) / maxSide)),
          height: Math.max(1, Math.round((height * SPACE_ICON_SIZE) / maxSide)),
          quality: "best",
        })
      : image;
  const png = scaled.toPNG();
  if (!png.length) throw new Error(t("errors.iconUnreadable"));
  return toSpaceIconDataUrl("png", png);
}
