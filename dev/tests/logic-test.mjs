/**
 * Head-less logic test for dsh-paste-packer's browser half.
 *
 * There is no browser control in this environment, so this harness stubs the
 * three host surfaces the module touches (`window`, `document`, `require`) plus
 * a minimal hook runtime, then drives the plugin the way DSH would:
 *
 *   - paste interception (threshold, file pastes, chip insert call shape)
 *   - the trigger source codec (clipboard form + send-time expansion)
 *   - the dock component (card, preview widen, expand, remove, fallbacks)
 *
 * Run:  node dev/tests/logic-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.resolve(here, '..', '..', 'client.js');

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
}

function assertEqual(name, actual, expected) {
  check(name, Object.is(actual, expected), 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}

// --------------------------------------------------------------- hook runtime
//
// React state lives per mounted component instance, so each mounted tree owns
// its own hook storage; sharing one global array would let one harness's render
// overwrite another's refs (which is exactly the bug this harness must not
// reintroduce).

function createHooks() {
  return { state: [], effects: [], pending: [], cursor: 0 };
}

let activeHooks = createHooks();

function depsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (!Object.is(a[index], b[index])) return false;
  }
  return true;
}

const React = {
  createElement(type, props, ...children) {
    return { __element: true, type, props: props || {}, children };
  },
  useState(initial) {
    const hooks = activeHooks;
    const index = hooks.cursor;
    hooks.cursor += 1;
    if (!(index in hooks.state)) hooks.state[index] = typeof initial === 'function' ? initial() : initial;
    const setter = (next) => {
      hooks.state[index] = typeof next === 'function' ? next(hooks.state[index]) : next;
    };
    return [hooks.state[index], setter];
  },
  useRef(initial) {
    const hooks = activeHooks;
    const index = hooks.cursor;
    hooks.cursor += 1;
    if (!(index in hooks.state)) hooks.state[index] = { current: initial };
    return hooks.state[index];
  },
  useEffect(effect, deps) {
    const hooks = activeHooks;
    const index = hooks.cursor;
    hooks.cursor += 1;
    const slot = hooks.effects[index];
    if (slot && depsEqual(slot.deps, deps)) return;
    hooks.effects[index] = { deps: deps ? [...deps] : null, cleanup: null };
    hooks.pending.push({ index, effect });
  },
};

// ------------------------------------------------------------------ fake DOM

function makeNode(type, props) {
  return {
    type,
    props: props || {},
    children: [],
    parentElement: null,
    isConnected: true,
    style: (props && props.style) || {},
    contains(other) {
      let walk = other;
      while (walk) {
        if (walk === this) return true;
        walk = walk.parentElement;
      }
      return false;
    },
    querySelector() {
      return null;
    },
    closest(selector) {
      let walk = this;
      while (walk) {
        if (selector === '[data-composer-input]' && walk.props && walk.props['data-composer-input'] !== undefined) return walk;
        walk = walk.parentElement;
      }
      return null;
    },
  };
}

function buildTree(element, parent) {
  if (element === null || element === undefined || element === false || element === true) return null;
  if (typeof element === 'string' || typeof element === 'number') {
    return { type: '#text', text: String(element), props: {}, children: [], parentElement: parent, isConnected: true };
  }
  if (Array.isArray(element)) {
    return element.map((child) => buildTree(child, parent)).filter(Boolean);
  }
  if (!element.__element) return null;
  const { type, props, children } = element;
  if (typeof type === 'function') return buildTree(type(props), parent);
  if (typeof type === 'string') {
    const node = makeNode(type, props);
    node.parentElement = parent;
    if (props && props.ref && typeof props.ref === 'object') props.ref.current = node;
    node.children = children.map((child) => buildTree(child, node)).flat(Infinity).filter(Boolean);
    return node;
  }
  return null;
}

function renderRoot(component, props, hooks = createHooks()) {
  activeHooks = hooks;
  hooks.cursor = 0;
  hooks.pending = [];
  const tree = buildTree(React.createElement(component, props), null);
  for (const entry of hooks.pending) {
    const cleanup = entry.effect();
    hooks.effects[entry.index].cleanup = typeof cleanup === 'function' ? cleanup : null;
  }
  return tree;
}

function walk(node, visit) {
  if (!node) return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

function findAll(root, predicate) {
  const found = [];
  walk(root, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}

function textOf(node) {
  if (!node) return '';
  if (node.type === '#text') return node.text;
  return (node.children || []).map(textOf).join('');
}

function buttonByLabel(tree, label) {
  return findAll(tree, (node) => node.type === 'button' && (node.props['aria-label'] === label || textOf(node) === label))[0];
}

// ---------------------------------------------------------------- host stubs

function makeLocalStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    _map: map,
  };
}

function makeHarness(options = {}) {
  const localStorage = makeLocalStorage();
  const documentListeners = [];
  const slots = [];
  const sources = [];
  const bailCalls = [];
  const sessionInputCalls = [];
  const actx = {
    bail(target, event, payload) {
      bailCalls.push({ target, event, payload });
      return options.bailResult === undefined ? true : options.bailResult;
    },
  };
  const sessionInput = {
    insertReference(reference, span) {
      sessionInputCalls.push({ reference, span });
      return options.serviceInsertResult === undefined ? true : options.serviceInsertResult;
    },
  };
  const ctx = {
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject(key, callback) {
        callback();
      },
      register(registration, component) {
        slots.push({ registration, component });
        return () => {};
      },
    },
    effect(effect) {
      return effect();
    },
    inject(deps, callback) {
      if (options.skipInject) return;
      callback(ctx);
    },
    inputTriggers: {
      registerSource(source) {
        sources.push(source);
        return () => {};
      },
    },
    conversation: { input: { for: () => sessionInput } },
    sessions: { binding: () => ({ ctx: actx }) },
  };

  const windowStub = {
    __ModuleLoader__: {
      load(definition) {
        windowStub.__definition = definition;
      },
    },
    localStorage,
  };
  const documentStub = {
    addEventListener(type, handler, capture) {
      documentListeners.push({ type, handler, capture: Boolean(capture) });
    },
    removeEventListener() {},
  };

  const source = fs.readFileSync(clientPath, 'utf8');
  const evaluate = new Function('window', 'document', 'console', 'require', source);
  evaluate(windowStub, documentStub, { warn() {}, error() {}, log() {} }, (name) => {
    if (name === 'react') return React;
    throw new Error('unexpected require: ' + name);
  });

  const definition = windowStub.__definition;
  const plugin = definition.factory((name) => (name === 'react' ? React : null));
  plugin.apply(ctx);

  return {
    definition,
    plugin,
    ctx,
    slots,
    sources,
    documentListeners,
    bailCalls,
    sessionInputCalls,
    localStorage,
  };
}

/**
 * Mount the dock for one harness and wire the ancestor chain so the paste
 * handler can resolve that composer's contenteditable.
 */
