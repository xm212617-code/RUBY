const abortError = () => Object.assign(new Error('Agent 已停止'), { name: 'AbortError' });
let responseSequence = 0;

export function validateAgentArguments(value, schema = {}, path = '参数', depth = 0) {
    if (depth > 20) throw new Error('工具参数嵌套过深');
    if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
            if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('工具参数含禁止的对象键');
            validateAgentArguments(item, {}, path + '.' + key, depth + 1);
        }
    }
    if (schema.type) {
        const matches = schema.type === 'integer' ? Number.isSafeInteger(value)
            : schema.type === 'array' ? Array.isArray(value)
                : schema.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
                    : typeof value === schema.type;
        if (!matches) throw new Error(`${path}必须是${schema.type}`);
    }
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path}不在允许值中`);
    if (typeof value === 'string' && (schema.minLength != null && value.length < schema.minLength || schema.maxLength != null && value.length > schema.maxLength)) throw new Error(`${path}长度超出限制`);
    if (typeof value === 'number' && (schema.minimum != null && value < schema.minimum || schema.maximum != null && value > schema.maximum)) throw new Error(`${path}数值超出限制`);
    if (Array.isArray(value)) {
        if (schema.minItems != null && value.length < schema.minItems || schema.maxItems != null && value.length > schema.maxItems) throw new Error(`${path}数量超出限制`);
        if (schema.items) value.forEach((item, index) => validateAgentArguments(item, schema.items, `${path}[${index}]`, depth + 1));
    } else if (value && typeof value === 'object') {
        for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`${path}缺少${key}`);
        for (const [key, item] of Object.entries(value)) {
            if (schema.additionalProperties === false && !Object.hasOwn(schema.properties || {}, key)) throw new Error(`${path}含未定义字段${key}`);
            if (schema.properties?.[key]) validateAgentArguments(item, schema.properties[key], path + '.' + key, depth + 1);
        }
    }
}

export function abortableDelay(ms, signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
        const done = () => { signal?.removeEventListener('abort', cancel); resolve(); };
        const timer = setTimeout(done, Math.max(0, ms));
        const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(abortError()); };
        signal?.addEventListener('abort', cancel, { once: true });
    });
}

/** Sliding-window request limiter; keep one instance across user turns and retries. */
export function createRequestLimiter({ now = Date.now, delay = abortableDelay } = {}) {
    let starts = [];
    let last = -Infinity;
    return {
        async acquire({ rpm, minIntervalMs }, signal, onWait = () => {}) {
            while (true) {
                if (signal?.aborted) throw abortError();
                const time = now();
                starts = starts.filter((at) => time - at < 60000);
                const target = Math.max(last + Math.max(0, minIntervalMs || 0), starts.length >= rpm ? starts[0] + 60000 : time);
                if (target <= time) { starts.push(time); last = time; onWait(0); return; }
                onWait(target);
                await delay(target - time, signal);
            }
        },
    };
}

export function parseAgentTurn(raw) {
    if (raw?.error) throw new Error(String(raw.error.message || raw.error));
    const choice = raw?.choices?.find((c) => c.index === 0) || raw?.choices?.[0];
    const googleParts = raw?.responseContent?.parts || raw?.candidates?.[0]?.content?.parts;
    let text = '';
    let calls = [];
    if (choice?.message) {
        const message = choice.message;
        text = typeof message.content === 'string' ? message.content : (message.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
        calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (calls.length && Array.isArray(googleParts)) {
            const nativeCalls = googleParts.filter((part) => part.functionCall);
            if (nativeCalls.length) {
                // The ST 1.16 OpenAI-shaped content can be a text serialization of
                // tool metadata; use the original Gemini parts as the authoritative turn.
                text = googleParts.filter((part) => typeof part.text === 'string' && !part.thought).map((part) => part.text).join('\n');
            }
            calls = calls.map((call, index) => {
                const native = nativeCalls.find((part) => part.functionCall.name === call.function?.name) || nativeCalls[index];
                if (!native?.thoughtSignature) return call;
                return { ...call, signature: call.signature || native.thoughtSignature };
            });
        }
        // ST 1.16 wraps native Gemini candidates in choices[0].message, but leaves
        // functionCall parts in responseContent instead of converting them to tool_calls.
        if (!calls.length && Array.isArray(googleParts)) {
            const nativeCalls = googleParts.filter((part) => part.functionCall);
            if (nativeCalls.length) {
                text = googleParts.filter((part) => typeof part.text === 'string' && !part.thought).map((part) => part.text).join('\n');
                calls = nativeCalls.map((part) => ({
                    type: 'function',
                    function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) },
                    ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}),
                }));
            }
        }
        if (choice.finish_reason === 'length' || choice.finish_reason === 'max_tokens') throw new Error('Agent 回复达到输出长度上限，未执行本轮工具；请增加最大输出长度');
    } else if (Array.isArray(raw?.content)) {
        if (raw.stop_reason === 'max_tokens') throw new Error('Agent 回复达到输出长度上限，未执行本轮工具');
        text = raw.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
        calls = raw.content.filter((p) => p.type === 'tool_use').map((p) => ({ id: p.id, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.input) } }));
    } else {
        const parts = raw?.responseContent?.parts || raw?.candidates?.[0]?.content?.parts;
        if (parts) {
            text = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('\n');
            calls = parts.filter((p) => p.functionCall).map((p) => ({ type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) }, ...(p.thoughtSignature ? { signature: p.thoughtSignature } : {}) }));
        }
    }
    if (!Array.isArray(calls) || calls.length > 24) throw new Error('Agent 工具调用数量或格式异常');
    const ids = new Set();
    const prefix = `ruby_${Date.now().toString(36)}_${++responseSequence}`;
    calls = calls.map((call, index) => {
        if (!call?.function || typeof call.function.name !== 'string') throw new Error('Agent 工具调用缺少函数名');
        const id = String(call.id || `${prefix}_${index}`);
        if (ids.has(id)) throw new Error('Agent 返回重复的工具调用编号');
        ids.add(id);
        const signature = call.signature || call.extra_content?.google?.thought_signature;
        return {
            id, type: 'function',
            function: { name: call.function.name, arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments || {}) },
            ...(signature ? { signature } : {}),
            ...(call.extra_content ? { extra_content: call.extra_content } : {}),
        };
    });
    if (!text.trim() && !calls.length) throw new Error('模型未返回正文或工具调用，请检查模型是否支持工具及输出长度');
    const reasoning = choice?.message?.reasoning_content;
    return { text, calls, usage: raw?.usage || raw?.usageMetadata || null,
        ...(typeof reasoning === 'string' ? { reasoning } : {}) };
}

/** Runs only declared tools, serializes mutations, and never retries an executed tool blindly. */
export async function runAgentLoop({ messages, tools, request, settings, signal, limiter = createRequestLimiter(), guard = () => {}, onEvent = () => {}, now = Date.now, delay = abortableDelay }) {
    const started = now();
    const deadline = started + settings.maxMinutes * 60000;
    let requestCount = 0, toolCount = 0;
    const assertActive = () => {
        if (signal?.aborted) throw abortError();
        guard();
        if (now() >= deadline) throw new Error('已达到单次 Agent 运行时间上限，已完成的修改保留');
    };
    while (true) {
        assertActive();
        if (JSON.stringify(messages).length > 240000) throw new Error('当前Agent任务上下文超过240000字符，请缩小读取范围；已完成操作保留');
        let raw;
        for (let retry = 0; ; retry++) {
            if (requestCount >= settings.maxRequests) throw new Error('已达到单次 Agent 请求次数上限，已完成的修改保留');
            await limiter.acquire(settings, signal, (until) => onEvent({ kind: 'waiting', until }));
            assertActive();
            requestCount++;
            onEvent({ kind: 'request', requestCount, toolCount });
            try {
                raw = await request({ messages, definitions: tools.definitions, signal });
                assertActive();
                break;
            } catch (error) {
                assertActive();
                if (retry >= settings.retries || !(/429|502|503|504|timeout|network|fetch|连接|超时/i.test(error.message))) throw error;
                const ms = Math.max(Number(error.retryAfterMs) || 0, Math.min(30000, 1000 * 2 ** retry));
                onEvent({ kind: 'retry', text: `请求失败，${Math.ceil(ms / 1000)}秒后重试（${retry + 1}/${settings.retries}）` });
                await delay(ms, signal);
            }
        }
        const turn = parseAgentTurn(raw);
        if (turn.usage) onEvent({ kind: 'usage', usage: turn.usage });
        const assistant = { role: 'assistant', content: turn.text || '', ...(turn.calls.length ? { tool_calls: turn.calls.map((call) => ({
            id: call.id, type: call.type, function: call.function,
            ...(call.signature ? { signature: call.signature } : {}), ...(call.extra_content ? { extra_content: call.extra_content } : {}),
        })) } : {}),
            ...(turn.reasoning !== undefined ? { reasoning_content: turn.reasoning } : {}) };
        messages.push(assistant);
        if (!turn.calls.length) return { text: turn.text, requestCount, toolCount };
        const known = new Map(tools.definitions.map((definition) => [definition.function?.name, definition.function?.parameters]));
        let interrupted;
        for (const call of turn.calls) {
            let result;
            if (interrupted) result = { ok: false, error: '运行已中断，本工具未执行' };
            else {
                try {
                    assertActive();
                    if (!known.has(call.function.name)) throw new Error('未授权的工具');
                    const args = JSON.parse(call.function.arguments);
                    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是JSON对象');
                    validateAgentArguments(args, known.get(call.function.name));
                    toolCount++;
                    onEvent({ kind: 'tool_start', name: call.function.name, toolCount });
                    result = await tools.execute(call.function.name, args);
                    assertActive();
                    onEvent({ kind: 'tool_result', name: call.function.name, result, toolCount });
                } catch (error) {
                    result = { ok: false, error: String(error.message || error) };
                    onEvent({ kind: 'tool_error', name: call.function.name, text: result.error, toolCount });
                    if (/Authorized book scope changed|Current chat or character changed/.test(result.error)) interrupted = error;
                    try { assertActive(); } catch (stop) { interrupted = stop; }
                }
            }
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result ?? null) });
            await onEvent({ kind: 'checkpoint', requestCount, toolCount });
        }
        // Complete the tool-result group before persisting so a resumed conversation remains valid.
        await onEvent({ kind: 'checkpoint', requestCount, toolCount });
        if (interrupted) throw interrupted;
    }
}
