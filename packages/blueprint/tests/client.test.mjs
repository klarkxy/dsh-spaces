import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const documentV2 = {
  kind: 'dsh-blueprint', formatVersion: 2, metadata: { name: 'Shared setup' },
  packages: [ { name: 'dsh-example', version: '1.2.3', source: 'npm' },
    { name: '@deepseek-ai/dsh-example', version: '0.2.0-rc.1', source: 'builtin' } ],
  bundles: ['@deepseek-ai/dsh-example', 'dsh-example'],
};
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...(tree.children ?? []).flat(Infinity).flatMap(nodes)];
}
function find(tree, predicate) { return nodes(tree).find(predicate); }
function content(tree) {
  if (typeof tree === 'string') return tree;
  return (tree?.children ?? []).flat(Infinity).map(content).join(' ');
}
function openImport(app) {
  const action = app.registrations[0].render();
  const actions = app.render(action.type, action.props);
  actions.tree.children.find(x => x && x.type === 'div').children[0].props.onClick();
  const dialog = find(actions.update(), x => x.props.task === 'import');
  const task = app.render(dialog.type, dialog.props);
  const getImport = () => find(task.update(), x => typeof x.props.parseImport === 'function');
  /* Re-render the parent, then feed its fresh dialog props (such as t) to the open dialog. */
  const rerender = () => task.update(find(actions.update(), x => x.props.task === 'import').props);
  return { task, getImport, rerender };
}

function client(active = 'en', deferred = false) {
  let definition;
  const effects = [], listeners = new Map(), calls = [], copied = [];
  let frame;
  function render(type, props) {
    const state = [], refs = [];
    let current = props;
    /* A parent re-render hands new props to the same instance, keeping its state. */
    const instance = { tree: null, update(next) {
      if (next) current = next;
      frame = { state, refs, cursor: 0, refCursor: 0 };
      instance.tree = type(current);
      frame = null;
      return instance.tree;
    } };
    instance.update();
    return instance;
  }
  const document = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    fire(type, event) { listeners.get(type)?.(event); },
  };
  const hooks = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      if (!frame) return [typeof initial === 'function' ? initial() : initial, () => {}];
      const { state } = frame, index = frame.cursor++;
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
    },
    useEffect(effect) { effects.push(effect); },
    useRef(initial) {
      if (!frame) return { current: initial ?? null };
      const index = frame.refCursor++;
      return frame.refs[index] ??= { current: initial ?? null };
    },
  };
  vm.runInNewContext(source, { document, AbortController, navigator: { clipboard: { async writeText(text) { copied.push(text); } } },
    window: { __ModuleLoader__: { load(value) { definition = value; } } } });
  const registrations = [], injected = [], pending = [];
  const ctx = {
    locale: { getSnapshot: () => ({ active }), subscribe: () => () => {} },
    connection: { rpc: { async call(channel, endpoint, payload, signal) {
      calls.push({ channel, endpoint, payload, signal });
      return { ok: true, value: documentV2 };
    } } },
    slots: {
      inject(name, register) { injected.push(name); if (deferred) pending.push(register); else register(); },
      register(options, render) { registrations.push({ options, render }); },
    },
  };
  /* The host hands the factory a require that resolves its own modules by id.
   * React is stood in for by the hooks above and the shared control primitives
   * by named placeholders, so a test exercises this client's wiring rather than
   * the host's controls. */
  const primitives = { Button: () => null, Checkbox: () => null, Input: () => null, Menu: () => null, Modal: () => null };
  const requested = [];
  definition.factory(name => {
    requested.push(name);
    if (name === 'react') return hooks;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`unexpected host module: ${name}`);
  }).apply(ctx);
  return { ctx, registrations, injected, pending, effects, document, render, calls, copied, requested };
}

test('only own optional bundle page registers when its host slot becomes available', () => {
  const { registrations, injected, pending } = client('en', true);
  assert.deepEqual(injected, ['plugins.bundle.config']);
  assert.equal(registrations.length, 0);
  pending.forEach(register => register());
  assert.deepEqual(registrations.map(x => x.options.name), injected);
  assert.equal(registrations[0].options.key, '@klarkxy/dsh-blueprint');
  assert.equal(registrations[0].render().props.page, true);
});

test('both locales expose Import and Export as two direct buttons', () => {
  for (const [locale, expected] of [
    ['en', ['Import blueprint', 'Export blueprint']],
    ['zh-CN', ['导入蓝图', '导出蓝图']],
  ]) {
    const { registrations } = client(locale);
    const component = registrations[0].render({});
    const tree = component.type(component.props);
    const buttons = tree.children.find(x => x && x.type === 'div').children;
    assert.deepEqual(buttons.map(content), expected);
    assert.ok(buttons.every(button => button.props['aria-haspopup'] === undefined));
  }
});

