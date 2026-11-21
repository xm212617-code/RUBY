import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgentLoop, parseAgentTurn, createRequestLimiter, abortableDelay, validateAgentArguments } from '../src/agent-runner.js';
import { buildAgentPayload, requestAgent } from '../src/agent-api.js';

const settings = { rpm: 60, minIntervalMs: 0, maxRequests: 5, maxMinutes: 2, retries: 1 };
const answer = (content) => ({ choices: [{ message: { content } }] });
const call = (name, args = {}, id = 'c1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const calls = (...tool_calls) => ({ choices: [{ message: { content: '', tool_calls } }] });
const tools = (execute) => ({ definitions: [{ type: 'function', function: { name: 'read' } }], execute });

test('switching custom DeepSeek to main Gemini ignores saved custom fields and reads the live main model', async () => {
    let model = 'gemini-test';
    const dependencies = { getContext: () => ({ mainApi: 'openai' }), getRubyApi: () => ({ provider: 'custom', url: 'https://old.example', model: 'deepseek-chat' }),
        loadMain: async () => ({ oai_settings: {}, getChatCompletionModel: () => model,
            createGenerationParameters: async (_s, current) => ({ generate_data: { model: current, chat_completion_source: 'makersuite' } }) }) };
    const config = { connection: 'custom', url: 'https://old.example', key: 'OLD_SECRET', model: 'deepseek-chat', maxTokens: 8000 };
    assert.equal((await buildAgentPayload(config, [], [], dependencies)).model, 'deepseek-chat');
    const main = await buildAgentPayload({ ...config, connection: 'main' }, [], [], dependencies);
    assert.equal(main.model, 'gemini-test'); assert.equal(main.chat_completion_source, 'makersuite');
    assert.equal(main.proxy_password, undefined); assert.equal(main.reverse_proxy, undefined);
    model = 'gemini-another';
    assert.equal((await buildAgentPayload({ ...config, connection: 'main' }, [], [], dependencies)).model, model);
});

test('third-party Gemini compatible paths do not get a spurious v1 suffix', async () => {
    for (const url of ['https://gateway.example/v1beta/openai', 'https://gateway.example/v1beta/openai/chat/completions']) {
        const payload = await buildAgentPayload({ connection: 'custom', url, model: 'gemini-test', maxTokens: 8000 }, [], [], { getContext: () => ({}) });
        assert.equal(payload.reverse_proxy, 'https://gateway.example/v1beta/openai');
    }
    await assert.rejects(requestAgent({ settings: { connection: 'custom', url: '', model: '' }, messages: [], definitions: [], getContext: () => ({}) }), /请求准备失败.*尚未发送到酒馆后端/);
});

test('connection diagnostics identify the effective endpoint without leaking credentials and retain backend errors', async (t) => {
    const previous = globalThis.fetch;
    t.after(() => { globalThis.fetch = previous; });
    let connection, sent;
    globalThis.fetch = async (_url, options) => {
        sent = JSON.parse(options.body);
        return { ok: false, status: 400, headers: { get: () => null }, json: async () => ({ error: 'Gateway rejected model' }) };
    };
    await assert.rejects(requestAgent({
        settings: { connection: 'custom', url: 'https://gateway.example/v1beta/openai?key=URL_SECRET', key: 'API_SECRET', model: 'gemini-test', maxTokens: 8000 },
        messages: [], definitions: [], getContext: () => ({ getRequestHeaders: () => ({}) }),
        onConnection: (value) => { connection = value; },
    }), /HTTP 400.*gemini-test.*Gateway rejected model/);
    assert.equal(connection.endpoint, 'https://gateway.example/v1beta/openai');
    assert.doesNotMatch(JSON.stringify(connection), /SECRET/);
    assert.equal(sent.model, 'gemini-test');
});

test('a user task executes tools, observes results, then returns the final response', async () => {
    const messages = [{ role: 'user', content: 'Check' }], seen = [];
    let requests = 0;
    const result = await runAgentLoop({ messages, settings, tools: tools(async (name, args) => { seen.push([name, args]); return { content: 'Facts' }; }),
        request: async ({ messages: current }) => {
            if (!requests++) return calls(call('read', { uid: 0 }));
            assert.equal(current.at(-1).role, 'tool'); assert.match(current.at(-1).content, /Facts/);
            return answer('Done');
        },
    });
    assert.equal(result.text, 'Done'); assert.equal(result.requestCount, 2); assert.equal(result.toolCount, 1);
    assert.deepEqual(seen, [['read', { uid: 0 }]]);
});

test('unknown tools and invalid arguments never reach the executor', async () => {
    let requests = 0, executions = 0;
    const bad = call('read', {}, 'c2'); bad.function.arguments = '{bad';
    const messages = [];
    await runAgentLoop({ messages, settings, tools: tools(async () => executions++),
        request: async () => requests++ ? answer('Corrected') : calls(call('fetch'), bad) });
    assert.equal(executions, 0);
    assert.equal(messages.filter((m) => m.role === 'tool').length, 2);
    assert.match(messages[1].content, /未授权/);
});

test('tool failures are observed, not automatically executed twice', async () => {
    let requests = 0, mutations = 0;
    const messages = [];
    await runAgentLoop({ messages, settings, tools: tools(async () => { mutations++; throw Error('Conflict'); }),
        request: async () => requests++ ? answer('Conflict reported') : calls(call('read')) });
    assert.equal(mutations, 1); assert.match(messages[1].content, /Conflict/);
});

test('abort completes the tool result group without executing remaining calls', async () => {
    const controller = new AbortController();
    let mutations = 0;
    const messages = [];
    await assert.rejects(runAgentLoop({ messages, settings, signal: controller.signal,
        tools: tools(async () => { mutations++; controller.abort(); return { ok: true }; }),
        request: async () => calls(call('read', {}, 'c1'), call('read', {}, 'c2')) }), /已停止/);
    assert.equal(mutations, 1);
    assert.equal(messages.filter((m) => m.role === 'tool').length, 2);
    assert.match(messages.at(-1).content, /未执行/);
});

test('429 retry counts against the request budget and honors Retry-After', async () => {
    let requests = 0;
    const waits = [];
    const result = await runAgentLoop({ messages: [], settings, tools: tools(() => {}),
        delay: async (ms) => waits.push(ms), request: async () => {
            if (!requests++) throw Object.assign(Error('HTTP 429'), { retryAfterMs: 7000 });
            return answer('Done');
        } });
    assert.equal(result.requestCount, 2); assert.deepEqual(waits, [7000]);
    await assert.rejects(runAgentLoop({ messages: [], settings: { ...settings, maxRequests: 1 }, tools: tools(() => {}),
        delay: async () => {}, request: async () => { throw Error('HTTP 429'); } }), /次数上限/);
});

test('limiter enforces a rolling minute across tasks and retry attempts', async () => {
    let now = 0;
    const waits = [];
    const limiter = createRequestLimiter({ now: () => now, delay: async (ms) => { waits.push(ms); now += ms; } });
    for (let i = 0; i < 3; i++) await limiter.acquire({ rpm: 2, minIntervalMs: 1000 });
    assert.deepEqual(waits, [1000, 59000]);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(limiter.acquire({ rpm: 2 }, aborted.signal), /已停止/);
    await assert.rejects(abortableDelay(1000, aborted.signal), /已停止/);
});

test('truncated, duplicate and empty tool responses are rejected before any tools run', () => {
    assert.throws(() => parseAgentTurn({ choices: [{ finish_reason: 'length', message: { tool_calls: [call('read')] } }] }), /长度上限/);
    assert.throws(() => parseAgentTurn(calls(call('read'), call('read'))), /重复/);
    assert.throws(() => parseAgentTurn(answer('')), /未返回/);
    assert.equal(parseAgentTurn({ content: [{ type: 'tool_use', id: 'a', name: 'read', input: { uid: 0 } }] }).calls[0].function.arguments, '{"uid":0}');
});

test('SillyTavern Gemini wrapper preserves responseContent function calls beside choices.message', async () => {
    let requests = 0, toolCount = 0;
    const messages = [{ role: 'user', content: 'Edit the requested entry' }];
    const hostGeminiTurn = {
        choices: [{ message: { content: 'character 50 0\nchat 50 0' } }],
        responseContent: { role: 'model', parts: [
            { text: 'Inspecting the authorized books.' },
            { functionCall: { name: 'list_books', args: {} }, thoughtSignature: 'gemini-thought-signature' },
        ] },
    };
    const result = await runAgentLoop({ messages, settings,
        tools: { definitions: [{ type: 'function', function: { name: 'list_books', parameters: { type: 'object' } } }],
            execute: async () => { toolCount++; return { books: [{ id: 'character', name: 'Main', count: 50 }] }; } },
        request: async ({ messages: current }) => {
            requests++;
            if (requests === 1) return hostGeminiTurn;
            const assistant = current.find((message) => message.role === 'assistant' && message.tool_calls);
            assert.equal(assistant.tool_calls[0].function.name, 'list_books');
            assert.equal(assistant.tool_calls[0].signature, 'gemini-thought-signature');
            assert.equal(assistant.content, 'Inspecting the authorized books.');
            assert.doesNotMatch(assistant.content, /character 50 0|chat 50 0/);
            assert.equal(current.at(-1).role, 'tool');
            assert.match(current.at(-1).content, /Main/);
            return answer('找到授权书了，我来修改墨涟条目。');
        },
    });
    assert.equal(result.text, '找到授权书了，我来修改墨涟条目。');
    assert.equal(requests, 2); assert.equal(toolCount, 1);
});

test('OpenRouter Gemini extra_content thought signatures survive assistant tool-call replay', async () => {
    const messages = [];
    let requests = 0;
    await runAgentLoop({ messages, settings, tools: tools(async () => ({ ok: true })),
        request: async ({ messages: current }) => requests++ === 0
            ? calls({ ...call('read'), extra_content: { google: { thought_signature: 'router-signature' } } })
            : (assert.deepEqual(current.find((m) => m.role === 'assistant').tool_calls[0].extra_content, { google: { thought_signature: 'router-signature' } }), answer('Done')) });
    assert.equal(requests, 2);
});

test('standardized Gemini tool calls inherit thought signatures from adjacent native response parts', () => {
    const turn = parseAgentTurn({
        choices: [{ message: { content: '', tool_calls: [call('read')] } }],
        responseContent: { parts: [{ functionCall: { name: 'read', args: {} }, thoughtSignature: 'native-signature' }] },
    });
    assert.equal(turn.calls[0].signature, 'native-signature');
});

test('runtime schema validation rejects malformed UIDs, unknown keys and prototype paths', () => {
    const schema = { type: 'object', properties: { uid: { type: 'integer', minimum: 0 }, patch: { type: 'object' } }, required: ['uid'], additionalProperties: false };
    assert.throws(() => validateAgentArguments({ uid: '__proto__' }, schema), /integer/);
    assert.throws(() => validateAgentArguments({ uid: 0, fetch: '/secrets' }, schema), /未定义/);
    assert.throws(() => validateAgentArguments(JSON.parse('{"uid":0,"patch":{"__proto__":{"admin":true}}}'), schema), /禁止/);
    validateAgentArguments({ uid: 0, patch: { content: 'Valid' } }, schema);
});

test('dedicated API payload contains only supplied agent messages and tools', async () => {
    const messages = [{ role: 'user', content: 'Task' }], definitions = tools().definitions;
    const payload = await buildAgentPayload({ connection: 'custom', url: 'https://api.example.com', key: 'local-secret', model: 'model', maxTokens: 4096, temperature: 0.6 }, messages, definitions, { getContext: () => ({}) });
    assert.equal(payload.reverse_proxy, 'https://api.example.com/v1');
    assert.equal(payload.proxy_password, 'local-secret'); assert.equal(payload.stream, false);
    assert.deepEqual(payload.messages, messages); assert.deepEqual(payload.tools, definitions);
    await assert.rejects(buildAgentPayload({ connection: 'custom', url: 'file:///bad', model: 'model' }, [], [], { getContext: () => ({}) }), /HTTP/);
});

test('Gemini 4 official OpenAI endpoint path, reasoning and output-token floor are adapted', async () => {
    const messages = [{ role: 'user', content: 'Use tools' }], definitions = tools().definitions;
    for (const url of ['https://generativelanguage.googleapis.com', 'https://generativelanguage.googleapis.com/v1beta/openai/',
        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions']) {
        const payload = await buildAgentPayload({ connection: 'custom', url, key: 'local', model: 'gemini-4-hydrogen', maxTokens: 4096, temperature: 0.6 }, messages, definitions, { getContext: () => ({}) });
        assert.equal(payload.reverse_proxy, 'https://generativelanguage.googleapis.com/v1beta/openai');
        assert.equal(payload.reasoning_effort, 'medium');
        assert.equal(payload.max_tokens, 16384);
    }
    const userLimit = await buildAgentPayload({ connection: 'custom', url: 'https://generativelanguage.googleapis.com/v1beta/openai', key: 'local', model: 'gemini-4-neon', maxTokens: 32768, temperature: 0.5 }, messages, definitions, { getContext: () => ({}) });
    assert.equal(userLimit.max_tokens, 32768);
    assert.equal(userLimit.reasoning_effort, 'medium');
    await assert.rejects(buildAgentPayload({ connection: 'custom', url: 'https://generativelanguage.googleapis.com/v1beta/models', model: 'gemini-4-hydrogen' }, [], [], { getContext: () => ({}) }), /v1beta\/openai/);
    const other = await buildAgentPayload({ connection: 'custom', url: 'https://api.example.com', model: 'gemini-3.6-flash', maxTokens: 4096 }, messages, definitions, { getContext: () => ({}) });
    assert.equal(other.reasoning_effort, undefined); assert.equal(other.max_tokens, 4096);
});

test('Gemini unicode routing metadata includes the user floor only for Gemini models', async () => {
    const messages = [{ role: 'user', content: '请查询条目' }], definitions = tools().definitions;
    const gemini = await buildAgentPayload({ connection: 'custom', url: 'https://router.example/api', model: 'gemini-3.8-flash', maxTokens: 8000 }, messages, definitions,
        { getContext: () => ({}), routerUnicodeInput: { user_floor: 42 } });
    assert.deepEqual(gemini.router_unicode_input, { user_floor: 42 });
    const openai = await buildAgentPayload({ connection: 'custom', url: 'https://router.example/api', model: 'gpt-6.1', maxTokens: 8000 }, messages, definitions,
        { getContext: () => ({}), routerUnicodeInput: { user_floor: 42 } });
    assert.equal(openai.router_unicode_input, undefined);
    const invalid = await buildAgentPayload({ connection: 'custom', url: 'https://router.example/api', model: 'gemini-pro', maxTokens: 8000 }, messages, definitions,
        { getContext: () => ({}), routerUnicodeInput: { user_floor: -1 } });
    assert.equal(invalid.router_unicode_input, undefined);
});

test('main connection cannot inject role cards, global tool definitions or body overrides', async () => {
    const messages = [{ role: 'user', content: 'Only this' }], definitions = tools().definitions;
    const payload = await buildAgentPayload({ connection: 'main', maxTokens: 2000, temperature: 0.5 }, messages, definitions,
        { getContext: () => ({ mainApi: 'openai' }), loadMain: async () => ({ oai_settings: {}, getChatCompletionModel: () => 'Current model', createGenerationParameters: async (_settings, model) => ({ generate_data: {
            model, stop: ['</report>'], char_name: 'Role name', user_name: 'Persona name', assistant_prefill: 'Hidden text', enable_web_search: true,
            messages: [{ role: 'system', content: 'Role card' }], tools: [{ function: { name: 'exec' } }],
            custom_include_body: 'messages: secret', custom_exclude_body: 'tools', custom_include_headers: 'X: secret',
        } }) }) });
    assert.deepEqual(payload.messages, messages); assert.deepEqual(payload.tools, definitions);
    assert.equal(payload.custom_include_body, undefined); assert.equal(payload.custom_include_headers, undefined);
    assert.equal(payload.model, 'Current model'); assert.equal(payload.stop, undefined); assert.equal(payload.char_name, undefined);
    assert.equal(payload.assistant_prefill, undefined); assert.equal(payload.enable_web_search, false);
    await assert.rejects(buildAgentPayload({ connection: 'main' }, [], [], { getContext: () => ({ mainApi: 'textgenerationwebui' }) }), /Chat Completion/);
});
