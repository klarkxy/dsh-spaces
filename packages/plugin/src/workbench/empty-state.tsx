/**
 * The empty state of a list.
 *
 * An empty list says what is missing and offers the next step: one primary
 * action where one exists. The card is a plain box with a dashed border, so it
 * never hides what it stands for.
 */
import React, { type ReactElement, type ReactNode } from "react";

export function EmptyState({
  title,
  hint,
  action,
  testId,
}: {
  /** What the list would hold. */
  title: string;
  /** One more sentence, if the next step needs one. */
  hint?: string;
  /** The next step. One primary action where one exists. */
  action?: ReactNode;
  /** The name of the list this state belongs to. */
  testId?: string;
}): ReactElement {
  return (
    <div className="dsh-wb-empty" data-empty={testId}>
      <p>{title}</p>
      {hint ? <p className="dsh-wb-muted">{hint}</p> : null}
      {action}
    </div>
  );
}
