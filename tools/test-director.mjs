// Run with: node --test tools/test-director.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { buildDirectorPrompt, parseDirectorSchedule, validateSchedule } from '../src/director.js';

const taskList = [{ id: 9, name: 'Scene check', priority: 0, brief: '' }];
const schedule = '```yaml\n周期安排:\n- 位置: 2\n  任务: task9\n```';
let scenario = 0;

test('schedule parsing accepts presentation variants without reading reasoning examples', () => {
    for (const text of [schedule, schedule.replace('yaml', 'YAML'), schedule.replace('yaml', 'yml'),
        schedule.replace('yaml', ''), '**周期安排**:\n- **位置**: 2\n  **任务**: task9',
        '位置: 7\n位置: 2\n任务: task9', '第2回合: task9']) {
        const parsed = parseDirectorSchedule(text, taskList);
        assert.equal(parsed.retryable, false, text);
        assert.deepEqual(parsed.assignments, [{ position: 2, taskId: 9 }]);
    }
    const thought = '<think>```yaml\n周期安排:\n- 位置: 8\n  任务: task9\n```</think>';
    assert.deepEqual(parseDirectorSchedule(thought + schedule, taskList).assignments,
        [{ position: 2, taskId: 9 }]);
    assert.equal(parseDirectorSchedule(thought, taskList).retryable, true);
    assert.equal(parseDirectorSchedule('周期安排: []', taskList).retryable, false);
    assert.equal(parseDirectorSchedule('Character analysis only', taskList).retryable, true);
});

test('cycle endpoints and invalid task IDs are validated consistently', () => {
    assert.deepEqual(validateSchedule([{ position: 2, taskId: 9 }],
        { maxPosition: 2, minSpacing: 0, taskList }).assignments, [{ position: 2, taskId: 9 }]);
    assert.deepEqual(validateSchedule([{ position: 20, taskId: 9 }],
        { maxPosition: 20, minSpacing: 0, taskList }).assignments, [{ position: 20, taskId: 9 }]);
    assert.equal(validateSchedule([{ position: 2, taskId: 999 }],
        { maxPosition: 20, minSpacing: 0, taskList }).retryable, true);
    const prompt = buildDirectorPrompt({ tasks: taskList, cycleLength: 2, minSpacing: 0,
        aggressive: false, round: 1, lastCycle: [], woken: [], overdue: [], refSections: [] });
    assert.match(prompt, /任务: task9/);
    assert.doesNotMatch(prompt, /任务: task1\b|任务: task2\b/);
});

