import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { runAgentLoop, createRequestLimiter } from '../src/agent-runner.js';
import { normalizeAgentHistory } from '../src/agent-context.js';
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
        './agent-context.js': { normalizeAgentHistory },
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
    assert.equal(h.normalize({}).maxTokens, 100000);
    assert.equal(h.normalize({ maxTokens: 999999 }).maxTokens, 100000);
    assert.equal(h.normalize({ maxTokens: 4096 }).maxTokens, 4096);
    assert.equal(h.normalize({}).contextChars, 240000);
    assert.equal(h.normalize({ contextChars: 0 }).contextChars, 0);
    assert.equal(h.normalize({ contextChars: 2000000 }).contextChars, 2000000);
});

test('the previous persisted 4096 default upgrades once to 100k and explicit user limits survive', async () => {
    const h = await harness();
    h.c.extensionSettings.RubyAnalyzer = { agentConfig: { maxTokens: 4096 } };
    assert.equal(h.controller.getSettings().maxTokens, 100000);
    await h.controller.saveSettings({ rpm: 42 });
    assert.equal(h.c.extensionSettings.RubyAnalyzer.agentConfig.maxTokens, 100000);
    assert.equal(h.c.extensionSettings.RubyAnalyzer.agentConfig.version, 2);
    await h.controller.saveSettings({ maxTokens: 4096 });
    assert.equal(h.controller.getSettings().maxTokens, 4096);
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

test('Unicode Agent turns pass their real SillyTavern user floor to Gemini main routing', async () => {
    const seen = [];
    const h = await harness({ request: async (args) => { seen.push(args.routerUnicodeInput); return answer('已完成'); } });
    await h.controller.setMode('agent');
    await h.controller.submit('请检查墨涟条目');
    assert.equal(seen[0].user_floor, 0);
    assert.equal(h.c.chat[0].is_user, true);
    assert.equal(h.c.chat[0].extra.ruby_agent, true);
    await h.controller.submit('Check the entry');
    assert.equal(seen[1].user_floor, 2, 'Prior Unicode user turns in Agent history still need their latest real chat floor');
    const asciiOnly = await harness({ request: async (args) => { seen.push(args.routerUnicodeInput); return answer('Done'); } });
    await asciiOnly.controller.setMode('agent');
    await asciiOnly.controller.submit('Check the entry');
    assert.equal(seen[2], undefined, 'ASCII-only Agent histories do not send router-specific metadata');
});

test('long writing history is summarized, persisted, and recoverable through a paged archive tool', async () => {
    let taskCalls = 0;
    const h = await harness({ request: async ({ purpose, messages, definitions }) => {
        if (purpose === 'compaction') return answer('Creator-confirmed facts and the pending revision.');
        taskCalls++;
        assert.ok(definitions.some((d) => d.function.name === 'read_compacted_history'));
        if (taskCalls === 1) {
            const memory = messages.find((m) => m.content?.startsWith('[RUBY_CONTEXT_MEMORY]'));
            assert.ok(memory);
            const archiveId = memory.content.match(/归档ID: ([^，]+)/)[1];
            return { choices: [{ message: { tool_calls: [{ id: 'archive', type: 'function', function: {
                name: 'read_compacted_history', arguments: JSON.stringify({ archiveId, limit: 1000 }),
            } }] } }] };
        }
        assert.match(messages.at(-1).content, /Original confirmed biography/);
        return answer('Recovered exact details and continued.');
    } });
    await h.controller.setMode('agent');
    const d = h.c.chatMetadata.extensions.RubyAnalyzer.agent;
    d.history = [{ role: 'user', content: 'Original confirmed biography ' + 'detail '.repeat(40000) },
        { role: 'assistant', content: 'Confirmed' }, { role: 'user', content: 'Next step' }, { role: 'assistant', content: 'Ready' }];
    const result = await h.controller.submit('Continue from the confirmed facts');
    assert.equal(result.text, 'Recovered exact details and continued.');
    assert.equal(d.contextArchives.length, 1);
    assert.match(d.contextArchives[0].messages[0].content, /Original confirmed biography/);
    assert.ok(d.logs.some((log) => log.kind === 'compaction'));
    await h.controller.resetConversation();
    assert.equal(d.contextArchives.length, 0);
});
