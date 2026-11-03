import React, { type ReactElement } from 'react';
import { motion } from 'motion/react';
import { LayoutIndicator, Presence, spring } from '../../../../src/shared/ui/motion.js';
import type { Tab } from '../remote-client.js';

export interface BrowserTabStripProps {
  tabs: readonly Tab[];
  selected: string | null;
  onSelect(tabId: string): void;
}

/**
 * The tab strip.
 *
 * Tabs enter and leave with presence. The active tab carries the shared
 * layout indicator, so the underline slides from the previous tab instead of
 * jumping. The indicator is a sibling of the tab content, never a parent of
 * a page frame, so nothing that is measured is ever transformed.
 */
export function BrowserTabStrip({ tabs, selected, onSelect }: BrowserTabStripProps): ReactElement {
  return <nav className="dsh-browser-tabs" aria-label="Browser tabs">
    <Presence>
      {tabs.map(tab => {
        const active = tab.id === selected;
        return <motion.button
          key={tab.id}
          type="button"
          className="dsh-browser-tab"
          aria-current={active ? 'page' : undefined}
          onClick={() => onSelect(tab.id)}
          initial={{ opacity: 0, y: -8, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.96 }}
          transition={spring}>
          {tab.title || (tab.url ? new URL(tab.url).hostname : 'Home')}
          {active && <LayoutIndicator layoutId="dsh-browser-tab-indicator" className="dsh-browser-tab-indicator" />}
        </motion.button>;
      })}
    </Presence>
  </nav>;
}
