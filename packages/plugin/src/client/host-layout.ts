/** One instance owns only its additive layout reservation. It never remounts the host React tree. */
export function attachHostLayout(anchor: HTMLElement): { cover(active: boolean): void; dispose(): void } {
  const overlay = anchor.closest<HTMLElement>("[data-shell-overlay]");
  const frame = overlay?.parentElement;
  if (!overlay || !frame || frame.hasAttribute("data-spaces-host-rail")) throw new Error("Unsupported or occupied host layout seat.");
  frame.setAttribute("data-spaces-host-rail", "1");
  const padding = frame.style.getPropertyValue("padding-left"), priority = frame.style.getPropertyPriority("padding-left");
  const box = frame.style.getPropertyValue("box-sizing"), boxPriority = frame.style.getPropertyPriority("box-sizing");
  const usedPadding = getComputedStyle(frame).paddingLeft;
  frame.style.setProperty("padding-left", `calc(${usedPadding} + 72px)`);
  const assignedPadding = frame.style.getPropertyValue("padding-left");
  frame.style.setProperty("box-sizing", "border-box");
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
    if (frame.style.getPropertyValue("padding-left") === assignedPadding) {
      if (padding) frame.style.setProperty("padding-left", padding, priority); else frame.style.removeProperty("padding-left");
    }
    if (frame.style.getPropertyValue("box-sizing") === "border-box") {
      if (box) frame.style.setProperty("box-sizing", box, boxPriority); else frame.style.removeProperty("box-sizing");
    }
  } };
}
