import { readFileSync } from 'node:fs';

// One shipped source for both standalone reading and Creator prompt guidance.
export const CREATOR_GUIDANCE = readFileSync(new URL('./skills/dsh-blueprint/SKILL.md', import.meta.url), 'utf8')
  .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();

export function installCreatorGuidance(ctx) {
  // The Plugins page remains usable in hosts without agent prompt services.
  ctx.inject(['systemPrompt', 'agentPresets'], scope => {
    scope.effect(() => scope.systemPrompt.section({
      name: 'dsh-blueprint.creator-guidance',
      order: 110,
      interpolate: false,
      text: ({ agent }) => agent && scope.agentPresets.composedPreset(agent.ctx) === 'cordis'
        ? CREATOR_GUIDANCE : '',
    }), 'dsh-blueprint.creator-guidance');
  });
}
