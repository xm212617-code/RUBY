// Run with: node --experimental-vm-modules --test tools/test-cardwriter.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import test from 'node:test';
import { CARDWRITER_DATA } from '../src/cardwriter-data.js';

const source = await readFile(new URL('../src/cardwriter.js', import.meta.url), 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));
const record = (text, action = '新条目', attrs = '') => `<ruby${action}${attrs}>\n\`\`\`yaml\n${text}\n\`\`\`\n</ruby${action}>`;
const entry = (uid, key, content, extra = {}) => ({ uid, key: [key], content, comment: key, constant: false, disable: false, position: 0, order: 100, ...extra });

async function host() {
    const books = new Map([['Draft', { entries: {} }]]), timers = new Map(), downloads = [];
    let nextTimer = 0, saves = 0, fail = false;
    const events = new EventEmitter();
    const types = Object.fromEntries(['CHAT_CHANGED', 'GENERATION_ENDED', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED'].map((key) => [key, key]));
    let c = { chat: [{ is_user: true, mes: 'Start' }], chatMetadata: {}, characterId: 0, groupId: null, chatId: 'a',
        characters: [{ data: { extensions: {} } }], eventSource: events, eventTypes: types,
        getCurrentChatId() { return this.chatId; }, saveMetadata: async () => {},
        loadWorldInfo: async (name) => clone(books.get(name)),
        saveWorldInfo: async (name, data) => {
            saves++;
            if (fail) { fail = false; throw Error('Simulated save failure'); }
            books.set(name, clone(data));
        },
    };
    const ui = { notify: false, cardwriter: { draftToBook: true, showGuide: true } };
    const st = async (command) => {
        if (command.startsWith('/getchatbook')) return 'Draft';
        if (command === '/getcharbook') return c.characters[c.characterId]?.data?.extensions?.world || '';
        const match = command.match(/^\/createentry file=("(?:[^"\\]|\\.)*") key=("(?:[^"\\]|\\.)*") ""$/);
        if (match) {
            const book = books.get(JSON.parse(match[1]));
            const uid = Math.max(-1, ...Object.keys(book.entries).map(Number)) + 1;
            book.entries[uid] = entry(uid, JSON.parse(match[2]), '');
            return String(uid);
        }
        throw Error(`Unexpected slash: ${command}`);
    };
    const context = vm.createContext({
        console, Blob: class { constructor(parts) { downloads.push(parts.join('')); } },
        URL: { createObjectURL: () => 'blob:card', revokeObjectURL() {} },
        document: { createElement: () => ({ click() {}, remove() {}, querySelector: () => null }), body: { appendChild() {} } },
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
        window: { dispatchEvent() {} },
        setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
        clearTimeout: (id) => timers.delete(id),
    });
    const modules = {
        './env.js': { ctx: () => c, st, q: JSON.stringify, log() {}, warn() {} },
        './config.js': { getUi: () => ui, saveUi: (patch) => Object.assign(ui, patch) },
        './cardwriter-data.js': { CARDWRITER_DATA },
    };
    const mod = new vm.SourceTextModule(source + '\nexport { buildCharacterCardFromManifest as buildCard, handleGenerationEnded as capture, buildInventoryContent as inventory };', { context });
    await mod.link((specifier) => {
        const data = modules[specifier];
        return new vm.SyntheticModule(Object.keys(data), function () { for (const [key, value] of Object.entries(data)) this.setExport(key, value); }, { context });
    });
    await mod.evaluate();
    const api = mod.namespace;
    return { api, books, timers, downloads, events, types, ui,
        get c() { return c; }, get saves() { return saves; }, failNextSave: () => { fail = true; },
        verifySaves: () => {
            c.getRequestHeaders = () => ({});
            context.fetch = async (_url, options) => ({ ok: true, json: async () => clone(books.get(JSON.parse(options.body).name)) });
        },
        switchChat: () => { c = { ...c, chat: [], chatMetadata: {}, chatId: 'b' }; },
        records: () => Object.values(books.get('Draft').entries).filter((e) => e.key[0].startsWith('ruby记录_')),
        flush: async () => {
            const hit = [...timers].find(([, t]) => t.delay === 800);
            assert.ok(hit, 'Capture scheduled'); timers.delete(hit[0]); await hit[1].fn();
        },
    };
}

test('record and manifest fences accept YAML case, yml, tilde and original action order', async () => {
    const h = await host();
    const text = record('character: Old', '更新条目', ' 编号="001"') + '\n' + record('character: New').replace('yaml', 'YML').replaceAll('```', '~~~');
    const records = h.api.extractRecords(text);
    assert.deepEqual(Array.from(records, (r) => r.action), ['update', 'new']);
    assert.equal(records[1].yaml, 'character: New');
    assert.equal(h.api.extractRecords(record('x: y').replace('yaml', 'YAML')).length, 1);
    assert.ok(h.api.extractManifest('<ruby合成>\n~~~JSON\n{"条目":[]}\n~~~\n</ruby合成>'));
    assert.equal(h.api.extractRecords('<ruby新条目>```yaml\nx: y</ruby新条目>').length, 0);
});

test('catch-up follows each message switch and normal receive events capture without ENDED', async () => {
    const h = await host(); h.api.initCardWriter();
    assert.equal(await h.api.startSession('Step1'), true);
    h.c.chat.push({ is_user: false, mes: record('character: First') + '\n<ruby切换 步骤="Step2"/>' },
        { is_user: false, mes: record('character: Second') });
    h.events.emit(h.types.MESSAGE_RECEIVED);
    h.events.emit(h.types.CHARACTER_MESSAGE_RENDERED);
    await h.flush();
    assert.deepEqual(h.records().map((e) => e.key[0]), ['ruby记录_Step1_001', 'ruby记录_Step2_001']);
    assert.equal(h.api.getState().stepId, 'Step2');
    assert.equal(h.api.getState().lastHandledMessage, 2);
});

test('save failures leave the cursor retryable and reuse the assigned record number', async () => {
    const h = await host(); await h.api.startSession('Step1');
    h.c.chat.push({ is_user: false, mes: record('character: Retry') });
    h.failNextSave(); await h.api.capture();
    assert.equal(h.api.getState().lastHandledMessage, 0);
    assert.match(h.api.getState().lastError, /save failure/);
    await h.api.capture();
    assert.equal(h.api.getState().lastHandledMessage, 1);
    assert.equal(h.records().length, 1);
    assert.equal(h.records()[0].content, 'character: Retry');
});

test('regenerating a discussion or deleting a tail cannot hide the next record', async () => {
    const h = await host(); h.api.initCardWriter(); await h.api.startSession('Step1');
    h.c.chat.push({ is_user: false, mes: 'Discussion only' });
    await h.api.capture();
    h.c.chat[1].mes = record('character: Regenerated');
    h.events.emit(h.types.MESSAGE_SWIPED, 1);
    await h.flush();
    assert.equal(h.records().length, 1);
    h.events.emit(h.types.MESSAGE_UPDATED, 1);
    await h.flush();
    assert.equal(h.records().length, 1, 'A saved record must not duplicate on an edit event');
    h.c.chat.pop(); h.events.emit(h.types.MESSAGE_DELETED);
    h.c.chat.push({ is_user: false, mes: record('character: After deletion') });
    h.events.emit(h.types.MESSAGE_RECEIVED, 1);
    await h.flush();
    assert.equal(h.records().length, 2);
});

test('a partially saved message retries only unfinished records', async () => {
    const h = await host(); await h.api.startSession('Step1');
    const save = h.c.saveWorldInfo;
    let calls = 0;
    h.c.saveWorldInfo = async (...args) => { if (++calls === 2) h.failNextSave(); return save(...args); };
    h.c.chat.push({ is_user: false, mes: record('character: First') + record('character: Second') });
    await h.api.capture();
    assert.equal(h.api.getState().lastHandledMessage, 0);
    await h.api.capture();
    assert.equal(h.records().length, 2);
    assert.deepEqual(h.records().map((e) => e.content), ['character: First', 'character: Second']);
});

test('editing an unfinished message preserves successful receipts and reserved failed numbers', async () => {
    const h = await host(); await h.api.startSession('Step1');
    const save = h.c.saveWorldInfo;
    let calls = 0;
    h.c.saveWorldInfo = async (...args) => { if (++calls === 2) h.failNextSave(); return save(...args); };
    h.c.chat.push({ is_user: false, mes: record('character: First') + record('character: Second') });
    await h.api.capture();
    h.c.chat[1].mes = record('character: First') + record('character: Corrected');
    await h.api.capture();
    assert.equal(h.records().length, 2);
    assert.deepEqual(h.records().map((e) => e.content), ['character: First', 'character: Corrected']);
});

test('server readback detects a silently failed host save', async () => {
    const h = await host(); h.verifySaves();
    h.c.saveWorldInfo = async () => {};
    assert.equal(await h.api.startSession(), false);
    assert.match(h.api.getState().lastError, /保存校验失败/);
    assert.equal(h.api.getState().active, false);
});

test('record limits fail explicitly instead of silently discarding later YAML blocks', async () => {
    const h = await host(); await h.api.startSession('Step7');
    h.c.chat.push({ is_user: false, mes: record('任务名: One') + record('任务名: Two') });
    await h.api.capture();
    assert.match(h.api.getState().lastError, /最多记录1条/);
    assert.equal(h.api.getState().lastHandledMessage, 0);
    assert.equal(h.records().length, 0);
});

test('malformed fenced YAML is reported and the corrected message remains retryable', async () => {
    const h = await host(); await h.api.startSession('Step1');
    h.c.chat.push({ is_user: false, mes: '<ruby新条目>\n```yaml\ncharacter: Retry\n</ruby新条目>' });
    await h.api.capture();
    assert.match(h.api.getState().lastError, /围栏不完整/);
    assert.equal(h.api.getState().lastHandledMessage, 0);
    h.c.chat[1].mes = record('character: Retry');
    await h.api.capture();
    assert.equal(h.api.getState().lastHandledMessage, 1);
    assert.equal(h.records().length, 1);
});

test('main and chat book sharing is rejected before any writes', async () => {
    const h = await host(); h.c.characters[0].data.extensions.world = 'Draft';
    assert.equal(await h.api.startSession(), false);
    assert.equal(h.saves, 0);
    assert.deepEqual(h.books.get('Draft').entries, {});
});

test('managed entries do not overwrite secondary-key collisions and activation filters are reset', async () => {
    const h = await host();
    h.books.get('Draft').entries[8] = entry(8, 'User entry', 'Keep', { key: ['User entry', 'RUBY写卡规则'], probability: 0 });
    h.books.get('Draft').entries[9] = entry(9, 'RUBY写卡_路线图', 'Old', { probability: 0, useProbability: true, triggers: ['quiet'], characterFilter: { names: ['Other'] } });
    await h.api.startSession();
    assert.equal(h.books.get('Draft').entries[8].content, 'Keep');
    const managed = Object.values(h.books.get('Draft').entries).find((e) => e.key[0] === 'RUBY写卡_路线图');
    assert.equal(managed.ignoreBudget, true); assert.equal(managed.useProbability, false);
    assert.deepEqual(managed.triggers, []); assert.equal(managed.characterFilter, undefined);
});

test('Step3 knowledge includes predecessor IDs and content; explicit cross-step updates stay scoped', async () => {
    const h = await host();
    h.books.get('Draft').entries[1] = entry(1, 'ruby记录_Step1_001', 'character: Alice\n背景: Work');
    h.books.get('Draft').entries[2] = entry(2, 'ruby记录_Step2_001', '角色核心: Motive');
    await h.api.startSession('Step3');
    const registry = () => Object.values(h.books.get('Draft').entries).find((e) => e.key[0] === 'RUBY写卡_编号知识').content;
    assert.match(registry(), /Step1_001/); assert.match(registry(), /背景: Work/); assert.match(registry(), /角色核心: Motive/);
    h.c.chat.push({ is_user: false, mes: record('character: Alice\n背景: Revised', '更新条目', ' 编号="Step1_001"') });
    await h.api.capture();
    assert.match(h.books.get('Draft').entries[1].content, /Revised/);
    assert.equal(h.api.getState().stepId, 'Step3');
});

test('inventory reports actual depth, role, selective logic and vector status', async () => {
    const h = await host();
    const text = h.api.inventory('char', 'Main', { 1: entry(1, 'A', 'Text', { position: 4, depth: 6, role: 1, keysecondary: ['B'], selective: true, selectiveLogic: 2, probability: 60, useProbability: true }),
        2: entry(2, 'Vector', 'Text', { vectorized: true }) });
    assert.match(text, /@D6·user/); assert.match(text, /NOT ANY/); assert.match(text, /概率60%/); assert.match(text, /向量灯/);
});

test('leaving scan mode retracts the inventory and ending a session disables its appendix', async () => {
    const h = await host(); await h.api.startSession('ScanChat');
    const find = (key) => Object.values(h.books.get('Draft').entries).find((e) => e.key[0] === key);
    assert.equal(find('RUBY写卡_世界书现状').disable, false);
    await h.api.switchStep('Step1');
    assert.equal(find('RUBY写卡_世界书现状').disable, true);
    find('RUBY分析器原理附录').disable = false;
    await h.api.endSession();
    assert.equal(find('RUBY分析器原理附录').disable, true);
});

test('the embedded overview and scan instructions all carry usable composition schemas', async () => {
    const h = await host();
    for (const id of ['Overview', 'ScanChar', 'ScanChat']) {
        const step = CARDWRITER_DATA.steps.find((s) => s.id === id);
        const manifest = h.api.extractManifest(step.instruction);
        assert.ok(manifest, id);
        assert.ok(Array.isArray(manifest.条目), id);
        assert.ok(manifest.条目.every((e) => e && typeof e === 'object'), id);
    }
});

test('composition preserves embedded fences and repeated references in both card and cleaned book', async () => {
    const h = await host();
    const content = 'character: Alice\n说明: |\n  ```html\n  <b>Keep</b>\n  ```';
    h.books.get('Draft').entries[1] = entry(1, 'ruby记录_Step1_001', content);
    await h.api.buildCard({ 卡名: 'Test', 角色描述来源: 'Step1_001', 条目: [
        { 记录: 'Step1_001', 条目名: 'First', 灯位: '蓝灯' }, { 记录: 'Step1_001', 条目名: 'Second', 灯位: '绿灯' },
    ] });
    const card = JSON.parse(h.downloads[0]);
    assert.equal(card.data.description, content);
    assert.equal(card.data.character_book.entries[0].content, content);
    assert.deepEqual(Object.values(h.books.get('Draft').entries).map((e) => e.key[0]), ['First', 'Second']);
});

test('auto-appended analysis prompts survive cleanup and task settings come from the manifest', async () => {
    const h = await host();
    h.books.get('Draft').entries[1] = entry(1, 'ruby记录_Step7_001', '任务名: Check');
    await h.api.buildCard({ 卡名: 'Task card', 条目: [{ 记录: 'Step7_001', 条目名: 'Reference' }],
        分析任务: [{ 任务名: 'Check', 记录: 'Step7_001', 提示词条目名: 'Prompt', 输出条目名: 'Result', 捕捉关键词: ['A', 'B'], 参考条目: ['Reference'], 周期位置: 3 }] });
    const card = JSON.parse(h.downloads[0]);
    const prompt = card.data.character_book.entries.find((e) => e.keys.includes('Prompt'));
    assert.equal(prompt.enabled, false);
    const task = card.data.extensions.RubyAnalyzer.presets[0].tasks[0];
    assert.equal(task.promptKey, 'Prompt'); assert.equal(task.outputKey, 'Result');
    assert.deepEqual(task.keywordScanKeywords, ['A', 'B']); assert.deepEqual(task.cyclePositions, [3]);
    assert.deepEqual(Object.values(h.books.get('Draft').entries).map((e) => e.key[0]), ['Reference', 'Prompt']);
});

test('existing book imports preserve activation fields, source keys and read-only origin', async () => {
    const h = await host(); h.c.characters[0].data.extensions.world = 'Main';
    const existing = entry(4, 'Trigger', 'Source', { comment: 'Label', keysecondary: ['Extra'], selective: true, selectiveLogic: 2, position: 7, depth: 6, role: 1, disable: true, group: 'G', sticky: 3, scanDepth: 9, delayUntilRecursion: 2 });
    h.books.set('Main', { entries: { 4: existing } });
    await h.api.buildCard({ 卡名: 'Import', 条目: [{ 记录: 'characterbook:4', 灯位: '蓝灯' }] });
    const e = JSON.parse(h.downloads[0]).data.character_book.entries[0];
    assert.deepEqual(e.keys, ['Trigger']); assert.equal(e.enabled, true);
    assert.equal(e.extensions.position, 7); assert.equal(e.extensions.depth, 6);
    assert.equal(e.extensions.selectiveLogic, 2); assert.equal(e.extensions.group, 'G'); assert.equal(e.extensions.sticky, 3);
    assert.equal(e.extensions.scan_depth, 9); assert.equal(e.extensions.delay_until_recursion, 2);
    assert.deepEqual(h.books.get('Main').entries[4], existing);
});

test('malformed manifests and process references through actual book names fail before cleanup', async () => {
    const h = await host();
    h.books.get('Draft').entries[1] = entry(1, 'RUBY写卡规则', 'Keep');
    await assert.rejects(h.api.buildCard({ 条目: ['聊天世界书:1'] }), /必须是对象/);
    await assert.rejects(h.api.buildCard({ 条目: [{ 记录: 'Draft:1' }] }), /流程条目/);
    await assert.rejects(h.api.buildCard({ 条目: [{ 书: 'Draft', uid: '1junk' }] }), /无效或不存在/);
    assert.equal(h.saves, 0); assert.equal(h.books.get('Draft').entries[1].content, 'Keep');
});

test('switching chats during reference loading cancels the old composition without writes', async () => {
    const h = await host();
    const load = h.c.loadWorldInfo;
    h.c.loadWorldInfo = async (name) => { const result = await load(name); h.switchChat(); return result; };
    await assert.rejects(h.api.buildCard({ 条目: [{ 记录: 'Step1_001' }] }), /已切换/);
    assert.equal(h.saves, 0); assert.equal(h.downloads.length, 0);
});