async function harness(t, { count = 10, ignoreLatest = false, cycleLength = 4, retryLimit = 1 } = {}) {
    const timers = new Map();
    let timerId = 0;
    const originalTimeout = globalThis.setTimeout;
    const originalClear = globalThis.clearTimeout;
    globalThis.setTimeout = (fn, delay) => {
        const id = ++timerId;
        timers.set(id, { fn, delay });
        return id;
    };
    globalThis.clearTimeout = (id) => timers.delete(id);
    t.after(() => {
        globalThis.setTimeout = originalTimeout;
        globalThis.clearTimeout = originalClear;
    });
    const chat = Array.from({ length: count }, (_, i) => ({ is_user: false, mes: `Scene ${i + 1}` }));
    const metadata = {};
    const settings = { RubyAnalyzer: { ui: { ignoreLatestFloor: ignoreLatest } } };
    const config = { activePresetId: 'p', presets: [{ id: 'p', name: 'Test',
        director: { enabled: true, cycleLength, retryLimit, planKey: '' },
        startupTask: { enabled: false }, referencePool: [],
        tasks: [{ id: 9, enabled: true, displayName: 'Scene check', promptKey: 'prompt',
            outputKey: '', cyclePositions: [2] }],
    }] };
    const characters = [{ name: 'Test', avatar: 'test.png', data: { extensions: { RubyAnalyzer: config } } }];
    const events = new EventEmitter();
    const types = Object.fromEntries(['CHAT_CHANGED', 'GENERATION_ENDED', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_SENT',
        'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'CHAT_COMPLETION_SETTINGS_READY'].map((key) => [key, key]));
    const requests = [];
    const replies = [];
    let chatId = 'test-chat';
    let activeMetadata = metadata;
    let onLoad;
    const context = () => ({
        chat, chatMetadata: activeMetadata, chatId, characterId: 0, groupId: null,
        characters, name2: 'Test', mainApi: 'openai', extensionSettings: settings,
        eventSource: events, eventTypes: types, getCurrentChatId: () => chatId,
        saveMetadataDebounced() {}, saveSettingsDebounced() {}, saveChat() {},
        substituteParams: (value) => value,
        loadWorldInfo: async () => {
            if (onLoad) { const hook = onLoad; onLoad = null; await hook(); }
            return { entries: { 1: { uid: 1, key: ['prompt'], content: 'Analyze the scene' } } };
        },
        saveWorldInfo: async () => {},
        executeSlashCommandsWithOptions: async (command) => ({ pipe: command.startsWith('/getcharbook') ? 'Character' : 'Chat' }),
        generateRaw: async (options) => {
            requests.push(structuredClone(options.prompt));
            const reply = replies.length ? replies.shift() : schedule;
            return typeof reply === 'function' ? reply() : reply;
        },
    });
    globalThis.window = { SillyTavern: { getContext: context }, toastr: {}, dispatchEvent() {} };
    globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
    const engine = await import(`../src/engine.js?director-test=${++scenario}`);
    const addReplies = (n) => {
        for (let i = 0; i < n; i++) chat.push({ is_user: false, mes: `Scene ${chat.length + 1}` });
    };
    const runTimer = async (delay) => {
        const found = [...timers].find(([, timer]) => timer.delay === delay);
        assert.ok(found, `Expected timer ${delay}`);
        timers.delete(found[0]);
        await found[1].fn();
    };
    engine.initEngine();
    return { engine, chat, metadata, settings, config, events, types, requests, replies, addReplies, runTimer, timers,
        advance: async (n) => { addReplies(n); events.emit(types.GENERATION_ENDED); await runTimer(1200); },
        switchChat: (meta = {}) => { chatId = 'other-chat'; activeMetadata = meta; },
        onNextLoad: (hook) => { onLoad = hook; },
    };
}

test('fresh chats initialize director metadata and run on the next reply', async (t) => {
    const h = await harness(t);
    assert.equal(h.metadata.extensions.RubyAnalyzer.director.nextDirectorFloor, 11);
    await h.advance(1);
    assert.equal(h.requests.length, 1);
    assert.equal(h.metadata.extensions.RubyAnalyzer.director.plan.runFloor, 11);
});

test('reroll starts at the live floor even with ignored latest input or replies during generation', async (t) => {
    const h = await harness(t, { ignoreLatest: true });
    h.metadata.extensions.RubyAnalyzer.lastReadFloor = { director: 3 };
    h.replies.push(() => { h.addReplies(3); return schedule; });
    const result = await h.engine.forceRun('director');
    assert.equal(result.ok, true);
    const meta = h.metadata.extensions.RubyAnalyzer.director;
    assert.equal(meta.plan.runFloor, 13);
    assert.equal(meta.plan.assignments[0].floor, 14);
    assert.equal(meta.nextDirectorFloor, 17);
    assert.equal(h.metadata.extensions.RubyAnalyzer.lastReadFloor.director, 9);
    await h.advance(1);
    assert.equal(meta.plan.assignments[0].woken, true);
    await h.engine.forceRun('director');
    assert.equal(meta.plan.runFloor, 14);
    assert.equal(meta.plan.assignments[0].floor, 15);
    await h.engine.forceRun('director');
    assert.equal(h.metadata.extensions.RubyAnalyzer.lastReadFloor.director, 13,
        'Manual fallback reading must still exclude the latest reply');
    assert.equal(meta.plan.runFloor, 14);
});

test('director has its own output contract, corrective retry, and truthful failure result', async (t) => {
    const h = await harness(t);
    h.replies.push('A prose analysis instead of a schedule', schedule);
    assert.equal((await h.engine.forceRun('director')).ok, true);
    assert.deepEqual(h.requests[0].map((message) => message.role), ['system', 'user']);
    assert.doesNotMatch(h.requests[0].map((m) => m.content).join('\n'), /角色资料解析AI|仅输出分析内容/);
    assert.match(h.requests[1].at(-1).content, /上次回复未通过排期校验/);
    h.replies.push('bad output', 'still bad');
    const failed = await h.engine.forceRun('director');
    assert.equal(failed.ok, false);
    assert.equal(failed.failed, 1);
    assert.equal(h.metadata.extensions.RubyAnalyzer.director.nextDirectorFloor, 14,
        'A failed manual reroll must preserve the previous schedule boundary');
    assert.equal((await h.engine.forceRun('director')).ok, true);
    assert.equal(h.engine.getEngineState().lastError, null);
});

test('failed automatic schedules retry relative to the latest chat and then recover', async (t) => {
    const h = await harness(t, { retryLimit: 0 });
    h.replies.push(() => { h.addReplies(3); return 'No schedule'; });
    await h.advance(1);
    const meta = h.metadata.extensions.RubyAnalyzer.director;
    assert.equal(meta.nextDirectorFloor, 16);
    assert.equal(meta.plan, null);
    await h.advance(2);
    assert.equal(meta.plan.runFloor, 16);
    assert.equal(meta.nextDirectorFloor, 20);
    assert.equal(h.engine.getEngineState().lastError, null);
});

test('failed manual rerolls retain future tasks from the previous plan', async (t) => {
    const h = await harness(t, { retryLimit: 0 });
    h.replies.push(schedule.replace('位置: 2', '位置: 4'));
    await h.engine.forceRun('director');
    const meta = h.metadata.extensions.RubyAnalyzer.director;
    h.replies.push('Invalid replacement');
    assert.equal((await h.engine.forceRun('director')).ok, false);
    assert.equal(meta.nextDirectorFloor, 14);
    assert.equal(meta.plan.assignments[0].floor, 13);
    await h.advance(3);
    assert.equal(meta.plan.assignments[0].woken, true);
    assert.equal(h.requests.length, 3);
});

test('a stale bookmark cannot anchor an automatic plan in the past', async (t) => {
    const h = await harness(t);
    h.metadata.extensions.RubyAnalyzer.lastReadFloor = { director: 100 };
    await h.advance(1);
    const meta = h.metadata.extensions.RubyAnalyzer.director;
    assert.equal(meta.plan.runFloor, 11);
    assert.equal(meta.plan.assignments[0].floor, 12);
    assert.equal(meta.nextDirectorFloor, 15);
});

test('catch-up executes due analysis and the next director through separate pipelines', async (t) => {
    const h = await harness(t, { cycleLength: 2 });
    await h.engine.forceRun('director');
    const meta = h.metadata.extensions.RubyAnalyzer.director;
    assert.equal(meta.plan.assignments[0].floor, 11);
    await h.advance(2);
    assert.equal(h.requests.length, 3, 'Initial director, due analysis, next director');
    assert.equal(meta.plan.runFloor, 12);
    assert.equal(meta.runSeq, 2);
    assert.equal(meta.nextDirectorFloor, 14);
});

test('new plans can reuse a task floor after deletions and cycle sequence exceeds history capacity', async (t) => {
    const h = await harness(t);
    await h.engine.forceRun('director');
    await h.advance(1);
    h.chat.pop();
    await h.engine.forceRun('director');
    await h.advance(1);
    assert.equal(h.metadata.extensions.RubyAnalyzer.director.plan.assignments[0].woken, true);
    for (let i = 0; i < 6; i++) await h.engine.forceRun('director');
    assert.equal(h.metadata.extensions.RubyAnalyzer.director.history.length, 5);
    assert.equal(h.metadata.extensions.RubyAnalyzer.director.runSeq, 8);
    assert.equal(h.engine.getEngineState().director.runSeq, 8);
});

test('a result from a previous chat cannot update the new chat plan', async (t) => {
    const h = await harness(t);
    h.replies.push(() => { h.switchChat(); return schedule; });
    assert.equal((await h.engine.forceRun('director')).ok, false);
    assert.equal(h.metadata.extensions.RubyAnalyzer.director.plan, null);
});

test('switching chats during worldbook setup cannot initialize or reset the new chat metadata', async (t) => {
    const h = await harness(t);
    const other = { extensions: { RubyAnalyzer: { lastReadFloor: { director: 100 } } } };
    const before = structuredClone(other);
    h.onNextLoad(() => h.switchChat(other));
    assert.equal((await h.engine.forceRun('director')).ok, false);
    assert.deepEqual(other, before);
    assert.equal(h.requests.length, 0);
});

test('catch-up beyond the cycle boundary drains overdue tasks before replacing the plan', async (t) => {
    const h = await harness(t, { cycleLength: 2 });
    await h.engine.forceRun('director');
    h.addReplies(3);
    h.engine.reinit();
    await h.advance(1);
    assert.equal(h.requests.length, 3, 'Overdue analysis must run before the next director');
    assert.match(h.requests[1].map((m) => m.content).join('\n'), /Analyze the scene/);
    assert.equal(h.metadata.extensions.RubyAnalyzer.director.plan.runFloor, 14);
});

test('aggressive two-reply cycles retain their only task slot and advance automatically', async (t) => {
    const h = await harness(t);
    h.config.presets[0].director.aggressive = true;
    h.replies.push(schedule.replace('\n```', '\n下次导演间隔: 2\n```'));
    await h.engine.forceRun('director');
    const meta = h.metadata.extensions.RubyAnalyzer.director;
    assert.equal(meta.nextDirectorFloor, 12);
    assert.equal(meta.plan.assignments[0].floor, 11);
    await h.advance(1);
    assert.equal(meta.plan.assignments[0].woken, true);
    await h.advance(1);
    assert.equal(meta.runSeq, 2);
    assert.equal(meta.plan.runFloor, 12);
});

test('nonexistent task IDs are retried rather than accepted as an empty cycle', async (t) => {
    const h = await harness(t);
    h.replies.push(schedule.replace('task9', 'task999'), schedule);
    assert.equal((await h.engine.forceRun('director')).ok, true);
    assert.equal(h.requests.length, 2);
    assert.match(h.requests[1].at(-1).content, /任务或位置均无效/);
});

test('every received reply publishes the counter at high floors, even without ENDED or a due task', async (t) => {
    const h = await harness(t, { count: 10000 });
    h.config.presets[0].director.enabled = false;
    h.config.presets[0].tasks[0].cyclePositions = [5];
    h.engine.reinit();
    const updates = [];
    h.engine.onStateChange((state) => updates.push(state));
    for (let i = 1; i <= 5; i++) {
        h.chat.push({ is_user: true, mes: 'User input' });
        h.events.emit(h.types.MESSAGE_SENT, h.chat.length - 1);
        assert.equal(updates.at(-1).aiCount, 10000 + i - 1, 'User input does not count as another AI reply');
        h.addReplies(1);
        h.events.emit(h.types.MESSAGE_RECEIVED, h.chat.length - 1, 'normal');
        assert.equal(updates.at(-1).aiCount, 10000 + i);
        assert.equal(updates.at(-1).position, i);
        h.events.emit(h.types.CHARACTER_MESSAGE_RENDERED, h.chat.length - 1, 'normal');
        await h.runTimer(1200);
        assert.equal(h.requests.length, i === 5 ? 1 : 0);
        assert.equal(updates.at(-1).aiCount, 10000 + i);
    }
});

test('streaming lifecycle signals share one timer and one scheduled execution', async (t) => {
    const h = await harness(t);
    h.addReplies(1);
    h.events.emit(h.types.GENERATION_ENDED);
    const firstTimer = [...h.timers.keys()][0];
    h.events.emit(h.types.MESSAGE_RECEIVED, h.chat.length - 1, 'normal');
    h.events.emit(h.types.CHARACTER_MESSAGE_RENDERED, h.chat.length - 1, 'normal');
    assert.deepEqual([...h.timers.keys()], [firstTimer], 'Later events must not postpone the pending tick');
    await h.runTimer(1200);
    assert.equal(h.requests.length, 1);
    h.events.emit(h.types.MESSAGE_RECEIVED, h.chat.length - 1, 'continue');
    await h.runTimer(1200);
    assert.equal(h.requests.length, 1, 'Continuing an existing reply does not advance the cycle');
});

test('manual and standby modes still publish live counts without automatic analysis', async (t) => {
    const h = await harness(t);
    h.settings.RubyAnalyzer.ui.pureManualRun = true;
    const updates = [];
    h.engine.onStateChange((state) => updates.push(state.aiCount));
    h.addReplies(1);
    h.events.emit(h.types.MESSAGE_RECEIVED, h.chat.length - 1, 'normal');
    assert.equal(updates.at(-1), 11);
    await h.runTimer(1200);
    assert.equal(h.requests.length, 0);
    h.config.presets[0].director.enabled = false;
    h.config.presets[0].tasks[0].enabled = false;
    h.engine.reinit();
    h.addReplies(1);
    h.events.emit(h.types.CHARACTER_MESSAGE_RENDERED, h.chat.length - 1, 'normal');
    assert.equal(updates.at(-1), 12);
    await h.runTimer(1200);
    assert.equal(h.requests.length, 0);
});

test('chat switches initialize immediately so an early first reply is not swallowed', async (t) => {
    const h = await harness(t);
    h.chat.splice(0, h.chat.length, { is_user: false, mes: 'New greeting' });
    h.switchChat();
    h.events.emit(h.types.CHAT_CHANGED);
    assert.equal(h.engine.getEngineState().aiCount, 1);
    h.addReplies(1);
    h.events.emit(h.types.MESSAGE_RECEIVED, h.chat.length - 1, 'normal');
    await h.runTimer(1200);
    assert.equal(h.requests.length, 1);
    assert.equal(h.engine.getEngineState().director.anchor, 2);
});

test('deleting and regenerating a reply updates the counter synchronously without adding a floor', async (t) => {
    const h = await harness(t);
    const updates = [];
    h.engine.onStateChange((state) => updates.push(state.aiCount));
    h.chat.pop();
    h.events.emit(h.types.MESSAGE_DELETED, h.chat.length);
    assert.equal(updates.at(-1), 9);
    h.addReplies(1);
    h.events.emit(h.types.MESSAGE_RECEIVED, h.chat.length - 1, 'normal');
    assert.equal(updates.at(-1), 10);
    h.events.emit(h.types.MESSAGE_SWIPED, h.chat.length - 1);
    assert.equal(updates.at(-1), 10);
    await h.runTimer(1200);
    assert.equal(h.requests.length, 0);
});

test('counters keep advancing during a pending analysis and unread replies are processed afterward', async (t) => {
    const h = await harness(t, { count: 10000 });
    h.config.presets[0].director.enabled = false;
    h.config.presets[0].tasks[0].cyclePositions = [1];
    h.engine.reinit();
    const updates = [];
    h.engine.onStateChange((state) => updates.push(state));
    let finish;
    let started;
    const pending = new Promise((resolve) => { finish = resolve; });
    const ready = new Promise((resolve) => { started = resolve; });
    h.replies.push(() => { started(); return pending; });
    h.addReplies(1);
    h.events.emit(h.types.MESSAGE_RECEIVED, h.chat.length - 1, 'normal');
    const firstTick = h.runTimer(1200);
    await ready;
    assert.equal(h.engine.getEngineState().running, true);
    for (let i = 0; i < 3; i++) {
        h.addReplies(1);
        h.events.emit(h.types.MESSAGE_RECEIVED, h.chat.length - 1, 'normal');
        assert.equal(updates.at(-1).aiCount, 10002 + i);
        assert.equal(updates.at(-1).running, true);
    }
    await h.runTimer(1200);
    finish('Analysis result');
    await firstTick;
    await h.runTimer(1200);
    assert.equal(h.requests.length, 2);
    assert.equal(h.metadata.extensions.RubyAnalyzer.lastReadFloor.task_9, 10004);
    assert.equal(updates.at(-1).aiCount, 10004);
    assert.equal(h.engine.getEngineState().running, false);
});
