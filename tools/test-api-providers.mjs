import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { buildGenerationPayload, callModel, fetchModelList, normalizeOpenCodeGoBaseUrl } from '../src/ai.js';
import { buildAgentPayload, requestAgent } from '../src/agent-api.js';
import { parseAgentTurn, runAgentLoop } from '../src/agent-runner.js';
import { buildMessages } from '../src/jailbreak.js';
import { getApiConfig, getApiProfiles, normalizeConfigData, saveApiConfig, saveApiProfile } from '../src/config.js';

function installContext(chatId = 'chat-a', avatar = 'character.png') {
    const c = {
        extensionSettings: {},
        chatId,
        characterId: 0,
        characters: [{ avatar }],
        groupId: null,
        getCurrentChatId: () => chatId,
        saveSettingsDebounced() {},
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    };
    globalThis.window = { SillyTavern: { getContext: () => c } };
    return c;
}

test('DeepSeek uses the official preset endpoint and an explicit default-off thinking mode', () => {
    installContext();
    const apiCfg = {
        provider: 'custom', url: 'https://api.deepseek.com/v1', key: 'test-key', model: 'deepseek-flash',
        thinkingEnabled: false, stream: true,
    };
    const payload = buildGenerationPayload({
        apiCfg,
        genParams: { enabled: true, reasoning_effort: 'high' },
        messages: [{ role: 'user', content: 'test' }],
    });
    assert.equal(payload.chat_completion_source, 'custom');
    assert.equal(payload.custom_url, 'https://api.deepseek.com/v1');
    assert.equal(payload.proxy_password, undefined);
    assert.equal(JSON.parse(payload.custom_include_headers).Authorization, 'Bearer test-key');
    assert.deepEqual(JSON.parse(payload.custom_include_body), { thinking: { type: 'disabled' } });
    assert.equal(payload.reasoning_effort, undefined);

    const enabled = buildGenerationPayload({
        apiCfg: { ...apiCfg, thinkingEnabled: true },
        genParams: { enabled: true, reasoning_effort: 'high' },
        messages: [],
    });
    assert.deepEqual(JSON.parse(enabled.custom_include_body), { thinking: { type: 'enabled' }, reasoning_effort: 'high' });
});

test('OpenCode Go uses the OpenAI endpoint path and stable required headers', () => {
    const c = installContext('chat-opencode');
    assert.equal(normalizeOpenCodeGoBaseUrl('https://opencode.ai/inference/go'), 'https://opencode.ai/inference/go/openai/v1');
    const apiCfg = {
        provider: 'custom', url: 'https://opencode.ai/inference/go/openai/v1', key: 'test-key', model: 'kimi-k3', stream: true,
    };
    const payload = buildGenerationPayload({ apiCfg, messages: [{ role: 'user', content: 'test' }] });
    const headers = JSON.parse(payload.custom_include_headers);
    assert.equal(payload.chat_completion_source, 'custom');
    assert.equal(payload.custom_url, 'https://opencode.ai/inference/go/openai/v1');
    assert.equal(headers.Authorization, 'Bearer test-key');
    assert.equal(headers['User-Agent'], 'RubyAnalyzer/1.0');
    assert.match(headers['x-opencode-session'], /^ses_/);
    assert.equal(buildGenerationPayload({ apiCfg, messages: [] }).custom_include_headers, payload.custom_include_headers);
    installContext('another-chat');
    const otherHeaders = JSON.parse(buildGenerationPayload({ apiCfg, messages: [] }).custom_include_headers);
    assert.notEqual(otherHeaders['x-opencode-session'], headers['x-opencode-session']);
    installContext('chat-opencode', 'another-character.png');
    const otherCharacterHeaders = JSON.parse(buildGenerationPayload({ apiCfg, messages: [] }).custom_include_headers);
    assert.notEqual(otherCharacterHeaders['x-opencode-session'], headers['x-opencode-session']);
    assert.ok(c.extensionSettings);
});

test('OpenCode Go model discovery uses its documented models endpoint through Tavern', async () => {
    const c = installContext();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        assert.equal(url, '/api/backends/chat-completions/status');
        const request = JSON.parse(options.body);
        assert.equal(request.chat_completion_source, 'custom');
        assert.equal(request.custom_url, 'https://opencode.ai/inference/go/v1');
        assert.equal(JSON.parse(request.custom_include_headers).Authorization, 'Bearer test-key');
        return { ok: true, json: async () => ({ data: [
            { id: 'kimi-k3', type: 'chat' }, { id: 'glm-5.3' },
            { id: 'text-embedding-3-small', type: 'embedding' }, { id: 'jev-1.14', type: 'decision' },
        ] }) };
    };
    try {
        assert.deepEqual(await fetchModelList('https://opencode.ai/inference/go/openai/v1', 'test-key'), ['kimi-k3', 'glm-5.3']);
    } finally {
        globalThis.fetch = originalFetch;
        assert.ok(c.getRequestHeaders);
    }
});

