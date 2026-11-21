import assert from 'node:assert/strict';
import test from 'node:test';
import { compactAgentContext, normalizeAgentHistory } from '../src/agent-context.js';
import { runAgentLoop } from '../src/agent-runner.js';

const call = (id, content = 'old '.repeat(20000)) => [
    { role: 'assistant', content: '', reasoning_content: 'reasoning', tool_calls: [{ id, type: 'function', signature: 'signature-' + id, function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: id, content },
];
const history = () => [{ role: 'system', content: 'Original authority' }, { role: 'user', content: 'Confirmed facts and task' },
    ...call('a'), ...call('b'), ...call('c'), ...call('d')];

test('compaction archives exact originals and preserves latest signed tool groups and user instruction', async () => {
    const messages = history(), original = structuredClone(messages), events = [];
    assert.equal(await compactAgentContext(messages, { summarize: async () => 'Confirmed constraints; unfinished task; book IDs.', onEvent: (e) => events.push(e) }), true);
    assert.equal(messages[0].content, 'Original authority');
    assert.ok(messages.some((m) => m.content === 'Confirmed facts and task'));
    assert.deepEqual(messages.slice(-4), original.slice(-4));
    assert.deepEqual(events[0].archived, original.slice(1, -4));
    assert.match(messages[1].content, new RegExp(events[0].archiveId));
    assert.ok(JSON.stringify(messages).length < JSON.stringify(original).length);
});

test('summary failure falls back to a recoverable index and continues', async () => {
    const messages = history(), events = [];
    await compactAgentContext(messages, { summarize: async () => { throw Error('503'); }, onEvent: (e) => events.push(e) });
    assert.equal(events[0].method, 'fallback');
    assert.match(messages[1].content, /摘要服务不可用/);
    assert.match(messages[1].content, /read_compacted_history/);
});

test('users can increase the compaction threshold or disable proactive compaction', async () => {
    let summaries = 0;
    const messages = history();
    const summarize = async () => { summaries++; return 'Memory'; };
    assert.equal(await compactAgentContext(messages, { thresholdChars: 1000000, summarize }), false);
    assert.equal(await compactAgentContext(messages, { thresholdChars: 0, summarize }), false);
    assert.equal(summaries, 0);
    assert.equal(await compactAgentContext(messages, { thresholdChars: 0, force: true, summarize }), true);
    assert.equal(summaries, 1);
});

test('abort and archive persistence errors leave original history untouched', async () => {
    const messages = history(), original = structuredClone(messages);
    await assert.rejects(compactAgentContext(messages, { summarize: async () => { throw Object.assign(Error('cancelled'), { name: 'AbortError' }); } }), /cancelled/);
    assert.deepEqual(messages, original);
    await assert.rejects(compactAgentContext(messages, { summarize: async () => 'Memory', onEvent: () => { throw Error('Disk failed'); } }), /Disk failed/);
    assert.deepEqual(messages, original);
});

test('a single oversized user instruction is never truncated or rejected by a local size cap', async () => {
    const messages = [{ role: 'system', content: 'Guide' }, { role: 'user', content: '字'.repeat(300000) }];
    assert.equal(await compactAgentContext(messages), false);
    const result = await runAgentLoop({ messages, settings: { maxRequests: 2, maxMinutes: 1, rpm: 60, minIntervalMs: 0, retries: 0 },
        tools: { definitions: [], execute() { throw Error('Unexpected'); } },
        request: async ({ messages: sent }) => { assert.equal(sent[1].content.length, 300000); return { choices: [{ message: { content: 'Done' } }] }; } });
    assert.equal(result.text, 'Done');
});

test('long tool sessions compact and continue, counting summary requests without replaying writes', async () => {
    const messages = history(); let requests = 0, writes = 0; const events = [];
    const result = await runAgentLoop({ messages, settings: { maxRequests: 5, maxMinutes: 1, rpm: 600, minIntervalMs: 0, retries: 0 },
        tools: { definitions: [], execute() { writes++; } },
        request: async ({ purpose }) => { requests++; return { choices: [{ message: { content: purpose === 'compaction' ? 'Task summary and constraints' : 'Continued successfully' } }] }; },
        onEvent: (event) => events.push(event),
    });
    assert.equal(result.text, 'Continued successfully'); assert.equal(requests, 2); assert.equal(writes, 0);
    assert.ok(events.some((e) => e.kind === 'compaction'));
});

test('normalization completes interrupted multi-tool groups without changing signatures', () => {
    const messages = call('a', 'result');
    messages[0].tool_calls.push({ id: 'b', function: { name: 'write', arguments: '{}' } });
    const normalized = normalizeAgentHistory(messages);
    assert.equal(normalized.length, 3); assert.equal(normalized[0].tool_calls[0].signature, 'signature-a');
    assert.match(normalized[2].content, /未知/);
});

test('provider context rejection triggers one compaction and retries without reexecuting tools', async () => {
    const messages = [{ role: 'system', content: 'Guide' }, { role: 'user', content: 'Earlier request' },
        { role: 'assistant', content: 'Earlier result '.repeat(1000) }, { role: 'user', content: 'Current exact request' }, ...call('a', 'small'), ...call('b', 'small')];
    let requests = 0, writes = 0;
    const result = await runAgentLoop({ messages, settings: { maxRequests: 5, maxMinutes: 1, rpm: 600, minIntervalMs: 0, retries: 0 },
        tools: { definitions: [], execute() { writes++; } },
        request: async ({ purpose }) => {
            requests++;
            if (requests === 1) throw Error('maximum context length exceeded');
            return { choices: [{ message: { content: purpose === 'compaction' ? 'Prior task and facts' : 'Recovered' } }] };
        },
    });
    assert.equal(result.text, 'Recovered'); assert.equal(requests, 3); assert.equal(writes, 0);
    assert.ok(messages.some((m) => m.content === 'Current exact request'));
});
