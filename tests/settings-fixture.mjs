import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const state = await readFile(new URL('../vscode/media/settings-state.js', import.meta.url), 'utf8');
const script = await readFile(new URL('../vscode/media/settings-editor.js', import.meta.url), 'utf8');
export const sampleModels = { writable: true, modelPolicyRevision: 0, families: [{ id: 'openrouter', name: 'OpenRouter', maxInstances: null, instanceCount: 1 }],
  providers: [{ id: 'route', instanceId: 'one', familyId: 'openrouter', name: 'Work', kind: 'dynamic', active: true, enabled: true, baseURL: 'https://example.org', revision: 0,
    credential: { ref: 'KEY_REF', writable: true, configured: true }, models: [{ id: 'model', name: 'Model', enabled: true }] }] };
export const sampleSearch = { revision: 0, cooldownMs: 14400000, entries: [
  { id: 'private', family: 'brave', displayName: 'Private', enabled: true, configured: true, writable: true, checking: false,
    failure: { reason: 'quota', message: 'Brave budget exhausted', failedAt: 1000, blockedUntil: Date.now() + 14400000, retrySource: 'default' } },
  { id: 'work', family: 'exa', displayName: 'Work', enabled: true, configured: true, writable: true, checking: false, failure: null },
] };
export function fixture(saved = undefined) {
  const posts = []; const intervals = []; const timers = new Map(); let stateValue = saved; let receive;
  const root = new Element('body'); const nav = new Element('nav');
  for (const [category, text] of [['models', 'Models'], ['search', 'Web Search']]) { const button = new Element('button'); button.dataset.category = category; button.textContent = text; nav.append(button); }
  const content = new Element('main'); content.id = 'content'; const connection = new Element('span'); connection.id = 'connection'; root.append(connection, nav, content);
  const doc = { visibilityState: 'visible', createElement: tag => new Element(tag), getElementById: id => [root, ...root.descendants()].find(e => e.id === id), querySelectorAll: selector => root.querySelectorAll(selector) };
  const context = vm.createContext({ document: doc, Date, console,
    window: { addEventListener: (_event, listener) => { receive = listener; } },
    acquireVsCodeApi: () => ({ getState: () => stateValue, setState: value => { stateValue = JSON.parse(JSON.stringify(value)); }, postMessage: value => posts.push(JSON.parse(JSON.stringify(value))) }),
    setInterval: callback => intervals.push(callback), setTimeout: callback => { const id = Symbol(); timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(state, context); vm.runInContext(script, context);
  const send = message => receive({ data: message });
  const connected = (generation = 1, phase = 'connected') => send({ type: 'settingsConnection', generation, phase, authority: 'Local · test' });
  const reply = (value, request = posts.filter(p => p.type === 'settingsRequest').at(-1)) => send({ type: 'settingsResult', requestId: request.requestId, generation: 1, ...value });
  const ready = () => { connected(); reply({ models: structuredClone(sampleModels), search: structuredClone(sampleSearch) }); };
  return { root, nav, content, connection, posts, send, connected, reply, ready, poll: () => intervals.forEach(f => f()),
    api: context.dshCompanionSettingsState, saved: () => stateValue,
    button: text => root.querySelectorAll('button').find(e => e.textContent === text),
  };
}
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.scrollTop = 0; this.disabled = false; this.hidden = false; this.text = ''; this._value = undefined; }
  get textContent() { return this.text + this.children.map(e => e.textContent).join(''); }
  set textContent(value) { this.text = value; this.replaceChildren(); }
  get value() { return this._value ?? (this.tag === 'select' ? this.children.find(c => !c.disabled)?.value : '') ?? ''; }
  set value(value) { this._value = value; }
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key]; }
  addEventListener(name, listener) { (this.listeners[name] ??= []).push(listener); }
  dispatch(name, target = this) { for (const callback of this.listeners[name] ?? []) callback({ target, preventDefault() {} }); if (this.parent) this.parent.dispatch(name, target); }
  click() { if (this.disabled) return; if (this.type === 'checkbox') { this.checked = !this.checked; this.dispatch('change'); } this.dispatch('click'); if (this.type === 'submit') this.parent.dispatch('submit'); }
  input(value) { this.value = value; this.dispatch('input'); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = undefined; }
  append(...children) { for (const child of children) { child.remove(); child.parent = this; this.children.push(child); } }
  insertBefore(child, before) { child.remove(); child.parent = this; this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child); }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); }
  descendants() { return this.children.flatMap(c => [c, ...c.descendants()]); }
  matches(selector) {
    const match = /^(\w+)?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(selector); if (!match) throw Error(`Unsupported selector: ${selector}`);
    if (match[1] && match[1] !== this.tag) return false;
    if (!match[2]) return true;
    const name = match[2]; const value = name.startsWith('data-') ? this.dataset[name.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] : this[name] ?? this.attrs[name];
    return match[3] === undefined ? value !== undefined : value === match[3];
  }
  querySelectorAll(selector) { return this.descendants().filter(c => selector.split(',').some(s => c.matches(s.trim()))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  reportValidity() { return this.querySelectorAll('input').every(i => !i.required || i.disabled || !!i.value.trim()); }
}
