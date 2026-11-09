/// <reference lib="dom" />
/**
 * Credential-safe helpers shared by the UI-automation manager, its engine
 * adapter and tests. Everything that leaves the Supervisor (DTO fields,
 * error messages) goes through these helpers: page URLs collapse to the
 * relative path + query, and every injected credential value is replaced
 * by a fixed marker wherever it appears.
 */

/**
 * Collapse a page URL to its relative path + query (+ fragment). Anything
 * that is not an http(s) URL on the expected loopback origin yields the
 * path component only — the origin and port are never serialized. A URL
 * that cannot be parsed at all returns "/" so DTOs stay well formed.
 */
export function relativePagePath(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.pathname}${url.search}${url.hash}` || "/";
  } catch {
    return "/";
  }
}

/**
 * Remove credential material from text leaving the Supervisor. Each
 * provided secret (cookie value, launch token) is replaced by a fixed
 * marker; the secret itself is never echoed, including inside this
 * function's return value. Secrets under 8 chars are skipped (they cannot
 * be real session material and would over-redact).
 */
export function redactCredentials(value: string, secrets: readonly string[]): string {
  // Coerce defensively: a mis-typed engine result must not crash the error
  // path and mask the real failure.
  let out = String(value ?? "");
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

/** Truncate to a UTF-8 byte cap without splitting a multi-byte sequence. */
export function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxBytes) return { text: value, truncated: false };
  // Cutting at maxBytes can split a sequence: back off past every
  // continuation byte at the boundary so the last character is whole.
  const raw = Buffer.from(value, "utf8");
  let cut = maxBytes;
  while (cut > 0 && (raw[cut] & 0xc0) === 0x80) cut -= 1;
  const text = raw.subarray(0, cut).toString("utf8");
  return { text, truncated: true };
}

/**
 * Attribute payload threshold, bytes. Passed into the page explicitly.
 */
export const SANITIZE_ATTR_PAYLOAD_MIN = 512;

const DATA_URI_RE = /(?:^|[\s,])(?:data:|blob:)/i;
const BASE64_BLOB_RE = /^[A-Za-z0-9+/=_-]+$/;

/**
 * Node-side mirror of the rule SANITIZE_OUTER_HTML_SOURCE applies. One
 * attribute rule: oversized inline payloads are replaced by "[stripped]".
 * Two shapes count once the value exceeds the threshold: a `data:`/`blob:`
 * URI anywhere in the value (covers src, href and srcset entries), or a pure
 * base64-looking blob with no scheme — e.g. a `data-*` attribute smuggling
 * an encoded image. Ordinary values (class lists, aria labels, http links,
 * spaced JSON) are kept; the attribute name and document structure always
 * survive.
 */
export function sanitizeAttributeValue(
  name: string,
  value: string,
  min = SANITIZE_ATTR_PAYLOAD_MIN,
): string {
  if (value.length <= min) return value;
  if (DATA_URI_RE.test(value) || BASE64_BLOB_RE.test(value)) return "[stripped]";
  return value;
}

/**
 * In-page sanitizer as verbatim source text — NOT a function reference.
 * Playwright evaluates this exact string inside the page, so nothing in it
 * may rely on transpiler helpers (`__name`), imports or closures; the
 * payload threshold arrives as `payloadMin`. Passed to locator.evaluate:
 * signature is `(el, payloadMin) => string`, called with the element and the
 * SANITIZE_ATTR_PAYLOAD_MIN argument. Keep it identical in intent to
 * sanitizeAttributeValue above.
 */
export const SANITIZE_OUTER_HTML_SOURCE = String.raw`(el, payloadMin) => {
  const min = typeof payloadMin === "number" ? payloadMin : 512;
  const dataUri = /(?:^|[\s,])(?:data:|blob:)/i;
  const base64Blob = /^[A-Za-z0-9+/=_-]+$/;
  const clean = (value) =>
    typeof value === "string" && value.length > min && (dataUri.test(value) || base64Blob.test(value))
      ? "[stripped]" : value;
  const clone = el.cloneNode(true);
  for (const node of clone.querySelectorAll("script,style,noscript,template")) {
    node.textContent = "";
  }
  for (const node of [clone, ...clone.querySelectorAll("*")]) {
    if (node.hasAttribute("style")) node.removeAttribute("style");
    for (const attr of [...node.attributes]) {
      const cleaned = clean(attr.value);
      if (cleaned !== attr.value) node.setAttribute(attr.name, cleaned);
    }
  }
  return clone.outerHTML;
}`;

/**
 * In-page eval wrapper for a ref-scoped script: verbatim source. Called
 * with (element, scriptBody); the model script is function-body text run
 * with `element` bound.
 */
export const EVAL_ON_ELEMENT_SOURCE = String.raw`(el, script) => {
  const fn = new Function("element", script);
  return fn(el);
}`;

/**
 * In-page eval wrapper for a page-scope script: verbatim source. Called
 * with (script) where script is function-body text.
 */
export const EVAL_ON_PAGE_SOURCE = String.raw`(script) => {
  const fn = new Function(script);
  return fn();
}`;

/**
 * In-page scroll helper: verbatim source. Called with (el, deltaY).
 */
export const SCROLL_BY_SOURCE = String.raw`(el, deltaY) => el.scrollBy(0, deltaY)`;

/**
 * Build a page-callable function from a verbatim source constant. The
 * factory runs in Node: the returned function's `toString()` is exactly
 * `source`, so Playwright serializes it into the page with no transpiler
 * helpers (`__name`) and no module-scope captures.
 *
 * Do NOT pass the source strings themselves to evaluate: Playwright treats
 * a string as an *expression* — a function-literal expression evaluates to
 * the function object, which is never invoked and never receives arguments.
 */
export function pageFunction<A extends unknown[], R>(source: string): (...args: A) => R {
  return new Function(`return (${source});`)() as (...args: A) => R;
}
