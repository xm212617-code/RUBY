import assert from 'node:assert/strict';
import test from 'node:test';
import { cardEntryFromWorld, extendAgentArtifacts } from '../src/agent-artifacts.js';

test('export preserves probability, insertion roles and unknown extension metadata', () => {
    const e = cardEntryFromWorld({ uid: 0, key: ['A'], keysecondary: ['B'], content: '```html\n<b>x</b>\n```', comment: 'Name',
        disable: false, constant: true, useProbability: false, probability: 0, position: 4, depth: 6, role: 1,
        selectiveLogic: 2, group: 'g', groupOverride: true, extensions: { custom: 1 } }, 0);
    assert.equal(e.content, '```html\n<b>x</b>\n```');
    assert.equal(e.extensions.useProbability, false); assert.equal(e.extensions.probability, 0);
    assert.equal(e.extensions.position, 4); assert.equal(e.extensions.depth, 6); assert.equal(e.extensions.role, 1);
    assert.equal(e.extensions.selectiveLogic, 2); assert.equal(e.extensions.group_override, true);
    assert.equal(e.extensions.custom, 1); assert.equal(e.extensions.uid, undefined);
});

function fixture() {
    const entry = { uid: 0, key: ['A'], content: 'Source content', beforeHash: 'hash' };
    let c = { characterId: 0, groupId: null, chatMetadata: {}, getCurrentChatId: () => 'a',
        characters: [{ avatar: 'a.png', data: { extensions: { regex_scripts: [{ id: 'r', findRegex: 'A' }], RubyAnalyzer: {} } } }] };
    const exported = [], artifacts = [];
    const source = { definitions: [], scope: [{ id: 'character' }], execute: async () => {},
        readFullEntry: async (bookId, uid) => { assert.equal(bookId, 'character'); assert.equal(uid, 0); return entry; } };
    const tools = extendAgentArtifacts(source, { getContext: () => c,
        download: async (card, fileName) => { exported.push({ card, fileName }); return { url: 'blob:test' }; },
        onArtifact: (artifact) => artifacts.push(artifact) });
    return { tools, source, exported, artifacts, entry, switchChat: () => { c = { ...c, chatMetadata: {} }; } };
}

test('card export uses guarded full records, includes requested integrations and leaves sources unchanged', async () => {
    const h = fixture(); const original = structuredClone(h.entry);
    const result = await h.tools.execute('export_character_card', { name: 'Test:card', description: 'Desc', entries: [{ bookId: 'character', uid: 0 }], includeRegex: true, includeRubyConfig: true });
    assert.equal(result.ok, true); assert.equal(result.entryCount, 1);
    assert.equal(h.exported[0].fileName, 'Test_card.json');
    assert.equal(h.exported[0].card.spec, 'chara_card_v3');
    assert.equal(h.exported[0].card.data.extensions.regex_scripts[0].id, 'r');
    assert.ok(h.exported[0].card.data.extensions.RubyAnalyzer.presets.length);
    assert.equal(h.artifacts[0].url, 'blob:test'); assert.deepEqual(h.entry, original);
});

test('duplicate references and changed chat identities abort export', async () => {
    const h = fixture();
    const args = { name: 'Test', entries: [{ bookId: 'character', uid: 0 }, { bookId: 'character', uid: 0 }] };
    await assert.rejects(h.tools.execute('export_character_card', args), /重复/);
    assert.equal(h.exported.length, 0);
    h.switchChat();
    await assert.rejects(h.tools.execute('export_character_card', { name: 'Test', entries: [{ bookId: 'character', uid: 0 }] }), /已切换/);
});

test('source access errors produce no downloaded partial card', async () => {
    const h = fixture();
    h.source.readFullEntry = async () => { throw Error('Unauthorized book'); };
    await assert.rejects(h.tools.execute('export_character_card', { name: 'Test', entries: [{ bookId: 'other', uid: 0 }] }), /Unauthorized/);
    assert.equal(h.exported.length, 0);
});