test('each button opens its own task dialog', () => {
  const app = client();
  const action = app.registrations[0].render();
  const actions = app.render(action.type, action.props);
  const buttons = actions.tree.children.find(x => x && x.type === 'div').children;
  buttons[1].props.onClick();
  assert.equal(find(actions.update(), x => x.props.task === 'export').props.task, 'export');
});

function openExport(app) {
  const action = app.registrations[0].render();
  const actions = app.render(action.type, action.props);
  actions.tree.children.find(x => x && x.type === 'div').children[1].props.onClick();
  const dialog = find(actions.update(), x => x.props.task === 'export');
  const task = app.render(dialog.type, dialog.props);
  const getExport = () => find(task.update(), x => typeof x.props.togglePackage === 'function');
  return { task, getExport };
}

const catalogV1 = {
  order: ['a', 'b', 'c', 'locked'],
  packages: [
    { name: 'a', version: '1.0.0', enabled: true, readonly: false, reason: null },
    { name: 'b', version: '1.0.0', enabled: true, readonly: false, reason: null },
    { name: 'c', version: '1.0.0', enabled: true, readonly: false, reason: null },
    { name: 'locked', version: '1.0.0', enabled: true, readonly: true, reason: null },
    { name: 'linked', version: null, enabled: true, readonly: false, reason: 'unknown-exact-version' },
  ],
};

test('export lists excluded plugins with reasons and refresh keeps a still-valid selection and order', async () => {
  const app = client();
  let catalog = catalogV1;
  app.ctx.connection.rpc.call = async () => ({ ok: true, value: catalog });
  const { getExport } = openExport(app);
  app.effects.splice(0).forEach(effect => effect());
  await new Promise(resolve => setImmediate(resolve));
  let element = getExport();
  assert.deepEqual(element.props.selected, ['a', 'b', 'c']);
  let text = content(element.type(element.props));
  assert.match(text, /locked · protected or a required built-in/);
  assert.match(text, /linked · no exact version is known/);
  element.props.move(0, 1);
  element.props.togglePackage('c');
  /* The client runs in a vm realm, so copy its arrays before a strict comparison. */
  assert.deepEqual([...getExport().props.selected], ['b', 'a']);
  catalog = { ...catalogV1, packages: catalogV1.packages.map(p => p.name === 'a' ? { ...p, reason: 'native-bundle-error' } : p) };
  await getExport().props.load();
  assert.deepEqual([...getExport().props.selected], ['b']);
});

test('export shows an empty state when nothing is exportable', async () => {
  const app = client();
  app.ctx.connection.rpc.call = async () => ({ ok: true, value: { order: [], packages: [
    { name: 'locked', version: '1.0.0', enabled: true, readonly: true, reason: null }] } });
  const { getExport } = openExport(app);
  app.effects.splice(0).forEach(effect => effect());
  await new Promise(resolve => setImmediate(resolve));
  const element = getExport();
  const tree = element.type(element.props);
  assert.ok(find(tree, x => x.props.className === 'dsh-ui-empty' && /No plugins can be exported/.test(content(x))));
});

test('a failed request falls back to localized text', async () => {
  const app = client('zh-CN');
  app.ctx.connection.rpc.call = async () => ({ ok: false });
  const { task, getImport } = openImport(app);
  getImport().props.updateSource('code');
  await getImport().props.parseImport();
  const alert = find(task.update(), x => x.props.role === 'alert');
  assert.equal(content(alert).trim(), '请求失败');
});

test('default name and merge intent follow the locale until edited', () => {
  let active = 'en', listener;
  const app = client('en');
  app.ctx.locale.getSnapshot = () => ({ active });
  app.ctx.locale.subscribe = fn => { listener = fn; return () => {}; };
  const { getImport, rerender } = openImport(app);
  /* Run mount effects so the locale subscription exists before the switch. */
  app.effects.splice(0).forEach(effect => effect());
  assert.match(getImport().props.intent, /preserving existing local bundles/);
  active = 'zh-CN';
  listener?.();
  /* The locale lives in the parent: re-render it so the dialog gets the new t, then run its effects. */
  rerender();
  app.effects.splice(0).forEach(effect => effect());
  assert.match(getImport().props.intent, /保留本地已有插件组合/);
  getImport().props.setIntent('mine');
  active = 'en';
  listener?.();
  rerender();
  app.effects.splice(0).forEach(effect => effect());
  assert.equal(getImport().props.intent, 'mine');
});

