import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGenerationPayload, fetchModelList, normalizeOpenCodeGoBaseUrl } from '../src/ai.js';
import { buildAgentPayload } from '../src/agent-api.js';
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
