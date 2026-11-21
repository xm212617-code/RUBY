import { ctx } from './env.js';
import { getApiConfig } from './config.js';
import { normalizeBaseUrl } from './ai.js';

function normalizeAgentBaseUrl(raw) {
    const url = new URL(raw);
    if (url.hostname.toLowerCase() !== 'generativelanguage.googleapis.com') {
        const path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
        if (/\/v\d+(?:beta\d*)?\/openai$/i.test(path) || /\/chat\/completions\/?$/i.test(url.pathname)) {
            url.pathname = path;
            url.search = ''; url.hash = '';
            return url.toString().replace(/\/$/, '');
        }
        if (/\/models\/[^/]+:(?:streamGenerateContent|generateContent)/i.test(path)) {
            throw new Error('Agent自定义连接使用OpenAI兼容协议，不能填写Gemini原生generateContent地址；请选酒馆主API或网关的OpenAI兼容地址');
        }
        return normalizeBaseUrl(raw);
    }
    let path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
    if (!path || path === '/') path = '/v1beta/openai';
    else if (path === '/v1beta' || path === '/v1') path += '/openai';
    else if (/^\/v1beta\/openai(?:\/v1)?$/i.test(path)) path = '/v1beta/openai';
    else throw new Error('Google Gemini OpenAI-compatible API 地址应以 /v1beta/openai 结尾');
    url.pathname = path;
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
}

/** Payload generation uses local connection settings; no role card/history/other tools are included. */
export async function buildAgentPayload(settings, messages, definitions, { getContext = ctx, getRubyApi = getApiConfig, loadMain = () => import('/scripts/openai.js'), routerUnicodeInput } = {}) {
    const c = getContext();
    const ruby = settings.connection === 'ruby' ? getRubyApi() : null;
    const viaMain = settings.connection === 'main' || (ruby && ruby.provider !== 'custom');
    let payload;
    let modelName = '';
    if (viaMain) {
        if (c?.mainApi !== 'openai') throw new Error('Agent 需要支持工具调用的聊天补全连接；请使用酒馆 Chat Completion 或配置 Agent 专用 API');
        const main = await loadMain();
        const model = main.getChatCompletionModel?.(main.oai_settings);
        if (!model) throw new Error('酒馆当前聊天补全连接尚未选择模型');
        modelName = model;
        const result = await main.createGenerationParameters(main.oai_settings, model, 'quiet', structuredClone(messages));
        payload = { ...result.generate_data };
        // User custom bodies can replace messages or invoke provider features outside the contract.
        delete payload.custom_include_body;
        delete payload.custom_exclude_body;
        delete payload.custom_include_headers;
        for (const field of ['assistant_prefill', 'assistant_impersonation', 'stop', 'logit_bias', 'user_name', 'char_name', 'group_names']) delete payload[field];
        payload.custom_prompt_post_processing = '';
        payload.enable_web_search = false;
        payload.request_images = false;
    } else {
        const url = ruby ? ruby.url : settings.url;
        const key = ruby ? ruby.key : settings.key;
        const model = ruby ? ruby.model : settings.model;
        if (!url?.trim() || !model?.trim()) throw new Error('请填写 Agent API 地址与模型名称，或选择已配置的连接');
        modelName = model;
        const parsed = new URL(url);
        if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('API地址必须是无内嵌凭据的HTTP(S)地址');
        payload = { chat_completion_source: 'openai', reverse_proxy: normalizeAgentBaseUrl(url), proxy_password: key || '', model };
    }
    const isGemini4 = /gemini-4-/i.test(modelName);
    return { ...payload, messages: structuredClone(messages), tools: structuredClone(definitions), tool_choice: 'auto',
        stream: false, n: 1, max_tokens: isGemini4 ? Math.max(settings.maxTokens, 16384) : settings.maxTokens,
        temperature: settings.temperature, ...(isGemini4 ? { reasoning_effort: 'medium' } : {}),
        ...(/gemini/i.test(modelName) && Number.isSafeInteger(routerUnicodeInput?.user_floor) && routerUnicodeInput.user_floor >= 0
            ? { router_unicode_input: routerUnicodeInput } : {}) };
}

export async function requestAgent({ settings, messages, definitions, signal, getContext = ctx, payloadDependencies, routerUnicodeInput, onConnection = () => {} }) {
    let payload;
    try {
        payload = await buildAgentPayload(settings, messages, definitions, { getContext, routerUnicodeInput, ...payloadDependencies });
    } catch (error) {
        throw new Error(`Agent请求准备失败（来源：${settings.connection}，尚未发送到酒馆后端）：${error.message}`);
    }
    if (signal?.aborted) throw Object.assign(new Error('Agent 已停止'), { name: 'AbortError' });
    let endpoint = '';
    try { const parsed = new URL(payload.reverse_proxy || payload.custom_url); endpoint = parsed.origin + parsed.pathname; } catch { endpoint = '酒馆供应商默认端点'; }
    onConnection({ selection: settings.connection, source: payload.chat_completion_source, model: payload.model, endpoint });
    const c = getContext();
    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST', headers: { ...c.getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.error) {
        const detail = typeof data?.error === 'string' ? data.error : data?.error?.message || data?.message || '请求失败';
        const error = new Error(`酒馆请求返回 HTTP ${response.status}（来源：${payload.chat_completion_source}，模型：${payload.model}；上游是否收到需查酒馆日志）：${String(detail)}`);
        const retryAfter = response.headers.get('Retry-After');
        if (retryAfter) error.retryAfterMs = /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
        throw error;
    }
    return data;
}
