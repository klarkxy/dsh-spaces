/** Shrink a local icon until it passes the stored data-URL limit. */

import { MAX_ICON_DATA_URL_CHARS, MAX_ICON_SVG_BYTES, validateWorkbenchIcon } from "./icons";

/** Files larger than this are refused before decode. Shrunk icons stay under the data-URL cap. */
export const MAX_ICON_SOURCE_BYTES = 32 * 1024 * 1024;

const EDGES = [256, 192, 128, 96, 64, 48];
const JPEG_QUALITIES = [0.85, 0.6, 0.4];
const SVG_UNSAFE = /<script|javascript:|on\w+\s*=/i;

export type IconFitFailure = "invalid" | "too-large";
export type IconFitResult = { ok: true; icon: string } | { ok: false; reason: IconFitFailure };

export type IconShrinkStep = {
  width: number;
  height: number;
  type: "image/png" | "image/jpeg";
  quality: number;
};

export function iconShrinkSteps(sourceWidth: number, sourceHeight: number): IconShrinkStep[] {
  const width = Math.max(1, Math.round(sourceWidth));
  const height = Math.max(1, Math.round(sourceHeight));
  const longest = Math.max(width, height);
  const edges: number[] = [];
  for (const edge of EDGES) {
    const target = Math.min(edge, longest);
    if (!edges.includes(target)) edges.push(target);
  }
  const steps: IconShrinkStep[] = [];
  for (const edge of edges) {
    const scale = edge / longest;
    const stepWidth = Math.max(1, Math.round(width * scale));
    const stepHeight = Math.max(1, Math.round(height * scale));
    steps.push({ width: stepWidth, height: stepHeight, type: "image/png", quality: 0.92 });
    for (const quality of JPEG_QUALITIES) {
      steps.push({ width: stepWidth, height: stepHeight, type: "image/jpeg", quality });
    }
  }
  return steps;
}

/** Returns the first encoding that passes icon validation. */
export function fitEncodedIcon(
  sourceWidth: number,
  sourceHeight: number,
  encode: (step: IconShrinkStep) => string,
): string | null {
  for (const step of iconShrinkSteps(sourceWidth, sourceHeight)) {
    let url = "";
    try {
      url = encode(step);
    } catch {
      continue;
    }
    if (validateWorkbenchIcon(url).ok) return url;
  }
  return null;
}

/** Small safe SVG stays a data URL. Oversized safe SVG asks the caller to rasterize. */
export function svgIconDataUrl(text: string): IconFitResult | { ok: false; reason: "rasterize" } {
  const value = text.replace(/^\uFEFF/, "").trim();
  if (!/<svg[\s>]/i.test(value) || SVG_UNSAFE.test(value)) return { ok: false, reason: "invalid" };
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > MAX_ICON_SVG_BYTES) return { ok: false, reason: "rasterize" };
  const icon = `data:image/svg+xml;base64,${bytesToBase64(bytes)}`;
  const validated = validateWorkbenchIcon(icon);
  if (!validated.ok) return { ok: false, reason: validated.reason === "too-large" ? "rasterize" : "invalid" };
  return { ok: true, icon: validated.icon };
}

export async function readLocalIcon(file: File): Promise<IconFitResult> {
  const kind = iconFileKind(file);
  if (!kind) return { ok: false, reason: "invalid" };
  if (file.size > MAX_ICON_SOURCE_BYTES) return { ok: false, reason: "too-large" };

  if (kind === "svg") {
    let text = "";
    try {
      text = await file.text();
    } catch {
      return { ok: false, reason: "invalid" };
    }
    const svg = svgIconDataUrl(text);
    if (svg.ok || svg.reason === "invalid") return svg;
  } else if (storedDataUrlFits(file.size)) {
    try {
      const dataUrl = await readAsDataUrl(file);
      const validated = validateWorkbenchIcon(dataUrl);
      if (validated.ok) return { ok: true, icon: validated.icon };
    } catch {
      // The bytes may still decode as a bitmap below.
    }
  }

  try {
    const decoded = await decodeIcon(file);
    try {
      if (decoded.width < 1 || decoded.height < 1) return { ok: false, reason: "invalid" };
      const icon = fitEncodedIcon(decoded.width, decoded.height, (step) => drawIcon(decoded.source, step));
      if (!icon) return { ok: false, reason: "too-large" };
      return { ok: true, icon };
    } finally {
      decoded.close();
    }
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

function iconFileKind(file: File): "svg" | "raster" | null {
  const type = file.type.toLowerCase();
  if (type === "image/svg+xml") return "svg";
  if (type === "image/png" || type === "image/jpeg" || type === "image/jpg" || type === "image/webp" || type === "image/gif") {
    return "raster";
  }
  const name = file.name.toLowerCase();
  if (name.endsWith(".svg")) return "svg";
  if (/\.(png|jpe?g|webp|gif)$/.test(name)) return "raster";
  return null;
}

function storedDataUrlFits(byteLength: number): boolean {
  const prefix = 64;
  return 4 * Math.ceil(byteLength / 3) + prefix <= MAX_ICON_DATA_URL_CHARS;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("icon read failed"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("icon read failed"));
    reader.readAsDataURL(file);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("icon decode failed"));
    image.src = url;
  });
}

async function decodeIcon(file: Blob): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Some SVG files decode through an image element instead.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function drawIcon(source: CanvasImageSource, step: IconShrinkStep): string {
  const canvas = document.createElement("canvas");
  canvas.width = step.width;
  canvas.height = step.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, step.width, step.height);
  return canvas.toDataURL(step.type, step.quality);
}