test('Agent requests use the OpenCode Go session-aware custom transport', async () => {
    installContext('agent-chat');
    const payload = await buildAgentPayload(
        { connection: 'ruby', maxTokens: 256, temperature: 0.2 },
        [{ role: 'user', content: 'test' }],
        [],
        { getRubyApi: () => ({
            provider: 'custom', url: 'https://opencode.ai/inference/go/openai/v1', key: 'test-key', model: 'kimi-k3',
        }) },
    );
    const headers = JSON.parse(payload.custom_include_headers);
    assert.equal(payload.chat_completion_source, 'custom');
    assert.equal(payload.custom_url, 'https://opencode.ai/inference/go/openai/v1');
    assert.equal(headers.Authorization, 'Bearer test-key');
    assert.match(headers['x-opencode-session'], /^ses_/);
});

test('thinking defaults off and survives API profile persistence without entering character config', () => {
    installContext();
    assert.equal(getApiConfig().thinkingEnabled, false);
    saveApiConfig({
        provider: 'custom', url: 'https://api.deepseek.com/v1', model: 'deepseek-flash', key: 'test-key',
        thinkingEnabled: true,
    });
    saveApiProfile({ ...getApiConfig(), name: 'DeepSeek' });
    assert.equal(getApiConfig().thinkingEnabled, true);
    assert.equal(getApiProfiles()[0].thinkingEnabled, true);
    assert.equal(getApiProfiles()[0].key, 'test-key');
    const cardConfig = normalizeConfigData({ api: getApiConfig() });
    assert.equal(cardConfig.api, undefined);
    assert.ok(!JSON.stringify(cardConfig).includes('test-key'));
});

test('DeepSeek analysis sends reasoning fields for prefills and preserves real reasoning in both modes and transports', () => {
    installContext();
    const messages = buildMessages('test', 'Analyze the supplied facts', {});
    messages.splice(-1, 0, { role: 'assistant', content: 'Previous answer', reasoning_content: '  Original reasoning\n' });
    const original = structuredClone(messages);
    for (const thinkingEnabled of [false, true]) {
        for (const stream of [false, true]) {
            const payload = buildGenerationPayload({
                apiCfg: { provider: 'custom', url: 'https://api.deepseek.com/v1', model: 'deepseek-flash', thinkingEnabled, stream },
                messages,
            });
            const assistants = payload.messages.filter((m) => m.role === 'assistant');
            assert.equal(assistants.length, 3);
            assert.deepEqual(assistants.map((m) => m.reasoning_content), ['', '', '  Original reasoning\n']);
            assert.ok(payload.messages.filter((m) => m.role !== 'assistant').every((m) => !('reasoning_content' in m)));
        }
    }
    assert.deepEqual(messages, original);
});

test('DeepSeek compatible gateways receive reasoning fields without changing other models', () => {
    const messages = [
        { role: 'assistant', content: 'Prefill' },
        { role: 'assistant', content: 'Stored answer', reasoning: 'Gateway reasoning' },
        { role: 'assistant', content: 'No thinking', reasoning_content: '', reasoning: 'Must not override an explicit field' },
        { role: 'assistant', content: 'Legacy answer', reasoning_content: null },
        { role: 'user', content: 'Continue' },
    ];
    const apiCfg = { provider: 'custom', url: 'https://gateway.example/v1', model: 'vendor/deepseek-pro' };
    const payload = buildGenerationPayload({ apiCfg, messages });
    assert.equal(payload.reverse_proxy, apiCfg.url);
    assert.deepEqual(payload.messages.slice(0, 4).map((m) => m.reasoning_content), ['', 'Gateway reasoning', '', '']);
    const other = buildGenerationPayload({ apiCfg: { ...apiCfg, model: 'gemini-test' }, messages });
    assert.deepEqual(other.messages, messages);
    assert.equal(other.custom_prompt_post_processing, undefined);
});

test('ordinary DeepSeek analysis reaches the Tavern service with the required reasoning fields', async () => {
    const c = installContext();
    let requests = 0;
    c.ChatCompletionService = {
        createRequestData: (payload) => payload,
        processRequest: async (payload) => {
            const assistants = payload.messages.filter((m) => m.role === 'assistant');
            if (assistants.some((m) => typeof m.reasoning_content !== 'string')) {
                throw new Error('The `reasoning_content` in the thinking mode must be passed back to the API.');
            }
            requests++;
            return payload.stream ? async function* () { yield { text: 'Analysis complete' }; } : { content: 'Analysis complete' };
        },
    };
    for (const stream of [false, true]) {
        const text = await callModel({
            apiCfg: { provider: 'custom', url: 'https://api.deepseek.com/v1', model: 'deepseek-flash', thinkingEnabled: true, stream },
            genParams: { enabled: false }, messages: buildMessages('test', 'Analyze facts', {}),
        });
        assert.equal(text, 'Analysis complete');
    }
    assert.equal(requests, 2);
});

