import { deflateRawSync, inflateRawSync } from "node:zlib";
import {
  BLUEPRINT_CODE,
  BLUEPRINT_JSON_MAX_BYTES,
  BLUEPRINT_SHARE_MAX_BYTES,
  BLUEPRINT_SHARE_PREFIX,
  BlueprintError,
  type Blueprint,
  type BlueprintEncodeMode,
  type BlueprintShareEncoding,
} from "../../shared/blueprint";
import { parseBlueprintJson } from "../../core/domain/blueprint";

export {
  BLUEPRINT_JSON_MAX_BYTES,
  BLUEPRINT_SHARE_MAX_BYTES,
  BLUEPRINT_SHARE_PREFIX,
  BlueprintError,
} from "../../shared/blueprint";
export type { Blueprint, BlueprintEncodeMode, BlueprintShareEncoding } from "../../shared/blueprint";

const SHARE_PREFIX = `${BLUEPRINT_SHARE_PREFIX}:`;
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;
const BASE64URL_TABLE = (() => {
  const table = new Uint8Array(256).fill(255);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (let index = 0; index < alphabet.length; index++) table[alphabet.charCodeAt(index)] = index;
  return table;
})();

export function stringifyBlueprint(blueprint: Blueprint): string {
  return JSON.stringify(blueprint);
}

export function encodeBlueprint(blueprint: Blueprint, encoding: BlueprintEncodeMode = "shortest"): string {
  const json = stringifyBlueprint(blueprint);
  if (encoding === "J") return encodeShare("J", json);
  if (encoding === "Z") return encodeShare("Z", json);
  const j = encodeShare("J", json);
  const z = encodeShare("Z", json);
  return j.length <= z.length ? j : z;
}

export function decodeBlueprint(text: string): Blueprint {
  if (typeof text !== "string") {
    throw new BlueprintError(BLUEPRINT_CODE.INVALID_SHARE, "share text must be a string");
  }
  const trimmed = trimShareText(text);
  if (utf8ByteLength(trimmed) > BLUEPRINT_SHARE_MAX_BYTES) {
    throw new BlueprintError(
      BLUEPRINT_CODE.SHARE_TOO_LARGE,
      `share code exceeds ${BLUEPRINT_SHARE_MAX_BYTES} bytes`,
    );
  }
  if (trimmed.startsWith(SHARE_PREFIX)) return parseBlueprintJson(decodeSharePayload(trimmed));
  return parseBlueprintJson(trimmed);
}

function decodeSharePayload(text: string): string {
  const rest = text.slice(SHARE_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) {
    throw new BlueprintError(BLUEPRINT_CODE.INVALID_SHARE, "share code is missing an encoding");
  }
  const encoding = rest.slice(0, separator);
  const payload = rest.slice(separator + 1);
  if (encoding !== "J" && encoding !== "Z") {
    throw new BlueprintError(BLUEPRINT_CODE.INVALID_SHARE, `unsupported share encoding ${encoding}`);
  }
  const bytes = decodeBase64url(payload);
  const jsonBytes = encoding === "J" ? bytes : inflateRawExclusive(bytes);
  if (jsonBytes.byteLength > BLUEPRINT_JSON_MAX_BYTES) {
    throw new BlueprintError(
      BLUEPRINT_CODE.JSON_TOO_LARGE,
      `JSON exceeds ${BLUEPRINT_JSON_MAX_BYTES} bytes`,
    );
  }
  if (jsonBytes.length >= 3 && jsonBytes[0] === 0xef && jsonBytes[1] === 0xbb && jsonBytes[2] === 0xbf) {
    throw new BlueprintError(BLUEPRINT_CODE.BOM, "JSON must be UTF-8 without a BOM");
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(jsonBytes);
    if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
      throw new BlueprintError(BLUEPRINT_CODE.BOM, "JSON must be UTF-8 without a BOM");
    }
    return text;
  } catch (error) {
    if (error instanceof BlueprintError) throw error;
    throw new BlueprintError(BLUEPRINT_CODE.UTF8, "share payload is not valid UTF-8");
  }
}

function encodeShare(encoding: BlueprintShareEncoding, json: string): string {
  const jsonBytes = Buffer.from(json, "utf8");
  if (jsonBytes.byteLength > BLUEPRINT_JSON_MAX_BYTES) {
    throw new BlueprintError(
      BLUEPRINT_CODE.JSON_TOO_LARGE,
      `JSON exceeds ${BLUEPRINT_JSON_MAX_BYTES} bytes`,
    );
  }
  const payload = encoding === "J" ? jsonBytes : deflateRawSync(jsonBytes);
  return `${BLUEPRINT_SHARE_PREFIX}:${encoding}:${encodeBase64url(payload)}`;
}

function inflateRawExclusive(input: Buffer): Buffer {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateRawSync(input, {
      maxOutputLength: BLUEPRINT_JSON_MAX_BYTES,
      info: true,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ERR_BUFFER_TOO_LARGE") {
      throw new BlueprintError(
        BLUEPRINT_CODE.JSON_TOO_LARGE,
        `decompressed JSON exceeds ${BLUEPRINT_JSON_MAX_BYTES} bytes`,
      );
    }
    throw new BlueprintError(
      BLUEPRINT_CODE.DEFLATE,
      "raw DEFLATE payload is truncated, concatenated, zlib/gzip wrapped, or invalid",
    );
  }
  if (!result?.buffer || result.engine.bytesWritten !== input.length) {
    throw new BlueprintError(
      BLUEPRINT_CODE.DEFLATE,
      "raw DEFLATE payload has trailing or concatenated stream data",
    );
  }
  return result.buffer;
}

function decodeBase64url(payload: string): Buffer {
  if (!BASE64URL_RE.test(payload) || payload.includes("=")) {
    throw new BlueprintError(BLUEPRINT_CODE.BASE64, "share payload must be unpadded base64url");
  }
  const remainder = payload.length % 4;
  if (remainder === 1) {
    throw new BlueprintError(BLUEPRINT_CODE.BASE64, "base64url length is invalid");
  }
  if (payload.length === 0) {
    throw new BlueprintError(BLUEPRINT_CODE.BASE64, "share payload is empty");
  }
  if (remainder === 2) {
    const last = BASE64URL_TABLE[payload.charCodeAt(payload.length - 1)]!;
    if (last === 255 || (last & 0x0f) !== 0) {
      throw new BlueprintError(BLUEPRINT_CODE.BASE64, "base64url leftover bits must be zero");
    }
  } else if (remainder === 3) {
    const last = BASE64URL_TABLE[payload.charCodeAt(payload.length - 1)]!;
    if (last === 255 || (last & 0x03) !== 0) {
      throw new BlueprintError(BLUEPRINT_CODE.BASE64, "base64url leftover bits must be zero");
    }
  }
  const padded = payload + "=".repeat((4 - remainder) % 4);
  const bytes = Buffer.from(padded.replaceAll("-", "+").replaceAll("_", "/"), "base64");
  if (encodeBase64url(bytes) !== payload) {
    throw new BlueprintError(BLUEPRINT_CODE.BASE64, "base64url encoding is not canonical");
  }
  return bytes;
}

function encodeBase64url(bytes: Buffer): string {
  return bytes.toString("base64url").replace(/=+$/, "");
}

function trimShareText(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isShareOuterWs(text.charCodeAt(start))) start += 1;
  while (end > start && isShareOuterWs(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

function isShareOuterWs(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0d || code === 0x0a;
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
