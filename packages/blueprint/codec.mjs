import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { MAX_JSON, MAX_SHARE, fail, parseJson } from './json.mjs';
export { MAX_JSON, MAX_SHARE, BlueprintError, fail, plain, forbidden, parseJson } from './json.mjs';

export function decode(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_SHARE) fail('size', 'Input exceeds 2 MiB.');
  // Scan the ends once: a suffix-search regexp can backtrack over interior whitespace.
  const whitespace = c => c === 32 || c === 9 || c === 13 || c === 10;
  let start = 0, end = text.length;
  while (start < end && whitespace(text.charCodeAt(start))) start++;
  while (end > start && whitespace(text.charCodeAt(end - 1))) end--;
  text = text.slice(start, end);
  const m = /^DSHBP2:([A-Za-z0-9_-]+)$/.exec(text);
  if (!m) fail('encoding', 'Unsupported blueprint code version or encoding.');
  let bytes = Buffer.from(m[1], 'base64url');
  if (bytes.toString('base64url') !== m[1]) fail('base64', 'Noncanonical Base64url.');
  let result;
  try { result = inflateRawSync(bytes, { maxOutputLength: MAX_JSON, info: true }); }
  catch { fail('deflate', 'Invalid or oversized raw DEFLATE payload.'); }
  if (result.engine.bytesWritten !== bytes.length) fail('deflate', 'Trailing DEFLATE data.');
  bytes = result.buffer;
  if (bytes.length > MAX_JSON) fail('size', 'Decoded JSON exceeds 1 MiB.');
  let json; try { json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('utf8', 'Invalid UTF-8.'); }
  return parseJson(json);
}
export function encode(value) {
  const json = JSON.stringify(value); parseJson(json);
  return `DSHBP2:${deflateRawSync(Buffer.from(json)).toString('base64url')}`;
}
