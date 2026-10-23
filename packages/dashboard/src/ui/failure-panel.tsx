import React, { type ReactNode } from 'react';
import { FadeIn } from '../../../../src/shared/ui/index.js';
import type { DashboardError } from '../../../../src/shared/dashboard.js';

/**
 * The read failure panel.
 *
 * A failed read is a terminal state. It renders immediately, stays on screen
 * and offers no retry, no refresh and no recovery action.
 */
export function ReadFailurePanel({ error, retained }: { error: DashboardError; retained: boolean }): ReactNode {
  return <FadeIn appear={false} className="dd-error" role="alert">
    <strong>看板读取已停止</strong>
    <p>{retained ? '下方是上次读取的内容，不代表当前状态。' : '当前内容不可用。'}</p>
    <code>{error.code}</code>
    {error.details?.field && <small>{error.details.field}{error.details.actual !== undefined ? ` (${error.details.actual})` : ''}{error.details.query ? ` · ${error.details.query}` : ''}{error.details.phase ? ` · ${error.details.phase}` : ''}{error.details.httpStatus !== undefined ? ` · HTTP ${error.details.httpStatus}` : ''}{error.details.elapsedMs !== undefined ? ` · ${error.details.elapsedMs}ms` : ''}</small>}
  </FadeIn>;
}

/**
 * The write failure panel.
 *
 * A write that could not be confirmed is reported as unconfirmed. It is never
 * resent and never turned into a repair offer.
 */
export function WriteFailurePanel({ error }: { error: DashboardError }): ReactNode {
  return <FadeIn appear={false} className="dd-error" role="alert">
    <strong>{error.code === 'dashboard/unavailable' ? '操作结果无法确认，未重新发送。' : '此操作未确认成功。'}</strong>
    <p><code>{error.code}</code></p>
    {error.requestId && <small>请求：{error.requestId}</small>}
  </FadeIn>;
}
