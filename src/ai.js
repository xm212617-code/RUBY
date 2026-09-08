import { ctx, log, warn } from './env.js';

const REQUEST_TIMEOUT_MS = 600000;

export function normalizeBaseUrl(raw) {
    const base = String(raw || '').trim().replace(/\/+$/, '');
    if (!base) return '';
    const url = base.replace(/\/chat\/completions$/i, '');
    if (/\/(v\d+|beta)$/i.test(url)) return url;
    return url + '/v1';
}

function friendlyError(err) {
    const msg = String(err?.message || err || '');
    if (msg.includes('ECONNRESET') || msg.includes('socket hang up')) {
        return 'API连接中断，请检查网络或API配置';
    }
    if (msg.includes('ETIMEDOUT') || msg.includes('timeout') || msg.includes('Timeout')) {
        return 'API请求超时，请稍后重试';
    }
    return msg || '未知错误';
}

function buildGenerationPayload({ apiCfg, genParams, messages }) {
    const payload = {
        messages,
        model: apiCfg.model,
        chat_completion_source: 'openai',
        reverse_proxy: normalizeBaseUrl(apiCfg.url),
        proxy_password: apiCfg.key || '',
        stream: apiCfg.stream !== false,
    };
    const pushNum = (k, v) => {
        const n = Number(v);
        if (Number.isFinite(n)) payload[k] = n;
    };
    pushNum('temperature', genParams.temperature);
    pushNum('top_p', genParams.top_p);
    pushNum('top_k', genParams.top_k);
    pushNum('presence_penalty', genParams.presence_penalty);
    pushNum('frequency_penalty', genParams.frequency_penalty);
    pushNum('max_tokens', genParams.max_tokens);
    if (genParams.reasoning_effort) {
        payload.reasoning_effort = String(genParams.reasoning_effort);
    }
    return payload;
}

/**
 * 酒馆官方请求服务（ST 1.16 custom-request.js 的 ChatCompletionService）：
 * 与正常聊天生成共用同一后端端点、同一负载组装约定、同一 SSE 解析器
 * （EventSourceStream + getStreamingReply），出站请求与普通酒馆生成完全同形。
 */
async function callViaTavernService({ apiCfg, genParams, messages, signal }) {
    const c = ctx();
    const service = c?.ChatCompletionService;
    if (!service || typeof service.processRequest !== 'function') {
        return null;
    }
    const payload = service.createRequestData
        ? service.createRequestData(buildGenerationPayload({ apiCfg, genParams, messages }))
        : buildGenerationPayload({ apiCfg, genParams, messages });

    const result = await service.processRequest(payload, {}, true, signal);

    if (payload.stream) {
        if (typeof result !== 'function') {
            throw new Error('流式响应格式异常');
        }
        let text = '';
        for await (const chunk of result()) {
            text = chunk.text || text;
        }
        if (!text.trim()) throw new Error('API返回内容为空');
        return text;
    }

    const content = result?.content;
    if (!content || String(content).trim().length < 1) throw new Error('API返回内容为空');
    return String(content);
}

function extractContentFromResponse(data) {
    const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
    if (choice?.message?.content !== undefined) return String(choice.message.content);
    if (choice?.text !== undefined) return String(choice.text);
    if (typeof data?.content === 'string') return data.content;
    if (typeof data?.text === 'string') return data.text;
    return '';
}

/**
 * 兼容回退：直接请求酒馆后端端点（无 ChatCompletionService 的环境）。
 * 仍然由酒馆服务端转发出站，不产生浏览器直连。
 */
