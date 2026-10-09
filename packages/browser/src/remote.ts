import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { BrowserTabs, type BrowserObservation } from './tabs';

/** Same-Space UI access, carried by DSH's authenticated /api Connection. */
export class BrowserRemote extends TypertRemoteService {
  constructor(ctx: Context, private readonly tabs: BrowserTabs) { super(ctx, 'spacesBrowser'); }

  @Remote('listTabs')
  listTabs(): ReturnType<BrowserTabs['listTabs']> { return this.tabs.listTabs(); }

  @Remote('openURL')
  openURL(url: string): ReturnType<BrowserTabs['openURL']> {
    try { return this.tabs.openURL(url); }
    catch { throw new Error('The Browser URL is not allowed.'); }
  }

  @Remote('observe')
  observe(observations: BrowserObservation[]): ReturnType<BrowserTabs['listTabs']> {
    return this.tabs.observe(observations);
  }
}
