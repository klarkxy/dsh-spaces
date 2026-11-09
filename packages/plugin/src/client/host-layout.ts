/** One instance owns only its additive layout reservation. It never remounts the host React tree. */
export function attachHostLayout(anchor: HTMLElement): { cover(active: boolean): void; dispose(): void } {
  const overlay = anchor.closest<HTMLElement>("[data-shell-overlay]");
  const frame = overlay?.parentElement;
  if (!overlay || !frame || frame.hasAttribute("data-spaces-host-rail")) throw new Error("Unsupported or occupied host layout seat.");
  frame.setAttribute("data-spaces-host-rail", "1");
  const margin = frame.style.getPropertyValue("margin-left"), marginPriority = frame.style.getPropertyPriority("margin-left");
  const width = frame.style.getPropertyValue("width"), widthPriority = frame.style.getPropertyPriority("width");
  const usedMargin = getComputedStyle(frame).marginLeft;
  // AppFrame measures its border box and positions resize handles against its
  // own columns. Reserve the rail outside that box so both stay in one coordinate
  // system. The rail width is a CSS variable so the native shell can collapse it.
  frame.style.setProperty("margin-left", `calc(${usedMargin} + var(--dsh-spaces-rail-width, 72px))`);
  const assignedMargin = frame.style.getPropertyValue("margin-left");
  frame.style.setProperty("width", "auto");
  const owned = new Map<HTMLElement, { inert: boolean; hidden: string | null }>();
  let disposed = false, covered = false;
  const collect = () => {
    for (const node of frame.children) {
      if (!(node instanceof HTMLElement) || node === overlay || node.tagName === "STYLE" || owned.has(node)) continue;
      owned.set(node, { inert: node.inert, hidden: node.getAttribute("aria-hidden") });
      if (covered) { node.inert = true; node.setAttribute("aria-hidden", "true"); node.setAttribute("data-spaces-host-covered", "1"); }
    }
  };
  collect();
  const observer = new MutationObserver(collect);
  observer.observe(frame, { childList: true });
  const cover = (active: boolean) => {
    if (disposed) return;
    covered = active; collect();
    for (const [node, prior] of owned) {
      if (active) { node.inert = true; node.setAttribute("aria-hidden", "true"); node.setAttribute("data-spaces-host-covered", "1"); }
      else if (node.hasAttribute("data-spaces-host-covered")) {
        node.inert = prior.inert;
        if (prior.hidden === null) node.removeAttribute("aria-hidden"); else node.setAttribute("aria-hidden", prior.hidden);
        node.removeAttribute("data-spaces-host-covered");
      }
    }
  };
  return { cover, dispose() {
    if (disposed) return;
    cover(false); disposed = true; observer.disconnect();
    frame.removeAttribute("data-spaces-host-rail");
    if (frame.style.getPropertyValue("margin-left") === assignedMargin) {
      if (margin) frame.style.setProperty("margin-left", margin, marginPriority); else frame.style.removeProperty("margin-left");
    }
    if (frame.style.getPropertyValue("width") === "auto") {
      if (width) frame.style.setProperty("width", width, widthPriority); else frame.style.removeProperty("width");
    }
  } };
}
