import test from 'node:test';
import assert from 'node:assert/strict';
import { CREATOR_GUIDANCE, installCreatorGuidance } from '../creator-guidance.mjs';

function host() {
  const sections = new Map(), disposers = [];
  let activate;
  installCreatorGuidance({ inject(services, callback) {
    assert.deepEqual(services, ['systemPrompt', 'agentPresets']);
    activate = () => callback({
      agentPresets: { composedPreset: ctx => ctx.preset },
      systemPrompt: { section(value) {
        assert.equal(sections.has(value.name), false);
        sections.set(value.name, value);
        return () => sections.delete(value.name);
      } },
      effect(factory) { disposers.push(factory()); },
    });
  } });
  return { sections, activate, dispose() { for (const dispose of disposers.splice(0)) dispose(); } };
}

test('guidance uses the calling agent composed preset on every assembly', () => {
  const h = host(); h.activate();
  const section = [...h.sections.values()][0];
  const agent = { ctx: { preset: 'standard' }, session: { header: { agentPreset: 'cordis' } } };
  assert.equal(section.text({ agent }), '');
  agent.ctx.preset = 'cordis';
  assert.equal(section.text({ agent }), CREATOR_GUIDANCE);
  assert.ok(CREATOR_GUIDANCE.startsWith('# DSH blueprints'));
  assert.equal(section.interpolate, false);
  agent.ctx.preset = 'standard';
  assert.equal(section.text({ agent }), '');
  agent.ctx.preset = undefined;
  assert.equal(section.text({ agent }), '');
  assert.equal(section.text({}), '');
  assert.equal(section.text({ agent: null }), '');
});

test('prompt services can arrive late, detach and return without duplicate guidance', () => {
  const h = host();
  assert.equal(h.sections.size, 0);
  h.activate();
  assert.equal(h.sections.size, 1);
  h.dispose();
  assert.equal(h.sections.size, 0);
  h.activate();
  assert.equal(h.sections.size, 1);
  h.dispose();
  assert.equal(h.sections.size, 0);
});
