import type { SlotScopeAdapter, StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-renderer/client';

/** rc.2's root renderer always asks for the optional session scope, including in
 * non-chat applications. Declare its absence without loading a Session controller.
 * Explicit session-scoped extensions fail instead of inventing a session.
 */
const absent: StandardSourceBinding = Object.freeze({ key: undefined, hooks: {}, keyedHooks: {}, props: {} });
const source = { getSnapshot: () => absent, subscribe: (_listener: () => void) => () => {} };

export const noSessionScope: SlotScopeAdapter = {
  current: source,
  bindingSource(target) {
    if (target != null) throw new Error('The Browser base has no session scope.');
    return source;
  },
  renderArea: (_binding, props) => props.empty?.() ?? null,
};
