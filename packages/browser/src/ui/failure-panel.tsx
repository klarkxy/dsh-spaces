import React, { type ReactElement } from 'react';
import { FadeIn } from '../../../../src/shared/ui/motion.js';

/**
 * The navigation failure panel.
 *
 * A failed navigation is reported as it happened. It renders immediately,
 * keeps the wording the remote client produced, and offers no retry.
 */
export function BrowserFailurePanel({ message }: { message: string }): ReactElement {
  return <FadeIn appear={false} as="p" className="dsh-browser-failure" role="alert">{message}</FadeIn>;
}
