/** Client half: keep [data-dsh-boot] so the view-bridge cannot report ready. */
export const name = "dsh-spaces-hang-fixture-client";
export const inject = ["slots"];

export function apply(ctx) {
  return ctx.slots.inject("root", () => {
    const doc = globalThis.document;
    if (!doc) return () => undefined;
    const el = doc.createElement("div");
    el.setAttribute("data-dsh-boot", "hang-fixture");
    el.setAttribute("data-dsh-spaces-hang", "1");
    (doc.body || doc.documentElement).appendChild(el);
    return () => el.remove();
  });
}
