import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { buildSexCombatRegexScripts, normalizeSexCombatConfig } from '../src/scripts/sex-combat.js';
import { buildSexCombatDocument, renderSexCombatContent } from '../src/scripts/sex-combat-view.js';

const root = new URL('../', import.meta.url);
const cache = new Map();
const context = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval, structuredClone, Map, Set });
const env = new vm.SyntheticModule(['ctx', 'warn', 'h'], function () { this.setExport('ctx', () => null); this.setExport('warn', () => {}); this.setExport('h', (text) => String(text)); }, { context });
const config = new vm.SyntheticModule(['resolveConfig'], function () { this.setExport('resolveConfig', () => ({})); }, { context });
const book = new vm.SyntheticModule(['readVerifiedEntries', 'writeVerifiedEntry'], function () { this.setExport('readVerifiedEntries', () => { throw Error('unexpected real read'); }); this.setExport('writeVerifiedEntry', () => { throw Error('unexpected real write'); }); }, { context });
async function load(url) {
    const id = String(url);
    if (cache.has(id)) return cache.get(id);
    const mocked = id.endsWith('/env.js') ? env : id.endsWith('/config.js') ? config : id.endsWith('/worldbook.js') ? book : null;
    if (mocked) { cache.set(id, mocked); return mocked; }
    const module = new vm.SourceTextModule(readFileSync(url, 'utf8'), { context, identifier: id });
    cache.set(id, module);
    await module.link((specifier) => load(new URL(specifier, id)));
    return module;
}
const module = await load(new URL('src/scripts/sex-combat-runtime.js', root));
await module.evaluate();
const { createScriptRuntime, parseSexCombatReport } = module.namespace;
const KEY = 'RUBY_UniversalSexCombat_';
const scene = (report = '', names = ['A'], grade = 'NSFWH') => `<SceneInfo>\n场景类型: ${grade}\n在场角色:\n${names.map((name) => '- ' + name + '|普通').join('\n')}\n</SceneInfo>\n${report}`;
const action = '<report>\nuser:\n  单向: 1\n  双向: 0\n</report>';

test('complete standalone panel renders dashboard data and its read-only bridge script', () => {
    const state = {
        round: 4, p: 62, user: { pos: 28, ex: 45, lv: 2 },
        opps: [{ name: 'Opponent <A>', pos: 73, p: 48, ex: 82, lv: 3, exited: false }],
        ended: null,
    };
    const dashboard = renderSexCombatContent({ state, levels: { user: 25, 'Opponent <A>': 50 } });
    assert.match(dashboard, /高潮战况|情潮战况/);
    assert.match(dashboard, /Opponent &lt;A&gt;/);
    assert.match(dashboard, /62/);
    assert.match(dashboard, /82\/100/);
    assert.match(dashboard, /4\/10/);
    assert.match(dashboard, /疲软倒计时/);

    const document = buildSexCombatDocument({ marker: 'xingdou' });
    assert.match(document, /^<!doctype html>[\s\S]*<style>[\s\S]*sc-board[\s\S]*<\/style>/);
    assert.match(document, /data-ruby-sex-combat="true"/);
    assert.match(document, /ruby-sex-combat-view-request/);
    const script = document.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Function(script));
    assert.doesNotMatch(script, /settle|Math\.random\(\).*roll/i, 'the view bridge only requests and displays host state');
});

