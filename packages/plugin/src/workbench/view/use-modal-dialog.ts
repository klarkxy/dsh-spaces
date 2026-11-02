/**
 * Modal dialog keyboard behavior.
 *
 * One hook for every workbench dialog: on mount it remembers the previously
 * focused element and moves focus inside the dialog ([data-autofocus], an
 * explicit `initialFocus` target, the first enabled field, else the first
 * enabled button). Escape cancels; Tab cycles within the visible enabled
 * focusables; on unmount the remembered focus returns if it is still
 * connected.
 */

import { useEffect, type KeyboardEvent, type RefObject } from "react";

const FOCUSABLE =
  'input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), summary, a[href], [tabindex="0"]';

function visibleFocusables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.getClientRects().length > 0,
  );
}

export function useModalDialog(
  ref: RefObject<HTMLElement | null>,
  { onCancel, initialFocus }: { onCancel: () => void; initialFocus?: RefObject<HTMLElement | null> },
): { onKeyDown: (event: KeyboardEvent<HTMLElement>) => void } {
  useEffect(() => {
    const previous = document.activeElement;
    const container = ref.current;
    if (!container) return;
    const target =
      initialFocus?.current ??
      container.querySelector<HTMLElement>("[data-autofocus]") ??
      container.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled), textarea:not(:disabled)") ??
      container.querySelector<HTMLElement>("button:not(:disabled)");
    target?.focus();
    if (target instanceof HTMLInputElement) target.select();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
    // Mount-only: the dialog focus target is decided once it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const items = ref.current ? visibleFocusables(ref.current) : [];
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return { onKeyDown };
}
