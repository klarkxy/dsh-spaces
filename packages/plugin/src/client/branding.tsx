import React, { type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import { BRAND_IMAGE_URL } from "../../../../src/shared/brand-artwork";

// Optional conversation surface: mirrored from the rc.2 owner contract so
// Spaces does not require the conversation plugin in every profile.
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    "conversation.hero.brand.mark": {
      kind: "single";
      scope: "root";
      owner: { size: number; className?: string | undefined };
    };
  }
}

export function SpacesBrandMark({ size, className }: { size: number; className?: string }): ReactElement {
  return <img src={BRAND_IMAGE_URL} width={size} height={size} className={className}
    alt="" aria-hidden="true" draggable={false}
    style={{ objectFit: "contain", borderRadius: "22%" }} />;
}

export function registerSpacesBranding(ctx: Context): void {
  ctx.slots.inject("sidebar.brand.mark", () =>
    ctx.slots.register({ name: "sidebar.brand.mark", priority: -1 }, SpacesBrandMark),
  );
  ctx.slots.inject("conversation.hero.brand.mark", () =>
    ctx.slots.register({ name: "conversation.hero.brand.mark", priority: -1 }, SpacesBrandMark),
  );
}
