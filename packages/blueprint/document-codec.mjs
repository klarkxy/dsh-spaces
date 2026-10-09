import { decode, encode } from './codec.mjs';
import { decodeBlueprint, encodeBlueprint } from './lib/v1/codec.js';
import { parseBlueprintJsonValue } from './lib/v1/domain.js';
import { parseBlueprintDocument } from './document.mjs';

export function decodeBlueprintDocument(text) {
  if (typeof text !== 'string') return decodeBlueprint(text);
  const trimmed = text.trim();
  if (trimmed.startsWith('DSHBP2:')) return parseBlueprintDocument(decode(text));
  if (trimmed.startsWith('DSHBP1:')) return decodeBlueprint(text);
  return parseBlueprintDocument(parseBlueprintJsonValue(text));
}

export function encodeBlueprintDocument(value, encoding = 'shortest') {
  const document = parseBlueprintDocument(value);
  return document.formatVersion === 2 ? encode(document) : encodeBlueprint(document, encoding);
}

export function stringifyBlueprintDocument(value) {
  return JSON.stringify(parseBlueprintDocument(value));
}
