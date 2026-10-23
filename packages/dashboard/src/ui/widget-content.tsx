import React, { type ReactNode } from 'react';
import type { WidgetContent } from '../../../../src/shared/dashboard.js';

const states: Record<string, string> = { queued: '排队中', running: '进行中', waiting: '等待处理', succeeded: '已完成', failed: '失败', cancelled: '已取消', todo: '待处理', doing: '进行中', done: '已完成', blocked: '受阻' };

/**
 * The four widget renderers.
 *
 * Deliberately inert: Markdown is rendered as plain text. No raw HTML, link
 * activation, images, URL resolution, scripts or remote resources.
 */
export function WidgetContentView({ content }: { content: WidgetContent }): ReactNode {
  switch (content.kind) {
    case 'progress': return <div className="dd-progress"><progress value={content.value} max={content.max} aria-label="进度" /><output>{content.value} / {content.max} {content.unit}</output><span>{states[content.status]}</span></div>;
    case 'metric': return <p className="dd-metric"><strong>{content.value}</strong> <span>{content.unit}</span></p>;
    case 'list': return <ul className="dd-list">{content.items.map(item => <li key={item.id}><span>{item.label}</span><small>{states[item.state]}</small></li>)}</ul>;
    // Deliberately render Markdown as inert text in this first renderer. No raw HTML,
    // link activation, images, URL resolution, scripts or remote resources.
    case 'markdown': return <pre className="dd-markdown" aria-label="Markdown（纯文本）">{content.text}</pre>;
  }
}
