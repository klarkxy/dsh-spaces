import React, { type ReactElement } from "react";

import { defaultSpaceAvatar, DESKTOP_AVATAR_IMAGE } from "../../../../src/shared/space-avatars";
import { glyphPath, isDataImageIcon } from "./icons";

/** The desktop identity is fixed; ordinary spaces retain their chosen local image. */
export function SpaceGlyph({ icon, spaceId = "" }: { icon?: string; spaceId?: string }): ReactElement {
  const image = spaceId === "desktop" ? DESKTOP_AVATAR_IMAGE
    : !icon || icon === "whale" ? defaultSpaceAvatar(spaceId).image
    : isDataImageIcon(icon) ? icon : null;
  if (image) return <img className="dsh-wb-glyph-img" src={image} alt="" draggable={false} />;
  return <svg className="dsh-wb-glyph" viewBox="0 0 40 40" aria-hidden><path d={glyphPath(icon) ?? ""} fillRule="nonzero" /></svg>;
}
