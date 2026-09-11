import { t } from "./i18n";

/** Max size of a file chosen in the picker, before we downscale it. */
export const MAX_SPACE_ICON_FILE_BYTES = 2 * 1024 * 1024;

/** Max size of the stored data URL (processed PNG/SVG). */
export const MAX_SPACE_ICON_DATA_URL_CHARS = 240_000;

export const MAX_SPACE_ICON_SVG_BYTES = 64 * 1024;

export const SPACE_ICON_SIZE = 128;

const DATA_URL_RE =
  /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/i;

export function isUploadedSpaceIcon(icon?: string): boolean {
  return Boolean(icon?.startsWith("data:image/"));
}

export function sanitizeSpaceIcon(icon: string | undefined): string {
  const value = icon?.trim() ?? "";
  if (!value) return "";
  if (isUploadedSpaceIcon(value)) {
    assertValidSpaceIcon(value);
    return value;
  }
  return "";
}

export function assertValidSpaceIcon(icon: string): void {
  if (icon.length > MAX_SPACE_ICON_DATA_URL_CHARS) {
    throw new Error(t("errors.iconTooLarge"));
  }
  const match = DATA_URL_RE.exec(icon);
  if (!match) throw new Error(t("errors.iconInvalid"));
  let bytes: Buffer;
  try {
    bytes = Buffer.from(match[2], "base64");
  } catch {
    throw new Error(t("errors.iconInvalid"));
  }
  if (bytes.length === 0) throw new Error(t("errors.iconInvalid"));
  if (match[1].toLowerCase() === "svg+xml") {
    if (bytes.length > MAX_SPACE_ICON_SVG_BYTES) throw new Error(t("errors.iconTooLarge"));
    const text = bytes.toString("utf8");
    if (!/<svg[\s>]/i.test(text) || /<script|javascript:|on\w+\s*=/i.test(text)) {
      throw new Error(t("errors.iconInvalid"));
    }
  }
}

export function toSpaceIconDataUrl(mime: "png" | "svg+xml", bytes: Buffer): string {
  const url = `data:image/${mime};base64,${bytes.toString("base64")}`;
  assertValidSpaceIcon(url);
  return url;
}
