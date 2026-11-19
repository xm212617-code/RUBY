import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { runAgentLoop, createRequestLimiter } from '../src/agent-runner.js';
import { extendAgentArtifacts } from '../src/agent-artifacts.js';
import { renderAgentMarkdown, agentMessageSource } from '../src/agent-render.js';

const source = await readFile(new URL('../src/agent-controller.js', import.meta.url), 'utf8');
const answer = (text) => ({ choices: [{ message: { content: text } }] });

async function harness({ request = async () => answer('Done'), makeTools } = {}) {
    let c = { chat: [], chatMetadata: {}, characterId: 0, groupId: null, id: 'a',
        characters: [{ avatar: 'a.png' }], extensionSettings: {}, mainApi: 'openai',
        getCurrentChatId() { return this.id; }, saveChat: async () => {}, saveMetadata: async () => {}, saveSettingsDebounced() {},
        addOneMessage() {}, name1: 'Player', eventSource: { on() {} }, eventTypes: { CHAT_CHANGED: 'chat' } };
    let calls = 0;
    const scope = [{ id: 'character', name: 'Main', sources: ['主书'] }];
    const defaultTools = async () => ({ scope, definitions: [{ type: 'function', function: { name: 'read' } }], execute: async () => ({ content: 'Facts' }) });
    const dependencies = {
        './env.js': { ctx: () => c, warn() {} },
        './agent-tools.js': { createAgentTools: defaultTools },
        './agent-knowledge.js': { AGENT_SYSTEM_GUIDE: 'Agent guide', getKnowledgeIndex: () => [], readKnowledge: () => null },
        './agent-runner.js': { createRequestLimiter, runAgentLoop },
        './agent-api.js': { requestAgent: request },
        './agent-mode.js': { isAgentMode: (context = c) => context?.chatMetadata?.extensions?.RubyAnalyzer?.agent?.mode === 'agent' },
        './agent-regex-test.js': { testAgentRegex: async () => ({ matches: [] }) },
        './agent-artifacts.js': { extendAgentArtifacts },
        './agent-render.js': { renderAgentMarkdown, agentMessageSource },
    };
    const context = vm.createContext({ console, AbortController, setTimeout, clearTimeout, CustomEvent: class {}, window: { dispatchEvent() {} } });
    const mod = new vm.SourceTextModule(source, { context });
    await mod.link((specifier) => {
        const values = dependencies[specifier];
        return new vm.SyntheticModule(Object.keys(values), function () { for (const [k, v] of Object.entries(values)) this.setExport(k, v); }, { context });
    });
    await mod.evaluate();
    const controller = mod.namespace.createAgentController({ getContext: () => c, makeTools: makeTools || defaultTools,
        request: async (args) => { calls++; return request(args); }, systemGuide: 'Agent guide',
        limiter: createRequestLimiter({ delay: async () => {} }) });
    controller.saveSettings({ rpm: 600, minIntervalMs: 0 });
    return { controller, normalize: mod.namespace.normalizeAgentSettings, get c() { return c; }, get calls() { return calls; },
        switchChat: () => { c = { ...c, id: 'b', chat: [], chatMetadata: {} }; } };
}

test('Agent mode persists per chat; local API credentials never enter model messages', async () => {
    const seen = [];
    const h = await harness({ request: async (args) => { seen.push(args.messages); return answer('Done'); } });
    h.controller.saveSettings({ connection: 'custom', key: 'SECRET' });
    await h.controller.setMode('agent');
    await h.controller.submit('Write a character');
    assert.equal(h.controller.getState().mode, 'agent');
    assert.equal(h.c.chat.length, 2); assert.ok(h.c.chat.every((m) => m.extra.ruby_agent));
    assert.equal(h.c.chat[0].is_user, true); assert.equal(h.c.chat[1].extra.ruby_agent_name, 'Ruby Agent');
    assert.equal(h.c.chat[1].is_system, true); assert.equal(h.c.chat[1].name, 'SillyTavern System');
    assert.doesNotMatch(JSON.stringify(seen), /SECRET/);
    assert.equal(h.c.extensionSettings.RubyAnalyzer.agentConfig.key, 'SECRET');
    assert.equal(h.c.chatMetadata.extensions.RubyAnalyzer.agent.history.at(-1).content, 'Done');
    await h.controller.setMode('steps');
    await assert.rejects(h.controller.submit('Do not send'), /未开启/);
    assert.equal(h.calls, 1);
});

