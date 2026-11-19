import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentController } from '../src/agent-controller.js';
import { createAgentTools } from '../src/agent-tools.js';
import { getKnowledgeIndex, readKnowledge } from '../src/agent-knowledge.js';
import { createRequestLimiter } from '../src/agent-runner.js';

test('a normal chat task reads knowledge, reads and edits a bound book, verifies then replies', async () => {
    const books = { Main: { custom: 'preserved', entries: { 0: { uid: 0, key: ['Alice'], content: 'Original', constant: false, disable: false } } } };
    const c = { chat: [], chatId: 'chat-a', chatMetadata: {}, characterId: 0, groupId: null,
        characters: [{ avatar: 'a.png', data: { extensions: { world: 'Main' } } }],
        extensionSettings: {}, getCurrentChatId: () => 'chat-a', name1: 'Player',
        saveSettingsDebounced() {}, saveMetadata: async () => {}, saveChat: async () => {}, addOneMessage() {} };
    let requestCount = 0;
    const call = (name, args) => ({ choices: [{ message: { content: '', tool_calls: [{ id: `c${requestCount}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
    const controller = createAgentController({ getContext: () => c,
        limiter: createRequestLimiter({ delay: async () => {} }),
        makeTools: (options) => createAgentTools({ ...options,
            worldInfo: {}, loadScope: () => [{ kind: 'character', name: 'Main' }],
            readBook: async ({ name }) => structuredClone(books[name]),
            saveBook: async ({ name, data }) => { books[name] = structuredClone(data); return data; },
        }),
        request: async ({ messages, definitions }) => {
            requestCount++;
            assert.ok(definitions.some((d) => d.function.name === 'export_character_card'));
            assert.doesNotMatch(JSON.stringify(messages), /NEVER_SEND/);
            switch (requestCount) {
                case 1: return call('list_knowledge', {});
                case 2: {
                    assert.ok(JSON.parse(messages.at(-1).content).some((k) => k.id === 'pipeline'));
                    return call('read_knowledge', { id: 'pipeline', limit: 2000 });
                }
                case 3: {
                    assert.ok(JSON.parse(messages.at(-1).content).content);
                    return call('read_entries', { bookId: 'character', uids: [0] });
                }
                case 4: {
                    const entry = JSON.parse(messages.at(-1).content).entries[0];
                    assert.equal(entry.uid, 0); assert.equal(entry.content, 'Original');
                    return call('update_entry', { bookId: 'character', uid: 0, beforeHash: entry.beforeHash, patch: { content: 'Confirmed revision', keysecondary: ['Alias'], selectiveLogic: 2 } });
                }
                case 5: return call('read_entries', { bookId: 'character', uids: [0] });
                default: {
                    assert.equal(JSON.parse(messages.at(-1).content).entries[0].content, 'Confirmed revision');
                    return { choices: [{ message: { content: 'Updated and checked.' } }] };
                }
            }
        },
        knowledge: { getKnowledgeIndex, readKnowledge },
    });
    c.chat.push({ name: 'Role', is_user: false, mes: 'NEVER_SEND ordinary history' });
    controller.saveSettings({ rpm: 600, minIntervalMs: 0 });
    await controller.setMode('agent');
    const result = await controller.submit('Revise the confirmed character entry and verify it');
    assert.equal(result.text, 'Updated and checked.');
    assert.equal(requestCount, 6);
    assert.equal(books.Main.custom, 'preserved');
    assert.deepEqual(books.Main.entries[0].keysecondary, ['Alias']);
    assert.equal(books.Main.entries[0].selectiveLogic, 2);
    assert.equal(c.chat.at(-1).extra.ruby_agent_source, 'Updated and checked.');
    assert.equal(controller.getState().running, false);
    assert.equal(controller.getState().requestCount, 6);
    assert.equal(controller.getState().scope[0].name, 'Main');
});
