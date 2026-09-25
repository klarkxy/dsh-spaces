/** Register a bundled, static stylesheet for exactly one plugin lifetime.
 * Call from ctx.effect, never with provider/user supplied CSS. No timers,
 * stylesheet discovery, global replacement, or CSP relaxation is performed.
 */
export function mountStaticClientStyle(document: Document, packageId: string, name: string, css: string): () => void {
  const tag = document.createElement('style');
  tag.dataset.plugin = packageId;
  tag.dataset.pluginCss = `${packageId}/${name}`;
  tag.textContent = css;
  document.head.appendChild(tag);
  return () => { tag.remove(); };
}