async function callViaBackendEndpoint({ apiCfg, genParams, messages }) {
    const c = ctx();
    if (!c || typeof c.getRequestHeaders !== 'function') throw new Error('SillyTavern context unavailable');
    const payload = buildGenerationPayload({ apiCfg, genParams, messages });
    if (!payload.reverse_proxy) throw new Error('未配置API地址');
    if (!payload.model) throw new Error('未配置模型名称');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: { ...c.getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status}: ${errText.slice(0, 300)}`);
        }

        if (payload.stream && response.body) {
            return await readSseStream(response);
        }

        const data = await response.json();
        if (data?.error) throw new Error(String(data.message || data.error?.message || 'API returned error'));
        const text = extractContentFromResponse(data);
        if (!text) throw new Error('API返回内容为空');
        return text;
    } catch (e) {
        if (e?.name === 'AbortError' || String(e?.message || e) === 'timeout') {
            throw new Error('API请求超时，请稍后重试');
        }
        throw new Error(friendlyError(e));
    } finally {
        clearTimeout(timer);
    }
}

async function readSseStream(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
                const chunk = JSON.parse(payload);
                if (chunk.error) throw new Error(String(chunk.message || 'stream error'));
                const delta = chunk.choices?.[0]?.delta?.content;
                if (typeof delta === 'string') result += delta;
                const messageContent = chunk.choices?.[0]?.message?.content;
                if (!delta && typeof messageContent === 'string') result += messageContent;
            } catch (e) {
                if (e instanceof SyntaxError) continue;
                throw e;
            }
        }
    }
    if (!result.trim()) throw new Error('API返回内容为空');
    return result;
}

/**
 * 主API路径：走酒馆原生 generateRaw 的 quiet 调用。
 * - 提示词绕过预设注入：quiet 调用不经 prepareOpenAIMessages（main prompt/jailbreak/角色卡/聊天记录
 *   均不会注入），发送的只有 RUBY 破限组装出的消息数组，与酒馆自身静默提示词同一机制；
 * - 采样参数：quiet 调用默认继承当前预设的采样设置，这里通过官方 CHAT_COMPLETION_SETTINGS_READY
 *   事件钩子按 RUBY 配置覆写（引用比对确认只作用于本次请求，收到即摘除）。
 */
async function callMainApi({ genParams, messages }) {
    const c = ctx();
    if (!c || typeof c.generateRaw !== 'function') throw new Error('generateRaw unavailable');

    const options = { prompt: messages };
    const maxLength = Number(genParams.max_tokens);
    if (Number.isFinite(maxLength) && maxLength > 0) {
        options.responseLength = maxLength;
    }

    const patchable = {};
    for (const key of ['temperature', 'top_p', 'top_k', 'presence_penalty', 'frequency_penalty']) {
        const v = Number(genParams[key]);
        if (Number.isFinite(v)) patchable[key] = v;
    }
    if (genParams.reasoning_effort) patchable.reasoning_effort = String(genParams.reasoning_effort);

    let hook = null;
    const detach = () => {
        if (hook) {
            c.eventSource.removeListener(c.eventTypes.CHAT_COMPLETION_SETTINGS_READY, hook);
            hook = null;
        }
    };

    const isChatCompletion = c.mainApi === 'openai';
    if (Object.keys(patchable).length > 0 && isChatCompletion && c.eventSource && c.eventTypes?.CHAT_COMPLETION_SETTINGS_READY) {
        const marker = messages[0];
        hook = (generateData) => {
            // 引用比对：createRawPrompt/createGenerationParameters 均不替换消息对象，引用不变
            if (!Array.isArray(generateData?.messages) || !generateData.messages.includes(marker)) return;
            Object.assign(generateData, patchable);
            detach();
        };
        c.eventSource.on(c.eventTypes.CHAT_COMPLETION_SETTINGS_READY, hook);
    } else if (Object.keys(patchable).length > 0 && !isChatCompletion) {
        warn('当前主API为文本补全通道，RUBY生成参数不覆写（沿用酒馆当前连接的采样设置）');
    }

    try {
        const text = await c.generateRaw(options);
        if (!text || String(text).trim().length < 1) throw new Error('API返回内容为空');
        return String(text);
    } finally {
        detach();
    }
}

export async function callModel({ apiCfg, genParams, messages, taskLabel }) {
    const viaMain = apiCfg.provider !== 'custom';
    log(`AI call: ${taskLabel || 'task'} | channel=${viaMain ? 'tavern generateRaw quiet (主通道，绕过预设注入)' : 'tavern ChatCompletionService (自定义端点)'} | model=${viaMain ? '当前酒馆连接' : (apiCfg.model || '未设置')}`);

    if (viaMain) {
        return callMainApi({ genParams, messages });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS);
    try {
        const text = await callViaTavernService({ apiCfg, genParams, messages, signal: controller.signal });
        if (text !== null) return text;
        warn('ChatCompletionService unavailable, falling back to backend endpoint request');
        return await callViaBackendEndpoint({ apiCfg, genParams, messages });
    } catch (e) {
        if (e?.name === 'AbortError' || String(e?.message || e) === 'timeout') {
            throw new Error('API请求超时，请稍后重试');
        }
        throw new Error(friendlyError(e));
    } finally {
        clearTimeout(timer);
    }
}

export async function fetchModelList(baseUrl, apiKey) {
    const c = ctx();
    const cleanBase = String(baseUrl || '').trim()
        .replace(/\/+$/, '')
        .replace(/\/(?:v\d+|beta)\/chat\/completions$/i, '')
        .replace(/\/chat\/completions$/i, '')
        .replace(/\/models$/i, '');

    if (!cleanBase) throw new Error('请填写API地址');

    if (typeof c?.getRequestHeaders === 'function') {
        try {
            const res = await fetch('/api/backends/chat-completions/status', {
                method: 'POST',
                headers: c.getRequestHeaders(),
                body: JSON.stringify({
                    chat_completion_source: 'openai',
                    reverse_proxy: cleanBase,
                    proxy_password: apiKey || '',
                }),
            });
            if (res.ok) {
                const data = await res.json();
                const items = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter(Boolean) : [];
                if (items.length > 0) return [...new Set(items)];
            }
        } catch { /* fall through to direct fetch */ }
    }

    const candidates = [...new Set([
        `${cleanBase}/models`,
        `${cleanBase}/v1/models`,
        /\/(v\d+|beta)$/i.test(cleanBase) ? `${cleanBase.replace(/\/(v\d+|beta)$/i, '')}/v1/models` : '',
    ].filter(Boolean))];

    let lastError = '';
    for (const url of candidates) {
        try {
            const res = await fetch(url, {
                headers: { 'Authorization': `Bearer ${apiKey || ''}`, 'Accept': 'application/json' },
            });
            if (res.ok) {
                const data = await res.json();
                const items = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter(Boolean) : [];
                if (items.length > 0) return [...new Set(items)];
            }
            lastError = `${res.status} ${res.statusText || ''}`.trim();
        } catch (e) {
            lastError = e?.message || '';
        }
    }
    throw new Error(`连接失败，请检查 URL 和 KEY${lastError ? `（${lastError}）` : ''}`);
}