function host(options = {}) {
    const entries = new Map(Object.entries(options.entries || {}));
    const writes = [], reads = [], listeners = new Map(), errors = [];
    let cfg = { enabled: true, defaultJudgment: true, trigger: { tag: 'SceneInfo', field: '场景类型', value: 'NSFWH' }, roster: { tag: 'SceneInfo', field: '在场角色' }, actionTag: 'report', markerAnchor: 'report', markerPlacement: 'after-anchor-end', ...options.config };
    const marker = options.config?.marker || 'xingdou';
    const pattern = `/<\\/${marker}\\s*>/gi`;
    const regexScripts = options.regexScripts === false ? [] : buildSexCombatRegexScripts([], { enabled: true, marker, markerAnchor: 'report' });
    let c = { chatId: 'chat-1', characterId: 0, groupId: null, chatMetadata: {}, extensionSettings: { disabledExtensions: [], character_allowed_regex: ['card.png'] }, characters: [{ avatar: 'card.png', data: { extensions: { regex_scripts: regexScripts } } }], chat: options.chat || [{ mes: scene(action) }] };
    let stopCalls = 0;
    const events = {
        on(type, fn) { const list = listeners.get(type) || new Set(); list.add(fn); listeners.set(type, list); },
        removeListener(type, fn) { listeners.get(type)?.delete(fn); },
        async emit(type, ...args) { for (const fn of listeners.get(type) || []) await fn(...args); },
    };
    c.eventSource = events;
    c.eventTypes = Object.fromEntries(['CHAT_CHANGED', 'CHARACTER_SELECTED', 'MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'GENERATION_AFTER_COMMANDS', 'GENERATE_AFTER_DATA', 'GENERATION_ENDED', 'GENERATION_STOPPED'].map((name) => [name, name]));
    c.stopGeneration = () => stopCalls++;
    c.saveChat = () => {};
    c.updateMessageBlock = () => {};
    let failKey, hook;
    const viewReplies = [], pageListeners = new Map();
    const trustedFrame = { isConnected: true, getAttribute: () => 'data-ruby-sex-combat="true"', contentWindow: { postMessage: (...args) => viewReplies.push(args) } };
    const page = {
        eventSource: events,
        eventTypes: c.eventTypes,
        getContext: () => c,
        document: { querySelectorAll: (selector) => selector === '#chat .mes .mes_text iframe' ? [trustedFrame] : [] },
        addEventListener(type, listener) { pageListeners.set(type, listener); },
        removeEventListener(type) { pageListeners.delete(type); },
    };
    const deps = {
        getContext: () => c,
        getConfig: () => ({ layer: 'character', data: { cardScripts: cfg === null ? {} : { 'sex-combat': cfg } } }),
        host: page, poll: false, random: options.random || (() => 0), onError: (...args) => errors.push(args),
        async read(_book, key, { all }, session) {
            session.guard(); reads.push(key);
            if (options.failRead) throw Error('read failed');
            return [...entries].filter(([name]) => all ? name.startsWith(key) : name === key).map(([name, entry]) => ({ keys: [name], content: typeof entry === 'string' ? entry : entry.content, constant: entry.constant || false, disabled: entry.disable ?? true }));
        },
        async write(_book, data, session) {
            session.guard();
            if (hook) await hook(data);
            session.guard();
            writes.push(structuredClone(data));
            if (data.key === failKey) { failKey = null; throw Error('write failed'); }
            entries.set(data.key, structuredClone(data));
            return { book: 'fake-chat-book', uid: writes.length, created: true };
        },
    };
    let runtime = createScriptRuntime(deps);
    return { get c() { return c; }, set c(value) { c = value; }, get cfg() { return cfg; }, set cfg(value) { cfg = value; }, page, pageListeners, trustedFrame, viewReplies, events, listeners, entries, writes, reads, errors, get stopCalls() { return stopCalls; }, get runtime() { return runtime; }, reload() { runtime.dispose(); runtime = createScriptRuntime(deps); return runtime; }, fail(key) { failKey = key; }, setHook(fn) { hook = fn; } };
}

test('report parser rejects duplicate keys, duplicate actors, fenced examples and caps actions', () => {
    assert.equal(parseSexCombatReport('```xml\n' + action + '\n```'), null);
    assert.equal(parseSexCombatReport(action + action), null);
    assert.equal(parseSexCombatReport('<report>\nuser:\n  单向: 1\n  单向: 2\n</report>'), null);
    assert.equal(parseSexCombatReport('<report>\nuser:\n  单向: 1\nuser:\n  双向: 1\n</report>'), null);
    assert.equal(parseSexCombatReport('<x>\nuser:\n  双向: 99\n</x>', 'x').user.双向, 2);
});

test('card config is required; missing card does not touch county state or worldbooks', async () => {
    const h = host(); h.cfg = null;
    await h.runtime.tick();
    assert.equal(h.reads.length, 0); assert.equal(h.writes.length, 0);
    assert.equal(Object.hasOwn(h.page, '__countyCombatSessions'), false);
});

test('explicit config without matching installed Regex never starts or touches county records', async () => {
    const legacy = { state: { unchanged: true }, levels: { A: 17 }, pending: false, queue: Promise.resolve() };
    const h = host({ regexScripts: false, entries: {
        '通用性斗_当局': { content: 'county-state', constant: false, disable: true },
        '通用性斗_默认判断': { content: 'county-rule', constant: true, disable: false },
    } });
    h.page.__countyCombatSessions = new Map([['county-session', legacy]]);
    await h.runtime.tick();
    assert.equal(h.reads.length, 0); assert.equal(h.writes.length, 0);
    assert.equal(h.runtime.snapshot(), null);
    assert.equal(h.page.__countyCombatSessions.get('county-session'), legacy);
    assert.deepEqual(h.entries.get('通用性斗_当局'), { content: 'county-state', constant: false, disable: true });
    assert.deepEqual(h.entries.get('通用性斗_默认判断'), { content: 'county-rule', constant: true, disable: false });
    assert.ok([...h.entries.keys()].every((key) => !key.startsWith(KEY)));
});

test('missing report starts round zero, publishes protocol and supports same-floor completion', async () => {
    const countyState = { content: 'county-state', constant: false, disable: true };
    const countyRule = { content: 'county-rule', constant: true, disable: false };
    const h = host({ chat: [{ mes: scene() }], entries: { '通用性斗_当局': countyState, '通用性斗_默认判断': countyRule } });
    await h.runtime.tick();
    assert.equal(h.runtime.snapshot().state.round, 0);
    assert.deepEqual(h.entries.get('通用性斗_当局'), countyState);
    assert.deepEqual(h.entries.get('通用性斗_默认判断'), countyRule);
    assert.ok(h.reads.every((key) => key.startsWith(KEY)));
    assert.ok(h.writes.every((entry) => entry.key.startsWith(KEY)));
    assert.equal(h.entries.get(KEY + 'report协议').constant, true);
    assert.equal(h.entries.get(KEY + 'report协议').position, 4);
    assert.equal(h.entries.get(KEY + 'report协议').depth, 0);
    const count = h.writes.length;
    await h.runtime.tick(); assert.equal(h.writes.length, count, 'stable polls do no writes');
    h.c.chat[0].mes += action;
    await h.runtime.tick(); assert.equal(h.runtime.snapshot().state.round, 1);
    assert.equal(h.runtime.snapshot().state.opps[0].pos, 100, 'severe miss does not push');
});

test('one report settles once across duplicate events, swipe, edits and a new runtime', async () => {
    const h = host(); await h.runtime.tick();
    assert.equal(h.runtime.snapshot().state.round, 1);
    await h.runtime.tick();
    h.c.chat[0].swipe_id = 1; h.c.chat[0].mes = scene(action.replace('单向: 1', '单向: 3'));
    await h.runtime.tick(); assert.equal(h.runtime.snapshot().state.round, 1);
    await h.reload().tick(); assert.equal(h.runtime.snapshot().state.round, 1);
    assert.equal(h.entries.get(KEY + '当局').constant, false);
});

test('ten action rounds finish once, retain XP through disable and empty chat', async () => {
    const h = host(); await h.runtime.tick();
    for (let i = 1; i < 10; i++) { h.c.chat.push({ mes: scene(action) }); await h.runtime.tick(); }
    let snapshot = h.runtime.snapshot();
    assert.equal(snapshot.state.ended.type, 'flaccid'); assert.equal(snapshot.levels.user, 10); assert.equal(snapshot.levels.A, 20);
    await h.reload().tick(); assert.equal(h.runtime.snapshot().levels.A, 20);
    const terminal = h.entries.get(KEY + '收场_疲软收场'); assert.equal(terminal.constant, true);
    h.cfg.enabled = false; await h.runtime.tick();
    assert.equal(h.runtime.snapshot().state, null);
    assert.equal(h.entries.get(KEY + '收场_疲软收场').constant, false);
    assert.equal(h.entries.get(KEY + '收场_疲软收场').disable, true);
    assert.equal(h.runtime.snapshot().levels.A, 20);
    h.c.chat = []; h.cfg.enabled = true; await h.runtime.tick(); assert.equal(h.runtime.snapshot().levels.A, 20);
});

test('no-action scenes never advance fatigue; user plus six opponents maximum', async () => {
    const h = host({ chat: [{ mes: scene('', ['A', 'B', 'C', 'D', 'E', 'F', 'G']) }] });
    await h.runtime.tick(); assert.equal(h.runtime.snapshot().state.opps.length, 6);
    for (let i = 0; i < 12; i++) { h.c.chat.push({ mes: scene() }); await h.runtime.tick(); }
    assert.equal(h.runtime.snapshot().state.round, 0); assert.equal(h.runtime.snapshot().state.active, true);
});

test('disabled cleanup only affects owned primary entries, never user records or XP', async () => {
    const h = host({ config: { enabled: false }, entries: {
        [KEY + '战况']: { content: 'stale', constant: true, disable: false },
        [KEY + '收场_对手高潮_A']: { content: 'old', constant: true, disable: false },
        [KEY + '经验总档']: '  user: 25\n  A: 50',
        ['我的世界书']: { content: 'keep', constant: true, disable: false },
    } });
    await h.runtime.tick();
    assert.equal(h.entries.get(KEY + '战况').disable, true); assert.equal(h.entries.get(KEY + '战况').content, '');
    assert.equal(h.entries.get(KEY + '收场_对手高潮_A').disable, true);
    assert.equal(h.entries.get(KEY + '经验总档'), '  user: 25\n  A: 50');
    assert.equal(h.entries.get('我的世界书').content, 'keep');
});

test('write failure retries checkpoint without reroll or duplicate round', async () => {
    let rolls = 0;
    const h = host({ random: () => { rolls++; return 0; } });
    h.fail(KEY + '战况'); await assert.rejects(h.runtime.tick(), /write failed/);
    const alreadyRolled = rolls;
    assert.equal(h.runtime.snapshot().state.round, 1);
    await h.runtime.tick(); assert.equal(rolls, alreadyRolled); assert.equal(h.runtime.snapshot().state.round, 1);
    assert.equal(h.entries.get(KEY + '战况').constant, true);
});

test('strict read error never overwrites a presumed empty ledger', async () => {
    const h = host({ failRead: true });
    await assert.rejects(h.runtime.tick(), /read failed/); assert.equal(h.writes.length, 0);
});

test('chat and character guards reject an in-flight write before crossing identity', async () => {
    const h = host();
    h.setHook(async () => { h.c = { ...h.c, chatId: 'chat-2', chatMetadata: {} }; });
    await assert.rejects(h.runtime.tick(), /chat or character changed/); assert.equal(h.writes.length, 0);
    h.setHook(null); h.c.chat = [{ mes: scene() }];
    await h.runtime.tick(); assert.equal(h.runtime.snapshot().state.round, 0);
});

test('host listeners register once without inspecting or mutating the county registry', async () => {
    const h = host(); let removed = 0;
    const old = { state: null, levels: {}, pending: false, frames: new Set(), queue: Promise.resolve(), unsubscribe() { removed++; } };
    h.page.__countyCombatSessions = new Map();
    h.page.__countyCombatSessions.set(JSON.stringify([h.c.characterId, h.c.groupId, h.c.chatId]), old);
    h.page.__countyCombatSessions.set('unrelated-chat', { sentinel: true });
    const countySessions = [...h.page.__countyCombatSessions];
    h.runtime.init(); h.runtime.init(); await h.runtime.tick();
    assert.equal(h.listeners.get('GENERATION_AFTER_COMMANDS').size, 1); assert.equal(removed, 0); assert.equal(old.pending, false);
    assert.deepEqual([...h.page.__countyCombatSessions], countySessions);
    h.runtime.dispose(); assert.equal(h.listeners.get('GENERATION_AFTER_COMMANDS').size, 0);
});

test('complete HTML panel bridge returns live snapshot only to a trusted owned iframe', async () => {
    const h = host({ chat: [{ mes: scene('') }] });
    const card = h.c.characters[0];
    h.cfg = normalizeSexCombatConfig({ ...h.cfg, enabled: true, trigger: { ...h.cfg.trigger, value: 'NSFWH' } });
    h.c.chat = [{ mes: scene('', ['A']) }];
    card.data.extensions.regex_scripts = buildSexCombatRegexScripts([], h.cfg);
    h.runtime.init();
    await h.runtime.tick();
    assert.equal(h.runtime.snapshot()?.state?.active, true, 'trigger scene opens a live battle before panel query');
    assert.equal(h.runtime.snapshot()?.scene?.triggered, true, 'runtime stores trigger scene for initial panel view');
    assert.equal(h.runtime.snapshot()?.scene?.valid, true, `trigger scene is valid for panel view: ${JSON.stringify(h.runtime.snapshot()?.scene)}`);
    const listener = [...h.pageListeners.values()][0];
    if (typeof listener !== 'function') { h.runtime.dispose(); return assert.fail('runtime should install its iframe bridge listener for the card Regex'); }
    listener({
        data: { type: 'ruby-sex-combat-view-request', nonce: 'nonce-1' },
        source: h.trustedFrame.contentWindow,
        origin: 'null',
    });
    assert.equal(h.viewReplies.length, 1);
    assert.equal(h.viewReplies[0][1], '*', 'opaque srcdoc frames receive a reply with null origin target');
    assert.equal(h.viewReplies[0][0].nonce, 'nonce-1');
    assert.match(h.viewReplies[0][0].html, /sc-board/, `live panel markup (snapshot=${JSON.stringify(h.runtime.snapshot())})`);
    assert.match(h.viewReplies[0][0].html, /NSFWH 场景已识别，等待本楼有效行动报告；当前为 0 \/ 10 轮/);
    assert.match(h.viewReplies[0][0].html, /P 1/);
    assert.match(h.viewReplies[0][0].html, /A兴奋/);
    assert.match(h.viewReplies[0][0].html, /疲软倒计时/);
    assert.doesNotMatch(h.viewReplies[0][0].html, /<script/i);
    h.pageListeners.clear();
    const hostile = { postMessage() { throw Error('untrusted source must not receive status'); } };
    listener({ data: { type: 'ruby-sex-combat-view-request', nonce: 'bad' }, source: hostile, origin: 'null' });
    assert.equal(h.viewReplies.length, 1);
});

test('terminal injection waits for a successful generated reply and survives API failure', async () => {
    const h = host(); h.runtime.init(); await h.runtime.tick();
    for (let i = 1; i < 10; i++) { h.c.chat.push({ mes: scene(action) }); await h.runtime.tick(); }
    await h.events.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    await h.events.emit('GENERATE_AFTER_DATA', {}, false);
    await h.events.emit('GENERATION_ENDED');
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(h.entries.get(KEY + '收场_疲软收场').constant, true);
    await h.events.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    await h.events.emit('GENERATE_AFTER_DATA', {}, false);
    h.c.chat.push({ mes: scene('', ['A'], 'NSFW') });
    await h.events.emit('MESSAGE_RECEIVED', h.c.chat.length - 1, 'normal');
    assert.equal(h.entries.get(KEY + '收场_疲软收场').disable, true);
    assert.equal(h.runtime.snapshot().levels.A, 20);
    h.runtime.dispose();
});

test('custom trigger, actor list, action tag and host marker work without opening panel', async () => {
    const text = '<Game>\n模式: ACTIVE\n角色:\n- B\n</Game>\n<moves>\nuser:\n  单向: 1\n</moves>';
    const h = host({ config: { trigger: { tag: 'Game', field: '模式', value: 'ACTIVE' }, roster: { tag: 'Game', field: '角色' }, actionTag: 'moves', marker: 'done', markerAnchor: 'moves' }, chat: [{ mes: text }] });
    h.runtime.init(); await h.runtime.tick();
    assert.match(h.c.chat[0].mes, /<\/moves>\s*<\/done>/);
    assert.equal(h.runtime.snapshot().state.opps[0].name, 'B'); assert.equal(h.runtime.snapshot().state.round, 1);
    assert.match(h.entries.get(KEY + 'report协议').content, /<moves>/);
    h.runtime.dispose();
});

function checkpoint(overrides = {}, levels = { user: 0, A: 0 }) {
    return JSON.stringify({ version: 3, levels, lockedThrough: -1, receipts: {}, scan: 0, state: {
        active: true, battleId: 'fixture', startFloor: 0, lastSettledFloor: -1, scanFloor: 0, round: 0, p: 50,
        nsfwhFloors: [], user: { pos: 0, ex: 0, lv: 0 }, opps: [{ name: 'A', pos: 100, p: 50, ex: 0, lv: 0, present: true, exited: false }], ended: null, ...overrides,
    } });
}

test('two-way action shares one validity roll with independent result dice in both directions', async () => {
    const draws = [0.6, 0.99, 0, 0.99, 0]; let index = 0;
    const h = host({ random: () => { assert.ok(index < draws.length, 'exactly one validity roll and two result rolls'); return draws[index++]; }, entries: { [KEY + '当局']: checkpoint() }, chat: [{ mes: scene(action.replace('单向: 1', '单向: 0').replace('双向: 0', '双向: 1')) }] });
    await h.runtime.tick(); const state = h.runtime.snapshot().state;
    assert.equal(index, 5); assert.equal(state.user.pos, 5); assert.equal(state.opps[0].pos, 95);
    assert.equal(state.user.ex, 2); assert.equal(state.opps[0].ex, 2);
});

test('partial miss halves dice count upward and then halves all charge upward', async () => {
    const draws = [0, 0.99, 0.99, 0, 0]; let index = 0;
    const h = host({ random: () => { assert.ok(index < draws.length); return draws[index++]; }, entries: { [KEY + '当局']: checkpoint({ user: { pos: 0, ex: 0, lv: 3 } }, { user: 50, A: 0 }) } });
    await h.runtime.tick(); const state = h.runtime.snapshot().state;
    assert.equal(index, 5); assert.equal(state.opps[0].pos, 89); assert.equal(state.opps[0].ex, 3);
    assert.match(state.results[0], /部分失手/);
});

test('severe two-way miss has no push, no charge, only ordinary cooldown', async () => {
    let rolls = 0;
    const h = host({ random: () => { rolls++; return 0; }, entries: { [KEY + '当局']: checkpoint({ user: { pos: 0, ex: 17, lv: 0 } }) }, chat: [{ mes: scene(action.replace('单向: 1', '单向: 0').replace('双向: 0', '双向: 1')) }] });
    await h.runtime.tick(); const state = h.runtime.snapshot().state;
    assert.equal(rolls, 1); assert.equal(state.user.pos, 0); assert.equal(state.opps[0].pos, 100);
    assert.equal(state.user.ex, 15); assert.equal(state.opps[0].ex, 0);
});

test('stage three gives +10 while stages four and five give -10 to validity', async () => {
    for (const [ex, verdict] of [[40, '得手'], [60, '部分失手'], [80, '部分失手']]) {
        const h = host({ random: () => 0.54, entries: { [KEY + '当局']: checkpoint({ user: { pos: 0, ex, lv: 0 } }) } });
        await h.runtime.tick(); assert.match(h.runtime.snapshot().state.results[0], new RegExp(verdict));
    }
});

test('terminal XP applies to all participants by encounter floors, once after reload', async () => {
    const h = host({ random: () => 0.99, entries: { [KEY + '当局']: checkpoint({ nsfwhFloors: [0, 1, 2], user: { pos: 49, ex: 0, lv: 0 }, opps: [{ name: 'A', pos: 100, p: 50, lv: 0, ex: 0, present: true, exited: false }, { name: 'B', pos: 100, p: 50, lv: 0, ex: 0, present: true, exited: false }] }, { user: 24, A: 52, B: 10 }) }, chat: [{ mes: scene('<report>\nA:\n  单向: 1\n</report>', ['A', 'B']) }] });
    await h.runtime.tick();
    assert.equal(h.runtime.snapshot().state.ended.type, 'user');
    assert.deepEqual(JSON.parse(JSON.stringify(h.runtime.snapshot().levels)), { user: 27, A: 55, B: 13 });
    await h.reload().tick();
    assert.deepEqual(JSON.parse(JSON.stringify(h.runtime.snapshot().levels)), { user: 27, A: 55, B: 13 });
});

test('generation preparation failure explicitly stops generation and retries the same round', async () => {
    const h = host({ chat: [{ mes: scene() }] }); h.runtime.init(); await h.runtime.tick();
    h.c.chat[0].mes += action; h.fail(KEY + '当局');
    await assert.rejects(h.events.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false), /write failed/);
    assert.equal(h.stopCalls, 1); assert.equal(h.runtime.snapshot().state.round, 1);
    await h.events.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    assert.equal(h.runtime.snapshot().state.round, 1); h.runtime.dispose();
});

test('stopped or aborted generation cannot consume terminal entries or settle partial text', async () => {
    for (const mode of ['signal', 'stream', 'stop']) {
        const h = host({ entries: { [KEY + '当局']: checkpoint({ round: 9 }) } });
        h.runtime.init(); await h.runtime.tick();
        const signal = { aborted: false };
        await h.events.emit('GENERATION_AFTER_COMMANDS', 'normal', { signal }, false);
        await h.events.emit('GENERATE_AFTER_DATA', {}, false);
        if (mode === 'signal') signal.aborted = true;
        if (mode === 'stream') h.c.streamingProcessor = { isFinished: true, abortController: { signal: { aborted: true } } };
        h.c.chat.push({ mes: scene(action) });
        if (mode === 'stop') await h.events.emit('GENERATION_STOPPED');
        await h.events.emit('MESSAGE_RECEIVED', 1, 'normal');
        assert.equal(h.entries.get(KEY + '收场_疲软收场').constant, true);
        assert.equal(h.runtime.snapshot().state.round, 10);
        h.runtime.dispose();
    }
});

test('disabling and reenabling cannot reroll an already settled message', async () => {
    let rolls = 0;
    const h = host({ random: () => { rolls++; return 0; } });
    await h.runtime.tick(); const count = rolls;
    h.cfg.enabled = false; await h.runtime.tick();
    h.cfg.enabled = true; await h.runtime.tick();
    assert.equal(h.runtime.snapshot().state, null); assert.equal(rolls, count);
    h.c.chat.push({ mes: scene(action) }); await h.runtime.tick(); assert.equal(h.runtime.snapshot().state.round, 1);
});

test('removing an active script config clears its injections in this session', async () => {
    const h = host(); await h.runtime.tick();
    h.cfg = null; await h.runtime.tick();
    assert.equal(h.entries.get(KEY + '战况').disable, true);
    assert.equal(h.entries.get(KEY + 'report协议').disable, true);
});

test('leaving the scene clears injections and restarting does not forget old XP', async () => {
    const h = host({ entries: { [KEY + '经验总档']: '  user: 25\n  A: 50' } });
    await h.runtime.tick();
    h.c.chat.push({ mes: scene('', ['A'], 'NSFW') }); await h.runtime.tick();
    assert.equal(h.runtime.snapshot().state, null); assert.equal(h.entries.get(KEY + '战况').disable, true);
    h.c.chat.push({ mes: scene(action) }); await h.runtime.tick();
    assert.equal(h.runtime.snapshot().levels.A, 50); assert.equal(h.runtime.snapshot().state.round, 1);
});

test('default judgment is a separate scene/roster blue-light rule, never a numeric toggle', async () => {
    const h = host(); await h.runtime.tick();
    const rule = h.entries.get(KEY + '默认判断');
    assert.equal(rule.constant, true); assert.equal(rule.position, 4); assert.equal(rule.depth, 0);
    assert.match(rule.content, /SceneInfo/); assert.match(rule.content, /场景类型/); assert.match(rule.content, /在场角色/);
    assert.doesNotMatch(rule.content, /report|掷骰|经验|高潮/);
    h.cfg.defaultJudgment = false;
    await h.runtime.tick();
    assert.equal(h.entries.get(KEY + '默认判断').disable, true, 'toggle applies without a new report');
    assert.equal(h.runtime.snapshot().state.round, 1);
    h.c.chat.push({ mes: scene(action) }); await h.runtime.tick();
    assert.equal(h.runtime.snapshot().state.round, 2);
    assert.equal(h.entries.get(KEY + '默认判断').disable, true);
    assert.equal(h.entries.get(KEY + 'report协议').constant, true);
});

test('default judgment starts before any eligible scene so the first prompt can request fields', async () => {
    const h = host({ chat: [{ mes: '普通开场白' }] }); await h.runtime.tick();
    assert.equal(h.entries.get(KEY + '默认判断').constant, true);
    assert.equal(h.runtime.snapshot().state, null);
});
