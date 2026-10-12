import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const script = await readFile(new URL('../vscode/media/main.js', import.meta.url), 'utf8');
function sourceFunction(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing production function ${name}`);
  const end = script.indexOf('\nfunction ', start + 1);
  return script.slice(start, end < 0 ? script.indexOf('\nwindow.addEventListener', start) : end);
}
const catalog = { default: { provider: 'provider', model: 'disabled' }, routableProviders: ['provider'], failures: [],
  groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'disabled', name: 'Disabled' }, { id: 'enabled', name: 'Enabled', inputModalities: ['text', 'image'] }] }] };
function fixture({ initialCatalog = catalog, initialSelection = catalog.default, images = [], ready = true } = {}) {
  const state = { catalog: initialCatalog, selection: initialSelection, images, ready, posts: [] };
  const node = () => ({ disabled: false, hidden: true, dataset: {}, replaceChildren() {}, append() {}, setAttribute() {} });
  state.send = node(); state.trigger = node();
  const context = vm.createContext({ fixture: state, document: { createElement: node } });
  vm.runInContext(`
    let modelCatalog = fixture.catalog ?? undefined, modelSelection = fixture.selection ?? undefined;
    const providerSettingsSnapshot = { providers: [{id:'provider',models:[{id:'disabled',enabled:false},{id:'enabled',enabled:true}]}] };
    const modelTrigger = fixture.trigger, modelPicker = {hidden:true};
    let modelSelecting = false, running = false, compacting = false, sending = false, stopping = false, imageReading = false;
    const state = {}, send = fixture.send, prompt = {}, stop = {}, composer = {dataset:{}};
    const pendingQueueActions = new Map(), pendingImages = fixture.images, compactionSubmitGate = {locked:false};
    let clientReady = fixture.ready;
    const vscode = {postMessage: message => fixture.posts.push(message)};
    function renderProviderUsage() {} function renderModelPicker() {} function closeModelPicker() {}
    function renderSendAction() {} function renderImageTray() {} function renderImageError() {} function hasWaitingQueue() {return false;}
    ${['isRecord', 'isModelSelection', 'isModelCatalog', 'findCatalogModel', 'effortLabel', 'selectedModelEnabled',
      'selectedModelAcceptsImages', 'renderModelTrigger', 'updateInputAvailability', 'submitModelSelection', 'applyHostMessage'].map(sourceFunction).join('\n')}
    updateInputAvailability(); renderModelTrigger();
    fixture.deliver = message => applyHostMessage(message);
    fixture.choose = (provider, model) => submitModelSelection(provider, model);
  `, context);
  return state;
}

test('a disabled selected model does not block choosing another model and its selection immediately re-enables Send', () => {
  const f = fixture();
  assert.equal(f.send.disabled, true);
  assert.equal(f.trigger.disabled, false, 'The model picker must remain available for recovery');
  f.choose('provider', 'enabled');
  assert.deepEqual(JSON.parse(JSON.stringify(f.posts)), [{ type: 'selectModel', provider: 'provider', model: 'enabled' }]);
  f.deliver({ type: 'modelSelecting', value: false });
  f.deliver({ type: 'modelSelection', selection: { provider: 'provider', model: 'enabled' } });
  assert.equal(f.send.disabled, false, 'No unrelated stream/status event should be required to refresh Send');
});

test('restored catalog and selection reconcile composer availability in either delivery order', () => {
  for (const messages of [
    [{ type: 'modelCatalog', catalog }, { type: 'modelSelection', selection: { provider: 'provider', model: 'enabled' } }],
    [{ type: 'modelSelection', selection: { provider: 'provider', model: 'enabled' } }, { type: 'modelCatalog', catalog }],
  ]) {
    const f = fixture({ initialCatalog: null, initialSelection: null });
    for (const message of messages) f.deliver(message);
    assert.equal(f.send.disabled, false);
  }
});

test('route loss, disabled-model selection and incompatible images immediately disable Send', () => {
  const f = fixture({ initialSelection: { provider: 'provider', model: 'enabled' } });
  assert.equal(f.send.disabled, false);
  f.deliver({ type: 'modelCatalog', catalog: { ...catalog, routableProviders: [] } });
  assert.equal(f.send.disabled, true);
  f.deliver({ type: 'modelCatalog', catalog }); assert.equal(f.send.disabled, false);
  f.deliver({ type: 'modelSelection', selection: catalog.default }); assert.equal(f.send.disabled, true);
  const images = fixture({ initialSelection: { provider: 'provider', model: 'enabled' }, images: [{ id: 'image' }] });
  assert.equal(images.send.disabled, false);
  images.deliver({ type: 'modelCatalog', catalog: { ...catalog, groups: [{ ...catalog.groups[0], models: catalog.groups[0].models.map(model => ({ ...model, inputModalities: ['text'] })) }] } });
  assert.equal(images.send.disabled, true);
});

test('invalid selection/catalog messages do not unlock a disabled composer or bypass connection readiness', () => {
  const f = fixture();
  f.deliver({ type: 'modelSelection', selection: { provider: 'provider' } });
  f.deliver({ type: 'modelCatalog', catalog: { routableProviders: ['provider'] } });
  assert.equal(f.send.disabled, true);
  const disconnected = fixture({ ready: false });
  disconnected.deliver({ type: 'modelSelection', selection: { provider: 'provider', model: 'enabled' } });
  assert.equal(disconnected.send.disabled, true);
});