test('import does no work on mount and explicit parse returns the validated v2 document', async () => {
  const app = client();
  const { getImport } = openImport(app);
  app.effects.splice(0).forEach(effect => effect());
  assert.equal(app.calls.length, 0);
  assert.equal(app.copied.length, 0);
  let element = getImport();
  assert.match(element.props.intent, /preserving existing local bundles/);
  element.props.updateSource('  DSHBP2.original-code  ');
  element = getImport();
  await element.props.parseImport();
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].channel, '/dsh-blueprint');
  assert.equal(app.calls[0].endpoint, 'parse');
  assert.equal(app.calls[0].payload.text, '  DSHBP2.original-code  ');
  element = getImport();
  assert.equal(element.props.parsed, documentV2);
  const tree = element.type(element.props);
  assert.match(content(tree), /dsh-example@1\.2\.3/);
  assert.match(content(tree), /@deepseek-ai\/dsh-example@0\.2\.0-rc\.1/);
  const order = find(tree, x => x.type === 'ol');
  assert.deepEqual(Array.from(order.children[0], item => content(item)), documentV2.bundles);
  assert.equal(find(tree, x => x.props.type === 'checkbox'), undefined);
  element.props.updateSource('changed');
  assert.equal(getImport().props.parsed, null);
});

test('copy is explicit and includes editable intent plus unchanged original source for manual Creator paste', async () => {
  const app = client();
  const { getImport } = openImport(app);
  let element = getImport();
  element.props.updateSource('  ORIGINAL\nCODE  ');
  element = getImport();
  await element.props.parseImport();
  element = getImport();
  let tree = element.type(element.props);
  /* The label element wraps the textarea, so it needs no aria-label of its own. */
  const intent = find(tree, x => x.type === 'textarea' && x.props.value === element.props.intent);
  assert.equal(intent.props['aria-label'], undefined);
  intent.props.onChange({ target: { value: 'Keep local bundles; review order first.' } });
  element = getImport();
  tree = element.type(element.props);
  app.effects.splice(0).forEach(effect => effect());
  assert.equal(app.copied.length, 0);
  const button = find(tree, x => content(x) === 'Copy merge request');
  await button.props.onClick();
  assert.equal(app.copied.length, 1);
  assert.match(app.copied[0], /Keep local bundles; review order first\./);
  assert.ok(app.copied[0].endsWith('  ORIGINAL\nCODE  '));
  assert.match(app.copied[0], /resolve exact versions and order/);
  assert.match(content(tree), /Paste into Creator manually/);
  assert.equal(app.calls.length, 1);
});

test('editing source cancels pending parsing and a late reply cannot restore parsed data', async () => {
  const app = client(); let finish, seenSignal;
  app.ctx.connection.rpc.call = async (_channel, _endpoint, _payload, signal) => {
    seenSignal = signal; return new Promise(resolve => { finish = resolve; });
  };
  const { getImport } = openImport(app);
  getImport().props.updateSource('first');
  const pending = getImport().props.parseImport();
  getImport().props.updateSource('second');
  assert.equal(seenSignal.aborted, true);
  finish({ ok: true, value: documentV2 }); await pending;
  assert.equal(getImport().props.parsed, null);
  assert.equal(getImport().props.source, 'second');
});

test('client requires only host modules the package declares in dsh.client.inject', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const { requested } = client();
  assert.deepEqual(Array.from(new Set(requested)).sort(),
    ['@deepseek-ai/dsh-client-ui-primitives', 'react']);
  for (const id of requested) {
    /* React is the one module every client half gets; the rest decides what the
     * host puts in its module table. */
    if (id === 'react') continue;
    assert.ok(manifest.dsh.client.inject.includes(id), `${id} must be declared in dsh.client.inject`);
  }
});

test('client contains no Settings UI or Settings-mode RPC contract', () => {
  assert.doesNotMatch(source, /settings|设置|forms|omit|readFile|mode:/i);
  assert.match(source, /call\('catalog', \{\}\)/);
  assert.match(source, /call\('generate', \{ name, packages: selected \}\)/);
  assert.match(source, /call\('parse', \{ text: source \}\)/);
  assert.doesNotMatch(source, /plugins\.list\.actions|lastPlan|planId|finishedPlan|previewImport|applyImport|readResult|setConfirmed/);
  assert.doesNotMatch(source, /call\('(preview|apply|result)'|ctx\.(chat|agent|model)|inputActions|sendMessage/);
});