test('main API repairs DeepSeek messages with sampling overrides disabled and leaves concurrent requests alone', async () => {
    for (const source of ['deepseek', 'custom', 'openai']) {
        const c = installContext();
        const event = 'settings-ready';
        c.mainApi = 'openai';
        c.eventSource = new EventEmitter();
        c.eventTypes = { CHAT_COMPLETION_SETTINGS_READY: event };
        const messages = [{ role: 'assistant', content: 'Prefill' }, { role: 'user', content: 'Analyze' }];
        c.generateRaw = async ({ prompt }) => {
            const unrelated = { chat_completion_source: source, model: 'deepseek-flash', messages: [{ role: 'assistant', content: 'Other request' }] };
            c.eventSource.emit(event, unrelated);
            assert.equal(unrelated.messages[0].reasoning_content, undefined);
            const outgoing = { chat_completion_source: source, model: 'deepseek-flash', messages: prompt,
                custom_prompt_post_processing: 'merge', temperature: 0.8 };
            c.eventSource.emit(event, outgoing);
            assert.equal(outgoing.messages[0].reasoning_content, '');
            assert.equal(outgoing.temperature, 0.8);
            assert.equal(outgoing.custom_prompt_post_processing, '');
            return 'Analysis complete';
        };
        assert.equal(await callModel({ apiCfg: { provider: 'main' }, genParams: { enabled: false }, messages }), 'Analysis complete');
        assert.equal(c.eventSource.listenerCount(event), 0);
        assert.equal(messages[0].reasoning_content, undefined);
        c.generateRaw = async () => { throw new Error('Generation interrupted'); };
        await assert.rejects(callModel({ apiCfg: { provider: 'main' }, genParams: { enabled: false }, messages }), /Generation interrupted/);
        assert.equal(c.eventSource.listenerCount(event), 0);
    }
});

test('Agent main and independent DeepSeek connections replay reasoning fields without altering history', async () => {
    const messages = [
        { role: 'assistant', content: 'Legacy prefill' },
        { role: 'assistant', content: '', reasoning_content: 'Exact tool reasoning',
            tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'read-1', content: 'Facts' },
    ];
    const original = structuredClone(messages);
    const standalone = await buildAgentPayload({ connection: 'custom', url: 'https://gateway.example/v1', model: 'deepseek-test' }, messages, [],
        { getContext: () => ({}) });
    const main = await buildAgentPayload({ connection: 'main' }, messages, [], {
        getContext: () => ({ mainApi: 'openai' }),
        loadMain: async () => ({ oai_settings: {}, getChatCompletionModel: () => 'aliased-model',
            createGenerationParameters: async () => ({ generate_data: { chat_completion_source: 'deepseek', model: 'aliased-model' } }) }),
    });
    for (const payload of [standalone, main]) {
        assert.equal(payload.messages[0].reasoning_content, '');
        assert.equal(payload.messages[1].reasoning_content, 'Exact tool reasoning');
        assert.deepEqual(payload.messages[1].tool_calls, messages[1].tool_calls);
        assert.equal(payload.messages[2].reasoning_content, undefined);
    }
    assert.deepEqual(messages, original);
});

test('DeepSeek Agent sends actual returned reasoning on tool continuation and the next user turn', async (t) => {
    const c = installContext();
    const previousFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = previousFetch; });
    const toolCall = { id: 'read-1', type: 'function', function: { name: 'read', arguments: '{}' } };
    const reasonings = ['  Tool reasoning\n', 'Final reasoning', 'Follow-up reasoning'];
    const requests = [];
    globalThis.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        const assistants = payload.messages.filter((m) => m.role === 'assistant');
        assert.ok(assistants.every((m) => typeof m.reasoning_content === 'string'));
        const turn = requests.length;
        const reply = turn === 1
            ? { content: '', reasoning_content: reasonings[0], tool_calls: [toolCall] }
            : { content: turn === 2 ? 'Checked.' : 'Follow-up complete.', reasoning: reasonings[turn - 1] };
        return { ok: true, json: async () => ({ choices: [{ message: reply }] }) };
    };
    const settings = { connection: 'custom', url: 'https://api.deepseek.com/v1', model: 'deepseek-flash', thinkingEnabled: true,
        maxTokens: 4096, maxRequests: 5, maxMinutes: 1, retries: 0, contextChars: 0 };
    const messages = [{ role: 'assistant', content: 'Legacy prefill' }, { role: 'user', content: 'Read facts' }];
    const options = { messages, settings,
        tools: { definitions: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }], execute: async () => ({ facts: 'Read successfully' }) },
        request: (args) => requestAgent({ ...args, settings, getContext: () => c }),
        limiter: { acquire: async () => {} },
    };
    await runAgentLoop(options);
    assert.equal(requests[1].messages.find((m) => m.tool_calls).reasoning_content, reasonings[0]);
    assert.deepEqual(messages.filter((m) => m.role === 'assistant').slice(1).map((m) => m.reasoning_content), reasonings.slice(0, 2));
    messages.push({ role: 'user', content: 'Continue with those facts' });
    await runAgentLoop(options);
    assert.deepEqual(requests[2].messages.filter((m) => m.role === 'assistant').map((m) => m.reasoning_content), ['', ...reasonings.slice(0, 2)]);
    assert.equal(messages.at(-1).reasoning_content, reasonings[2]);
    assert.equal(parseAgentTurn({ choices: [{ message: { content: 'No thinking', reasoning_content: '', reasoning: 'Ignore alias' } }] }).reasoning, '');
});
