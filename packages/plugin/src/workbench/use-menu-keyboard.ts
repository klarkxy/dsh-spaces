/**
 * Context menu behavior shared by the workbench space menu and the desktop
 * native space menu.
 *
 * On mount the menu is clamped into the viewport, its first enabled item is
 * focused and the previously focused element is remembered so closing can
 * return it. ArrowUp/ArrowDown/Home/End move over enabled items; Escape and
 * Tab close; a pointer down outside or a window resize closes as well.
 */

import { useEffect, type KeyboardEvent, type RefObject } from "react";

const ITEM_SELECTOR = "button:not(:disabled)";

export function useMenuKeyboard(
  ref: RefObject<HTMLElement | null>,
  { x, y, onClose }: { x: number; y: number; onClose: () => void },
): { onKeyDown: (event: KeyboardEvent<HTMLElement>) => void } {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = ref.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
    (element.querySelector<HTMLButtonElement>(ITEM_SELECTOR) ?? element).focus();
    const close = (event: Event) => {
      if (!element.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", onClose);
      if (previous?.isConnected) previous.focus();
    };
  }, [ref, x, y, onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      onClose();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>(ITEM_SELECTOR) ?? [])];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  return { onKeyDown };
}
