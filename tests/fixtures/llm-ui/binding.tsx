import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SpaceBindingPanel} from '../../../packages/plugin/src/workbench/llm/space-binding';
import type {LlmUiClient, LlmUiSpace} from '../../../packages/plugin/src/workbench/llm/client';
import type {LlmDescribeResult} from '../../../src/shared/llm-api';

const state = (window as any).__BINDING = {writes: [] as unknown[], plans: [] as unknown[], resolve: {} as Record<string, () => void>, pin: (_id: string) => {}};
const mode = new URLSearchParams(location.search).get('mode');
const spaces: LlmUiSpace[] = ['a', 'b'].map(spaceId => ({spaceId, displayName: spaceId, status:'running', generation:1, serviceEpoch:'epoch'}));
if (mode === 'incomplete') spaces[1] = {...spaces[1]!, status:'unknown', serviceEpoch:''};
const policy = (spaceId: string) => ({spaceId, policy:{schemaVersion:1, revision:1, shared:{mode:'selected', connectionIds:[`conn-${spaceId}`]}}, runningCatalogRevision:1, pendingRestart:true});
const client = {
  spacePolicy(spaceId: string) {
    if (mode !== 'race') return Promise.resolve(policy(spaceId));
    return new Promise(resolve => {state.resolve[spaceId] = () => resolve(policy(spaceId));});
  },
  spaceDefault:async (spaceId: string) => ({spaceId, inheritGlobal:true, local:null, global:null, effective:null}),
  listLocalCandidates:async () => ({candidates:[]}),
  importedRequirements:async () => ({mappingRequired:false}),
  async updateSpacePolicy(spaceId: string, shared: unknown) {
    state.writes.push([spaceId, shared]);
    if (mode === 'write') await new Promise<void>(resolve => {state.resolve.write = resolve;});
    return {...policy(spaceId), policy:{...policy(spaceId).policy, shared}};
  },
  async applyPlan(...args:unknown[]) {state.plans.push(args);},
} as unknown as LlmUiClient;
const describe = {
  revision:1, pendingRestartSpaceIds:mode === 'hidden' ? ['b'] : ['a','b'],
  connections:['a','b','c'].map(id => ({id:`conn-${id}`, displayName:`conn-${id}`, providerConfig:{models:[]}})),
} as unknown as LlmDescribeResult;
function App() {
  const [pinned, pin] = useState(mode === 'hidden' || mode === 'pinned' ? 'a' : undefined);
  state.pin = pin;
  return <SpaceBindingPanel locale="en" writable client={client} spaces={pinned ? spaces.filter(space => space.spaceId === pinned) : spaces}
    selectedSpaceId={pinned} describe={describe} onChanged={() => {}} />;
}
createRoot(document.getElementById('root')!).render(<App />);