function mountDock(harness, stateRef, actions) {
  const input = makeNode('div', { 'data-composer-input': '' });
  const stack = makeNode('div', {});
  stack.querySelector = (selector) => (selector === '[data-composer-input]' ? input : null);
  const hooks = createHooks();
  const props = {
    session: { sessionId: 'session-1' },
    input: stateRef.value,
    useInput: (selector) => selector(stateRef.value),
    inputActions: actions,
  };
  const mounted = renderRoot(harness.slots[0].component, props, hooks);
  mounted.parentElement = stack;
  return {
    input,
    mounted,
    rerender() {
      props.input = stateRef.value;
      return renderRoot(harness.slots[0].component, props, hooks);
    },
  };
}

function pasteEvent(text, extra = {}) {
  const state = { defaultPrevented: false, stopped: false };
  const items = extra.items || [{ kind: 'string' }];
  const input = extra.input || makeNode('div', { 'data-composer-input': '' });
  return {
    state,
    event: {
      target: input,
      clipboardData: {
        items,
        getData: (type) => (type === 'text/plain' ? text : ''),
      },
      preventDefault() {
        state.defaultPrevented = true;
      },
      stopPropagation() {
        state.stopped = true;
      },
      get defaultPrevented() {
        return state.defaultPrevented;
      },
    },
  };
}

function longText(lines) {
  return Array.from({ length: lines }, (_, index) => 'line ' + (index + 1)).join('\n');
}

