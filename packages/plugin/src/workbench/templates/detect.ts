/**
 * The kind of a file that the space template page accepts.
 *
 * The page takes two kinds of input: a share archive (`.dshspace`) and a
 * blueprint (a JSON document or a share code). The detection looks at the
 * content first and at the name second, and it never guesses: a file it does
 * not recognise is reported as unknown so the page can say so.
 */

/** What a dropped file turned out to be. */
export type TemplateFileKind = "share-archive" | "blueprint" | "unknown";

const SHARE_SUFFIX = ".dshspace";
const SHARE_CODE_PREFIXES = ["DSHBP1:", "DSHBP2:"];
const BLUEPRINT_KIND = "dsh-blueprint";
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function isZip(bytes: Uint8Array): boolean {
  if (bytes.length < ZIP_MAGIC.length) return false;
  return ZIP_MAGIC.every((byte, index) => bytes[index] === byte);
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function looksLikeBlueprintDocument(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  return (parsed as { kind?: unknown }).kind === BLUEPRINT_KIND;
}

/**
 * Detect the kind of a file.
 *
 * A zip container is a share archive, a share code or a blueprint document is a
 * blueprint, and everything else is unknown. The `.dshspace` suffix is only
 * trusted when the content is not readable as text, so a mislabelled file does
 * not reach the archive reader as a blueprint.
 */
export function detectTemplateFile(fileName: string, bytes: Uint8Array): TemplateFileKind {
  if (isZip(bytes)) return "share-archive";
  const text = decodeText(bytes);
  if (text !== null) {
    const trimmed = text.trim();
    if (SHARE_CODE_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return "blueprint";
    if (looksLikeBlueprintDocument(trimmed)) return "blueprint";
    if (!fileName.toLowerCase().endsWith(SHARE_SUFFIX)) return "unknown";
  }
  if (fileName.toLowerCase().endsWith(SHARE_SUFFIX)) return "share-archive";
  return "unknown";
}

/** A readable size for the file the user picked. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
