/**
 * The failure line of the space template page.
 *
 * A failure is rendered in its visible end state: the line carries no entrance
 * animation, so it is readable in the first frame it exists. It sits next to
 * the control that caused it and offers no way to retry.
 */
import React, { type ReactElement } from "react";

export function TemplatesError({ message }: { message: string }): ReactElement {
  return (
    <p className="dsh-wb-alert" role="alert" data-templates-error="true">
      {message}
    </p>
  );
}