function actionsStub(overrides = {}) {
  return {
    insertTextCalls: [],
    setDraftCalls: [],
    captureInsertion: overrides.captureInsertion || (() => ({ start: 0, end: 0, draftRev: 7 })),
    insertText(text, span) {
      this.insertTextCalls.push({ text, span });
      return overrides.insertTextResult === undefined ? true : overrides.insertTextResult;
    },
    setDraft(text) {
      this.setDraftCalls.push(text);
    },
  };
}

function occurrenceFor(ref, label, offset) {
  return {
    occurrenceId: Number(ref) * 100 + offset,
    source: 'paste-packer',
    ref: String(ref),
    offset,
    length: label.length,
    label,
    clipboardText: label,
  };
}

// --------------------------------------------------------------------- tests

const harness = makeHarness();

// 1. module + install
assertEqual('module id', harness.definition.id, 'dsh-paste-packer');
check('plugin injects slots+locale', Array.isArray(harness.plugin.inject) && harness.plugin.inject.includes('slots'));
assertEqual('one slot registration', harness.slots.length, 1);
assertEqual('slot key', harness.slots[0].registration.name, 'conversation.input.dock');
assertEqual('slot id', harness.slots[0].registration.id, 'paste-packer');
assertEqual('one trigger source', harness.sources.length, 1);
assertEqual('source trigger', harness.sources[0].trigger, '/');
assertEqual('source name', harness.sources[0].name, 'paste-packer');
assertEqual('source group title hidden', harness.sources[0].showGroupTitle, false);
check('source has codec', Boolean(harness.sources[0].codec));
check('source has candidates+onPick', typeof harness.sources[0].candidates === 'function' && typeof harness.sources[0].onPick === 'function');
assertEqual('empty slash candidates', (await harness.sources[0].candidates()).length, 0);
assertEqual('one document listener', harness.documentListeners.length, 1);
assertEqual('listener is paste', harness.documentListeners[0].type, 'paste');
assertEqual('listener is capture', harness.documentListeners[0].capture, true);

// 2. mount the dock so the paste handler can resolve a composer
const inputActions = actionsStub();
const inputRef = { value: { draft: '', occurrences: [], draftRev: 7 } };
const view = mountDock(harness, inputRef, inputActions);
const pasteHandler = harness.documentListeners[0].handler;

// 3. short paste is left alone
const shortPaste = pasteEvent(longText(5), { input: view.input });
pasteHandler(shortPaste.event);
assertEqual('short paste not prevented', shortPaste.state.defaultPrevented, false);
assertEqual('short paste no chip', harness.bailCalls.length, 0);

// 4. exactly 20 lines is still left alone (the rule is "more than 20")
const twentyPaste = pasteEvent(longText(20), { input: view.input });
pasteHandler(twentyPaste.event);
assertEqual('20 lines not prevented', twentyPaste.state.defaultPrevented, false);
assertEqual('20 lines no chip', harness.bailCalls.length, 0);

// 5. file paste is left alone
const filePaste = pasteEvent(longText(40), { input: view.input, items: [{ kind: 'file' }] });
pasteHandler(filePaste.event);
assertEqual('file paste not prevented', filePaste.state.defaultPrevented, false);
assertEqual('file paste no chip', harness.bailCalls.length, 0);

// 6. long paste is packed
const longPaste = pasteEvent(longText(23), { input: view.input });
pasteHandler(longPaste.event);
assertEqual('long paste prevented', longPaste.state.defaultPrevented, true);
assertEqual('long paste propagation stopped', longPaste.state.stopped, true);
assertEqual('one chip insert', harness.bailCalls.length, 1);
assertEqual('chip event name', harness.bailCalls[0].event, 'slash/input-insert-reference');
const chip = harness.bailCalls[0].payload;
assertEqual('chip source', chip.reference.source, 'paste-packer');
assertEqual('chip ref', chip.reference.ref, '1');
assertEqual('chip label', chip.reference.label, '[已粘贴文本 #1 · 23 行]');
assertEqual('chip clipboard form', chip.reference.clipboardText, '[已粘贴文本 #1 · 23 行]');
assertEqual('chip appearance', chip.reference.appearance, 'file');
assertEqual('chip span revision', chip.span.draftRev, 7);

