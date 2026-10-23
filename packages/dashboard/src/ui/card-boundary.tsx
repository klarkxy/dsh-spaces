import React, { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Boundary around one widget body.
 *
 * A widget that cannot be rendered is reported as such. The failure is shown
 * immediately and is never retried, hidden behind an animation or replaced by
 * a recovery action.
 */
export class CardBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo): void { /* No provider payload or exception text is logged. */ }
  render() { return this.state.failed ? <p role="alert">此组件无法显示。</p> : this.props.children; }
}