test('ordinary roleplay history is never imported; generated HTML is visible text rather than executable markup', async () => {
    let sent;
    const h = await harness({ request: async (args) => { sent = args.messages; return answer('```html\n<script>bad()</script>\n```'); } });
    h.c.chat.push({ is_user: false, mes: 'SECRET ROLEPLAY HISTORY' });
    await h.controller.setMode('agent'); await h.controller.submit('Create a panel');
    assert.doesNotMatch(JSON.stringify(sent), /SECRET ROLEPLAY/);
    assert.doesNotMatch(h.c.chat.at(-1).mes, /<script>/);
    assert.match(h.c.chat.at(-1).mes, /&lt;script&gt;/);
});

test('model results from a switched chat cannot be written into the new chat', async () => {
    let release, started;
    const ready = new Promise((resolve) => { started = resolve; });
    const h = await harness({ request: async () => { started(); return new Promise((resolve) => { release = resolve; }); } });
    await h.controller.setMode('agent');
    const old = h.c;
    const running = h.controller.submit('Work'); await ready;
    h.switchChat(); release(answer('Old result'));
    const result = await running;
    assert.equal(result.ok, false); assert.equal(h.c.chat.length, 0);
    assert.equal(old.chat.length, 1);
    assert.equal(h.controller.getState().mode, 'steps'); assert.equal(h.controller.getState().running, false);
});

test('stop interrupts the in-flight model call; prior turns remain available for follow-up', async () => {
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    let first = true;
    const h = await harness({ request: async ({ signal }) => {
        if (!first) return answer('Recovered');
        first = false; started();
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(Error('Stopped'), { name: 'AbortError' }))));
    } });
    await h.controller.setMode('agent');
    const running = h.controller.submit('Work'); await ready;
    await assert.rejects(h.controller.setMode('steps'), /先停止/);
    await assert.rejects(h.controller.submit('Duplicate'), /正在工作/);
    h.controller.stop(); await running;
    assert.equal(h.controller.getState().running, false);
    assert.equal(h.controller.getState().phase, '已停止');
    await h.controller.submit('Continue checking');
    assert.equal(h.controller.getState().phase, '已完成');
    await h.controller.resetConversation();
    assert.equal(h.c.chatMetadata.extensions.RubyAnalyzer.agent.history.length, 0);
    assert.equal(h.c.chat.length, 4, 'Reset affects Agent context, not the chat record or worldbooks');
});

test('failed preflight still records the user instruction and does not call the model', async () => {
    let fail = false;
    const h = await harness({ makeTools: async () => {
        if (fail) throw Error('Scope unavailable');
        return { definitions: [], scope: [], execute() {} };
    } });
    await h.controller.setMode('agent'); fail = true;
    const result = await h.controller.submit('Remember my task');
    assert.equal(result.ok, false); assert.equal(h.calls, 0);
    assert.equal(h.c.chatMetadata.extensions.RubyAnalyzer.agent.history[0].content, 'Remember my task');
});

test('settings clamp invalid limits and cannot persist arbitrary unknown fields', async () => {
    const h = await harness();
    const s = h.normalize({ rpm: 0, retries: 100, maxMinutes: -1, execute: 'bad', key: 9 });
    assert.equal(s.rpm, 1); assert.equal(s.retries, 5); assert.equal(s.maxMinutes, 1);
    assert.equal(s.execute, undefined); assert.equal(s.key, '');
});

test('unbinding a book clears prior tool history before the next model request', async () => {
    let book = 'OldBook', sent;
    const h = await harness({ makeTools: async () => ({ scope: { books: [{ id: 'character', name: book }] }, definitions: [], execute() {} }),
        request: async ({ messages }) => { sent = JSON.stringify(messages); return answer('Done'); } });
    await h.controller.setMode('agent');
    await h.controller.submit('Old authorized facts');
    book = 'NewBook';
    await h.controller.submit('Work with the new book');
    assert.doesNotMatch(sent, /Old authorized facts|OldBook/);
    assert.match(sent, /NewBook/);
});