// 7. a second paste stacks as #2 and persists
const secondPaste = pasteEvent(longText(30), { input: view.input });
pasteHandler(secondPaste.event);
assertEqual('second chip ref', harness.bailCalls[1].payload.reference.ref, '2');
assertEqual('second chip label', harness.bailCalls[1].payload.reference.label, '[已粘贴文本 #2 · 30 行]');
const stored = JSON.parse(harness.localStorage.getItem('dsh-paste-packer.v1'));
assertEqual('two stored items', stored.items.length, 2);
assertEqual('stored counter', stored.counter, 2);

// 8. the codec expands at send time
const codec = harness.sources[0].codec;
assertEqual('codec clipboard text', codec.clipboardText('1'), '[已粘贴文本 #1 · 23 行]');
assertEqual('codec serialize returns original', await codec.serialize('1', new AbortController().signal), longText(23));
assertEqual('codec serialize second', await codec.serialize('2', new AbortController().signal), longText(30));
// unknown ref still resolves, so a send is never blocked
assertEqual('codec serialize unknown ref', await codec.serialize('999', new AbortController().signal), '[已粘贴文本 #999]');
assertEqual('codec clipboard unknown ref', codec.clipboardText('999'), '[已粘贴文本 #999]');

// 9. the card follows the chip occurrences
const label1 = '[已粘贴文本 #1 · 23 行]';
inputRef.value = { draft: label1, draftRev: 8, occurrences: [occurrenceFor(1, label1, 0)] };
let tree = view.rerender();
const card = findAll(tree, (node) => node.props.style && typeof node.props.style.width === 'string' && node.props.style.width.includes('100% -'))[0];
check('card present', Boolean(card));
assertEqual('card has three buttons', findAll(tree, (node) => node.type === 'button').length, 3);
check('card title is the chip label', textOf(tree).includes(label1));
assertEqual('collapsed card is not widened', findAll(tree, (node) => node.props.style && node.props.style.width === '140%').length, 0);
check('hidden wrapper while empty is not used', !(tree.props.style && tree.props.style.display === 'none'));
// The width rule must be the host's own dock-entry formula, or the card spills
// past the composer card (the defect this assertion locks down).
check('card insets itself like the host dock bar', /--dsh-composer-dock-inset/.test(card.props.style.width) && /--dsh-composer-side-clearance/.test(card.props.style.width), card.props.style.width);
check('card is capped by the composer width token', /--dsh-composer-card-max-width/.test(card.props.style.maxWidth), card.props.style.maxWidth);
assertEqual('card centers itself', card.props.style.margin, '0 auto');
check('card surface follows the host menu material', /var\(--dsw-specific-menu/.test(card.props.style.backgroundColor) && /var\(--dsw-elevation-panel/.test(card.props.style.boxShadow), card.props.style.backgroundColor);
assertEqual('card has no literal border', card.props.style.border, 0);
assertEqual('card row height matches the host dock bar', card.children[0].props.style.padding, '6px 12px');

// 10. the eye expands the preview IN PLACE: the geometry must not move
buttonByLabel(tree, '预览').props.onClick();
tree = view.rerender();
const opened = findAll(tree, (node) => node.props.style && typeof node.props.style.width === 'string' && node.props.style.width.includes('100% -'))[0];
check('card still present while open', Boolean(opened));
assertEqual('preview keeps the collapsed width', opened.props.style.width, card.props.style.width);
assertEqual('preview keeps the collapsed cap', opened.props.style.maxWidth, card.props.style.maxWidth);
assertEqual('preview keeps the same centering', opened.props.style.margin, '0 auto');
assertEqual('no state widens the card', findAll(tree, (node) => node.props.style && node.props.style.width === '140%').length, 0);
check('no state offsets the card', findAll(tree, (node) => node.props.style && (node.props.style.transform !== undefined || node.props.style.left !== undefined)).length === 0);
check('no state uses negative margins', opened.props.style.marginLeft === undefined && opened.props.style.marginRight === undefined);
const preview = findAll(tree, (node) => node.props.style && node.props.style.overflowY === 'auto');
assertEqual('preview body present', preview.length, 1);
assertEqual('preview scrolls', preview[0].props.style.overflowY, 'auto');
assertEqual('preview has a fixed height budget', preview[0].props.style.maxHeight, 180);
assertEqual('preview uses monospace', /monospace/.test(preview[0].props.style.fontFamily), true);
assertEqual('preview keeps line breaks', preview[0].props.style.whiteSpace, 'pre-wrap');
assertEqual('preview uses theme tokens', /var\(--dsw-alias-/.test(preview[0].props.style.color + preview[0].props.style.background), true);
check('preview renders the packed text', textOf(tree).includes('line 23'));
assertEqual('eye reports pressed', buttonByLabel(tree, '收起预览').props['aria-pressed'], 'true');

// 11. the eye closes again
buttonByLabel(tree, '收起预览').props.onClick();
tree = view.rerender();
assertEqual('preview body closed', findAll(tree, (node) => node.props.style && node.props.style.overflowY === 'auto').length, 0);
assertEqual('closing keeps the card', findAll(tree, (node) => node.props.style && typeof node.props.style.width === 'string' && node.props.style.width.includes('100% -')).length, 1);

// 12. the markdown subset renders as elements
const markdownHarness = makeHarness();
const markdownProbe = '# Title\n\n- a `x`\n- **b**\n\n```\ncode\n```\n\n> quote\n';
const markdownActions = actionsStub();
const markdownRef = { value: { draft: '', occurrences: [], draftRev: 3 } };
const markdownView = mountDock(markdownHarness, markdownRef, markdownActions);
markdownHarness.documentListeners[0].handler(
  pasteEvent(markdownProbe + longText(21), { input: markdownView.input }).event,
);
const markdownLabel = '[已粘贴文本 #1 · 25 行]';
markdownRef.value = { draft: markdownLabel, draftRev: 3, occurrences: [occurrenceFor(1, markdownLabel, 0)] };
let markdownTree = markdownView.rerender();
buttonByLabel(markdownTree, '预览').props.onClick();
markdownTree = markdownView.rerender();
assertEqual('markdown renders a heading block', findAll(markdownTree, (node) => node.props.style && node.props.style.fontSize === 15.5).length, 1);
assertEqual('markdown renders a list', findAll(markdownTree, (node) => node.type === 'ul').length, 1);
assertEqual('markdown renders two list items', findAll(markdownTree, (node) => node.type === 'li').length, 2);
assertEqual('markdown renders bold', findAll(markdownTree, (node) => node.type === 'strong').length, 1);
assertEqual('markdown renders a fence', findAll(markdownTree, (node) => node.type === 'pre').length, 1);
assertEqual(
  'markdown renders a quote',
  findAll(markdownTree, (node) => node.props.style && node.props.style.borderLeft === '3px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.34))').length,
  1,
);
check('markdown renders inline code', findAll(markdownTree, (node) => node.type === 'code').length >= 2);
check('inline markers are gone from the text', !textOf(markdownTree).includes('`x`') && !textOf(markdownTree).includes('**b**'));
check('fenced code body is verbatim', textOf(markdownTree).includes('code'));

// 13. expand replaces the occurrence span and never rewrites the draft
inputActions.insertTextCalls.length = 0;
inputActions.setDraftCalls.length = 0;
const expandButton = buttonByLabel(tree, '展开');
check('expand button present', Boolean(expandButton));
if (expandButton) expandButton.props.onClick();
check(
  'expand writes the full text once',
  inputActions.insertTextCalls.length === 1,
  'insertText=' + inputActions.insertTextCalls.length + ' setDraft=' + inputActions.setDraftCalls.length,
);
if (inputActions.insertTextCalls.length === 1) {
  assertEqual('expand inserts the original text', inputActions.insertTextCalls[0].text, longText(23));
  assertEqual('expand span start', inputActions.insertTextCalls[0].span.start, 0);
  assertEqual('expand span end', inputActions.insertTextCalls[0].span.end, label1.length);
  assertEqual('expand uses the live revision', inputActions.insertTextCalls[0].span.draftRev, 7);
}
assertEqual('expand never rewrites the draft', inputActions.setDraftCalls.length, 0);

// 14. remove writes an empty replacement over the span
const removeHarness = makeHarness();
const removeActions = actionsStub();
const removeRef = { value: { draft: '', occurrences: [], draftRev: 5 } };
const removeView = mountDock(removeHarness, removeRef, removeActions);
removeHarness.documentListeners[0].handler(pasteEvent(longText(30), { input: removeView.input }).event);
const removeLabel = '[已粘贴文本 #1 · 30 行]';
removeRef.value = { draft: removeLabel, draftRev: 5, occurrences: [occurrenceFor(1, removeLabel, 0)] };
buttonByLabel(removeView.rerender(), '删除').props.onClick();
assertEqual('remove writes once', removeActions.insertTextCalls.length, 1);
assertEqual('remove writes empty text', removeActions.insertTextCalls[0].text, '');
assertEqual('remove never rewrites the draft', removeActions.setDraftCalls.length, 0);

// 15. a rejected span edit falls back to a draft rewrite
const fallbackHarness = makeHarness();
const fallbackActions = actionsStub({ insertTextResult: false });
const fallbackRef = { value: { draft: '', occurrences: [], draftRev: 4 } };
const fallbackView = mountDock(fallbackHarness, fallbackRef, fallbackActions);
fallbackHarness.documentListeners[0].handler(pasteEvent(longText(21), { input: fallbackView.input }).event);
const fallbackLabel = '[已粘贴文本 #1 · 21 行]';
fallbackRef.value = { draft: fallbackLabel + ' tail', draftRev: 4, occurrences: [occurrenceFor(1, fallbackLabel, 0)] };
buttonByLabel(fallbackView.rerender(), '展开').props.onClick();
assertEqual('fallback rewrites the draft', fallbackActions.setDraftCalls.length, 1);
assertEqual('fallback spliced the full text over the placeholder', fallbackActions.setDraftCalls[0], longText(21) + ' tail');

// 16. without a registered codec the plugin pastes plainly instead of packing
const noSourceHarness = makeHarness({ skipInject: true });
assertEqual('no codec -> no trigger source', noSourceHarness.sources.length, 0);
const noSourceActions = actionsStub();
const noSourceRef = { value: { draft: '', occurrences: [], draftRev: 2 } };
const noSourceView = mountDock(noSourceHarness, noSourceRef, noSourceActions);
noSourceHarness.documentListeners[0].handler(pasteEvent(longText(40), { input: noSourceView.input }).event);
assertEqual('no codec -> no chip', noSourceHarness.bailCalls.length, 0);
assertEqual('no codec -> plain paste', noSourceActions.insertTextCalls.length, 1);
assertEqual('no codec -> full text pasted', noSourceActions.insertTextCalls[0].text, longText(40));

// 17. the service face is used when the bail event does not apply
const serviceHarness = makeHarness({ bailResult: false });
const serviceActions = actionsStub();
const serviceRef = { value: { draft: '', occurrences: [], draftRev: 2 } };
const serviceView = mountDock(serviceHarness, serviceRef, serviceActions);
serviceHarness.documentListeners[0].handler(pasteEvent(longText(25), { input: serviceView.input }).event);
assertEqual('service fallback attempted once', serviceHarness.sessionInputCalls.length, 1);
assertEqual('service fallback reference source', serviceHarness.sessionInputCalls[0].reference.source, 'paste-packer');
assertEqual('service fallback keeps the text out of the editor', serviceActions.insertTextCalls.length, 0);

// 18. a paste outside the composer is never touched
const outsideHarness = makeHarness();
const outsideActions = actionsStub();
const outsideRef = { value: { draft: '', occurrences: [], draftRev: 1 } };
mountDock(outsideHarness, outsideRef, outsideActions);
const outsider = pasteEvent(longText(50));
outsideHarness.documentListeners[0].handler(outsider.event);
assertEqual('outsider paste not prevented', outsider.state.defaultPrevented, false);
assertEqual('outsider paste no chip', outsideHarness.bailCalls.length, 0);

// ---------------------------------------------------------------- reporting

console.log('passed: ' + passed);
if (failures.length > 0) {
  console.log('failed: ' + failures.length);
  for (const failure of failures) console.log('  - ' + failure);
  process.exit(1);
}
console.log('all checks passed');
