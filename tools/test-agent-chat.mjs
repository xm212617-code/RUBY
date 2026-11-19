import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/agent-chat.js', import.meta.url), 'utf8');

async function fixture() {
    let mode = true, busy = false;
    const handlers = new Map(), nodes = new Map(), sent = [], notices = [];
    let stops = 0;
    const inputRow = { insertBefore() { throw Error('Agent badge must never enter the textarea flex row'); } };
    const textarea = { value: '', dispatchEvent() {}, parentElement: inputRow };
    const form = { parentElement: { insertBefore(node, before) {
        assert.equal(before, form); node.parentElement = this; nodes.set(node.id, node);
    } } };
    const c = { shouldSendOnEnter: () => true };
    const doc = {
        addEventListener: (type, fn, capture) => { assert.equal(capture, true); handlers.set(type, fn); },
        removeEventListener: (type) => handlers.delete(type),
        querySelector: (selector) => selector === '#send_textarea' ? textarea : selector === '#send_form' ? form : null,
        querySelectorAll: () => [], getElementById: (id) => nodes.get(id),
        createElement: () => ({ dataset: {}, setAttribute() {}, remove() {} }),
    };
    const controller = { getState: () => ({ mode: mode ? 'agent' : 'steps', running: busy, phase: 'Read' }),
        submit: async (text) => sent.push(text), stop: () => stops++, onStateChange: () => () => {} };
    const context = vm.createContext({ Event: class {}, console });
    const mod = new vm.SourceTextModule(source, { context });
    const deps = { './env.js': { ctx: () => c }, './agent-controller.js': { agentController: controller }, './agent-mode.js': { isAgentMode: () => mode } };
    await mod.link((specifier) => {
        const values = deps[specifier];
        return new vm.SyntheticModule(Object.keys(values), function () { for (const [key, val] of Object.entries(values)) this.setExport(key, val); }, { context });
    });
    await mod.evaluate();
    const cleanup = mod.namespace.installAgentChat({ document: doc, getContext: () => c, controller, notify: (s) => notices.push(s) });
    const event = (target, extra = {}) => ({ target, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra });
    const click = (id) => { const e = event({ closest: () => ({ id }) }); handlers.get('click')(e); return e; };
    return { api: mod.namespace, context, c, textarea, form, nodes, sent, notices, click, handlers, event, cleanup,
        setMode: (v) => { mode = v; }, setBusy: (v) => { busy = v; }, get stops() { return stops; } };
}

test('Agent indicator is outside the native textarea row and never consumes its flex width', async () => {
    const h = await fixture();
    const badge = h.nodes.get('ruby-agent-composer-badge');
    assert.ok(badge);
    assert.equal(badge.parentElement, h.form.parentElement);
    assert.notEqual(badge.parentElement, h.textarea.parentElement);
    assert.equal(badge.hidden, false);
});

test('composer indicator is red and says waiting while busy, green and says ready when idle', async () => {
    const h = await fixture();
    const busy = h.api.getAgentComposerStatus({ mode: 'agent', running: true, phase: '请求模型' });
    assert.equal(busy.tone, 'busy'); assert.match(busy.text, /等待回复/);
    const reading = h.api.getAgentComposerStatus({ mode: 'agent', running: true, phase: '读取操作范围' });
    assert.equal(reading.tone, 'busy'); assert.match(reading.text, /读取操作范围/);
    const idle = h.api.getAgentComposerStatus({ mode: 'agent', running: false, phase: '已完成' });
    assert.equal(idle.tone, 'idle'); assert.match(idle.text, /空闲.*输入并发送/);
    assert.equal(h.api.getAgentComposerStatus({ mode: 'steps' }).tone, 'off');
});

test('native send button is intercepted before roleplay even for slash text, empty input or busy state', async () => {
    const h = await fixture();
    h.textarea.value = '/gen Do not execute';
    const e = h.click('send_but');
    assert.equal(e.stopped, true); assert.equal(e.prevented, true);
    assert.deepEqual(h.sent, ['/gen Do not execute']); assert.equal(h.textarea.value, '');
    h.click('send_but'); assert.equal(h.sent.length, 1);
    h.setBusy(true); h.textarea.value = 'Keep draft';
    assert.equal(h.click('send_but').stopped, true); assert.equal(h.textarea.value, 'Keep draft');
    h.click('mes_stop'); assert.equal(h.stops, 1);
    h.setMode(false); assert.equal(h.click('send_but').stopped, undefined);
    h.cleanup(); assert.equal(h.handlers.size, 0);
});

test('keyboard policy preserves newlines, IME, popup actions and message editing', async () => {
    const h = await fixture(); const key = h.api.agentKeyAction;
    const base = { composer: true, hasText: true, sendOnEnter: true };
    assert.equal(key({ key: 'Enter' }, base), 'send');
    assert.equal(key({ key: 'Enter', metaKey: true }, base), 'send');
    assert.equal(key({ key: 'ArrowRight' }, { inputFocus: false, hasText: false }), 'blocked');
    assert.equal(key({ key: 'ArrowLeft' }, { inputFocus: true, hasText: false }), null);
    assert.equal(key({ key: 'Enter', shiftKey: true }, base), null);
    assert.equal(key({ key: 'Enter' }, { ...base, sendOnEnter: false }), null);
    assert.equal(key({ key: 'Enter', ctrlKey: true }, base), 'send');
    assert.equal(key({ key: 'Enter', ctrlKey: true }, { ...base, hasText: false }), 'blocked');
    assert.equal(key({ key: 'Enter', ctrlKey: true }, { ...base, editing: true }), null);
    assert.equal(key({ key: 'Enter', altKey: true }, base), 'blocked');
    assert.equal(key({ key: 'Enter', isComposing: true }, base), null);
    assert.equal(key({ key: 'Enter', isComposing: true, ctrlKey: true }, base), 'composition');
    assert.equal(key({ key: 'Enter' }, { ...base, popup: true }), null);
});

test('native Enter is sent once, while regeneration paths and duplicate roleplay sends stay blocked', async () => {
    const h = await fixture();
    h.textarea.value = 'Task';
    const e = h.event(h.textarea, { key: 'Enter' }); h.handlers.get('keydown')(e);
    assert.equal(e.stopped, true); assert.deepEqual(h.sent, ['Task']);
    assert.equal(h.click('option_regenerate').prevented, true);
    assert.equal(h.click('option_continue').stopped, true);
    let aborted = false;
    h.context.rubyAgentGenerationInterceptor([], 0, (immediate) => { aborted = immediate; });
    assert.equal(aborted, true);
    h.setMode(false); aborted = false;
    h.context.rubyAgentGenerationInterceptor([], 0, () => { aborted = true; });
    assert.equal(aborted, false);
});
