// Adapted from dsh-spaces blueprint-codec.ts (MIT); see NOTICE.md.
export const MAX_JSON = 1024 * 1024;
export const MAX_SHARE = 2 * MAX_JSON;
export class BlueprintError extends Error {
  constructor(code, message) { super(message); this.name = 'BlueprintError'; this.code = code; }
}
export function fail(code, message) { throw new BlueprintError(code, message); }
export const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const forbidden = key => ['__proto__', 'prototype', 'constructor'].includes(key);

/** Strict JSON with duplicate-member, depth, Unicode and numeric checks. Never evaluates code. */
export function parseJson(text) {
  if (typeof text !== 'string') fail('json', 'Expected JSON text.');
  if (new TextEncoder().encode(text).byteLength > MAX_JSON) fail('size', 'JSON exceeds 1 MiB.');
  let i = 0;
  const error = () => fail('json', `Invalid JSON near offset ${i}.`);
  const ws = () => { while (/[ \t\r\n]/.test(text[i] ?? '\0')) i++; };
  function str() {
    const start = i++;
    while (i < text.length) {
      const c = text[i++];
      if (c === '\\') { i++; continue; }
      if (c === '"') {
        let s; try { s = JSON.parse(text.slice(start, i)); } catch { error(); }
        for (let n = 0; n < s.length; n++) {
          const u = s.charCodeAt(n);
          if (u >= 0xd800 && u <= 0xdbff) {
            const v = s.charCodeAt(++n);
            if (!(v >= 0xdc00 && v <= 0xdfff)) error();
          } else if (u >= 0xdc00 && u <= 0xdfff) error();
        }
        return s;
      }
    }
    error();
  }
  function value(depth) {
    ws();
    if (depth > 64 && (text[i] === '{' || text[i] === '[')) fail('depth', 'JSON exceeds 64 container levels.');
    const c = text[i];
    if (c === '"') return str();
    if (c === '{' || c === '[') {
      const array = c === '[', out = array ? [] : {}, keys = new Set();
      const end = array ? ']' : '}'; i++; ws();
      if (text[i] === end) { i++; return out; }
      while (i < text.length) {
        let key;
        if (!array) {
          ws(); if (text[i] !== '"') error(); key = str();
          if (keys.has(key)) fail('duplicate', 'Duplicate JSON object member.');
          if (forbidden(key)) fail('key', 'Unsafe object member.');
          keys.add(key); ws(); if (text[i++] !== ':') error();
        }
        const child = value(depth + 1);
        if (array) out.push(child); else out[key] = child;
        ws(); if (text[i] === end) { i++; return out; }
        if (text[i++] !== ',') error();
      }
      error();
    }
    for (const [token, v] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(token, i)) { i += token.length; return v; }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (!match) error(); i += match[0].length;
    const n = Number(match[0]);
    if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n))) fail('number', 'Unsafe JSON number.');
    return Object.is(n, -0) ? 0 : n;
  }
  const out = value(1); ws(); if (i !== text.length) error(); return out;
}
