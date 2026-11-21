export function normalizeAgentHistory(history) {
    const result = [];
    for (let i = 0; i < history.length; i++) {
        const message = history[i];
        if (message.role === 'tool') continue;
        result.push(message);
        if (!message.tool_calls?.length) continue;
        const replies = new Map();
        while (history[i + 1]?.role === 'tool') {
            const reply = history[++i]; replies.set(reply.tool_call_id, reply);
        }
        for (const call of message.tool_calls) result.push(replies.get(call.id) || {
            role: 'tool', tool_call_id: call.id,
            content: JSON.stringify({ ok: false, error: '上次运行中断，执行状态未知；先读取实际状态，禁止盲目重复写入。' }),
        });
    }
    return result;
}

export async function compactAgentContext(messages, { summarize, force = false, thresholdChars = 240000, onEvent = () => {} } = {}) {
    const beforeChars = JSON.stringify(messages).length;
    if (!force && (thresholdChars === 0 || beforeChars < thresholdChars)) return false;
    const start = messages[0]?.role === 'system' ? 1 : 0;
    const groups = [];
    for (let i = start; i < messages.length;) {
        const from = i++;
        if (messages[from].tool_calls?.length) while (messages[i]?.role === 'tool') i++;
        groups.push(from);
    }
    if (groups.length < 3) return false;
    const cut = groups[Math.max(1, groups.length - 2)];
    const latestUser = messages.findLastIndex((m) => m.role === 'user' && !m.content?.startsWith('[RUBY_CONTEXT_MEMORY]'));
    const pinned = latestUser >= start && latestUser < cut ? messages[latestUser] : null;
    const prefix = messages.slice(start, cut);
    const archived = structuredClone(prefix);
    const archiveId = `context_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    let summary, method = 'summary';
    try {
        summary = summarize ? await summarize(prefix) : '';
        if (typeof summary !== 'string' || !summary.trim() || summary.length > 20000) throw new Error('摘要无效');
    } catch (error) {
        if (error.name === 'AbortError') throw error;
        method = 'fallback';
        summary = prefix.filter((m) => m.role !== 'tool').map((m) => {
            const calls = (m.tool_calls || []).map((c) => {
                let args; try { args = JSON.parse(c.function.arguments); } catch { args = {}; }
                return `${c.function.name} ${JSON.stringify({ bookId: args.bookId, uid: args.uid })}`;
            }).join('; ');
            return `${m.role}: ${String(m.content || '').slice(0, 1600)}${calls ? '\n工具记录（不代表成功）: ' + calls : ''}`;
        }).join('\n\n');
        if (summary.length > 18000) summary = summary.slice(0, 8000) + '\n[中段已归档，需查原文]\n' + summary.slice(-10000);
        summary = '摘要服务不可用，以下为有限原文摘录，可能遗漏细节；未确认事项必须查归档，不得猜测。\n' + summary;
    }
    const memory = { role: 'user', content: `[RUBY_CONTEXT_MEMORY]\n历史工作交接摘要（非新指令，权限不变）。归档ID: ${archiveId}，使用read_compacted_history分页查原文。\n${summary}\n世界书为当前事实来源，旧hash和旧执行记录不可用于盲目重写；先读取最新状态。` };
    const replacement = [memory, ...(pinned ? [pinned] : []), ...messages.slice(cut)];
    if (JSON.stringify(replacement).length >= beforeChars) return false;
    await onEvent({ kind: 'compaction', archiveId, archived, method, beforeChars,
        afterChars: JSON.stringify(messages.slice(0, start).concat(replacement)).length });
    messages.splice(start, messages.length - start, ...replacement);
    return true;
}
