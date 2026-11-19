import assert from 'node:assert/strict';
import { createAgentTools } from '../src/agent-tools.js';

const clone = (value) => structuredClone(value);
const originalWIDataKeyMap = { key: 'keys', keysecondary: 'secondary_keys', comment: 'comment', content: 'content', disable: 'enabled', constant: 'constant', order: 'insertion_order', position: 'extensions.position', depth: 'extensions.depth' };

function makeWorldInfo() {
    return {
        originalWIDataKeyMap,
        worldInfoCache: new Map(),
        createWorldInfoEntry(_name, data) {
            const uid = Object.keys(data.entries).reduce((max, key) => Math.max(max, Number(key) || 0), 0) + 1;
            return data.entries[uid] = { uid, key: [], keysecondary: [], content: '', comment: '', constant: false, disable: false, order: 100, position: 0, depth: 4 };
        },
        setWIOriginalDataValue(data, uid, path, value) {
            const entry = data.originalData?.entries?.find((item) => String(item.uid) === String(uid));
            if (!entry) return;
            const parts = path.split('.');
            let target = entry;
            for (const part of parts.slice(0, -1)) target = target[part] ||= {};
            target[parts.at(-1)] = clone(value);
        },
        deleteWIOriginalDataValue(data, uid) {
            if (Array.isArray(data.originalData?.entries)) {
                data.originalData.entries = data.originalData.entries.filter((item) => String(item.uid) !== String(uid));
            }
        },
    };
}

function makeContext({ longContent = false } = {}) {
    const content = longContent ? 'x'.repeat(40000) : 'Original content';
    const context = {
        chatId: 'chat-one',
        chatMetadata: { world_info: 'chat-book' },
        characterId: 0,
        characters: [{
            avatar: 'current.png', name: 'Current', data: { extensions: {
                world: 'main-book',
                regex_scripts: [
                    { id: 'owned', scriptName: 'old version' },
                    { id: 'foreign', scriptName: 'leave me' },
                    { id: 'owned', scriptName: 'duplicate old version' },
                ],
                RubyAnalyzer: { charName: 'Current', cardScripts: { sample: { api: { key: 'CARD-SECRET' } } } },
            } },
        }],
        extensionSettings: {
            RubyAnalyzer: { api: { key: 'GLOBAL-SECRET' } },
            disabledExtensions: ['regex'],
            character_allowed_regex: [],
        },
        writeCalls: [],
        async writeExtensionField(characterId, field, value) {
            this.writeCalls.push({ characterId, field, value: clone(value) });
            this.characters[characterId].data.extensions[field] = clone(value);
        },
        saveSettingsDebounced() { this.settingsSaved = true; },
        getRequestHeaders: () => ({ 'content-type': 'application/json' }),
    };
    return context;
}

const initialBook = () => ({
    title: 'root-level metadata preserved',
    entries: {
        1: { uid: 1, key: ['alpha'], keysecondary: ['secondary'], comment: 'Alpha', content: 'Original content', customField: { keep: true }, disable: false },
    },
    originalData: { entries: [{ uid: 1, keys: ['alpha'], secondary_keys: ['secondary'], comment: 'Alpha', content: 'Original content', extensions: { custom: 'retain' } }], keepOriginal: true },
    rootUnknown: { preserve: 'yes' },
});

function adapters(context, options = {}) {
    const books = new Map([['main-book', initialBook()], ['global-book', { entries: {} }], ['chat-book', { entries: {} }]]);
    let selected = [
        { kind: 'character', name: 'main-book' },
        { kind: 'global', name: 'global-book' },
        { kind: 'global', name: 'global-book' },
        { kind: 'chat', name: 'chat-book' },
    ];
    let readCount = 0;
    let mutateRead = null;
    const calls = { reads: [], writes: [], changes: [] };
    const base = {
        getContext: () => context,
        loadScope: async () => selected,
        readBook: async ({ name }) => {
            readCount++;
            calls.reads.push(name);
            if (mutateRead?.at === readCount) mutateRead.run(books.get(name));
            return clone(books.get(name));
        },
        saveBook: async ({ name, data, guard, host }) => {
            await guard();
            assert.ok(host?.setWIOriginalDataValue);
            calls.writes.push(name);
            books.set(name, clone(data));
            return clone(data);
        },
        worldInfo: makeWorldInfo(),
        onChange: async (change) => calls.changes.push(change),
        ...options,
    };
    return {
        args: base,
        books,
        calls,
        setScope(value) { selected = value; },
        mutateOnRead(at, run) { mutateRead = { at, run }; },
        get reads() { return readCount; },
    };
}

const getBookId = (tools, kind) => tools.scope.books.find((book) => book.kind === kind).id;

{
    const context = makeContext();
    const fixture = adapters(context);
    const tools = await createAgentTools(fixture.args);
    assert.deepEqual(tools.scope.books.map(({ kind }) => kind), ['character', 'global', 'chat']);
    assert.equal(new Set(tools.scope.books.map(({ name }) => name)).size, tools.scope.books.length);
    assert.ok(tools.scope.books.every(({ id, name }) => id !== name));
    assert.equal(tools.definitions.some(({ function: fn }) => fn.name === 'test_regex'), false);
    const books = await tools.execute('list_books');
    assert.equal(books.books.length, 3);
    assert.equal(books.books[0].name, 'main-book');
    await assert.rejects(() => tools.execute('list_entries', { bookId: 'unlisted-book' }), /Unknown bookId/);
    await assert.rejects(() => tools.execute('read_entries', { bookId: getBookId(tools, 'character'), uids: ['__proto__'] }), /uid must be/);

    const mainBookId = getBookId(tools, 'character');
    const list = await tools.execute('list_entries', { bookId: mainBookId });
    assert.equal(list.entries[0].key[0], 'alpha');
    assert.equal(list.entries[0].keysecondary[0], 'secondary');
    assert.equal(list.entries[0].customField.keep, true);
    assert.match(list.entries[0].beforeHash, /^sha256-/);
    const full = await tools.readFullEntry(mainBookId, 1);
    assert.equal(full.content, 'Original content');
    assert.equal(full.beforeHash, list.entries[0].beforeHash);
    const search = await tools.execute('search_entries', { bookId: mainBookId, query: 'secondary' });
    assert.equal(search.entries[0].uid, 1);

    const updated = await tools.execute('update_entry', {
        bookId: mainBookId, uid: 1, beforeHash: full.beforeHash, patch: { content: 'Updated content', disable: true },
    });
    assert.match(updated.beforeHash, /^sha256-/);
    assert.equal(fixture.books.get('main-book').entries[1].content, 'Updated content');
    assert.deepEqual(fixture.books.get('main-book').entries[1].customField, { keep: true });
    assert.deepEqual(fixture.books.get('main-book').rootUnknown, { preserve: 'yes' });
    assert.equal(fixture.books.get('main-book').originalData.entries[0].content, 'Updated content');
    assert.equal(fixture.books.get('main-book').originalData.entries[0].enabled, false);
    assert.deepEqual(fixture.books.get('main-book').originalData.entries[0].extensions, { custom: 'retain' });
    const updateChange = fixture.calls.changes.find((change) => change.type === 'entry_update');
    assert.deepEqual(updateChange.delta.fields.find((field) => field.field === 'content').after, { preview: 'Updated content', length: 15 });

    const created = await tools.execute('create_entry', {
        bookId: mainBookId, entry: { key: ['beta'], keysecondary: ['b'], comment: 'Beta', content: 'Created' },
    });
    assert.equal(fixture.books.get('main-book').entries[created.uid].content, 'Created');
    assert.ok(fixture.books.get('main-book').originalData.entries.some((entry) => entry.uid === created.uid));
    const createdRecord = await tools.readFullEntry(mainBookId, created.uid);
    await assert.rejects(() => tools.execute('update_entry', {
        bookId: mainBookId, uid: created.uid, beforeHash: createdRecord.beforeHash, patch: { constant: 'false' },
    }), /constant must be a boolean/);
    await assert.rejects(() => tools.execute('update_entry', {
        bookId: mainBookId, uid: created.uid, beforeHash: createdRecord.beforeHash, patch: { probability: 101 },
    }), /probability must be between/);
    await tools.execute('delete_entry', { bookId: mainBookId, uid: created.uid, beforeHash: createdRecord.beforeHash });
    assert.equal(fixture.books.get('main-book').entries[created.uid], undefined);
    assert.ok(!fixture.books.get('main-book').originalData.entries.some((entry) => entry.uid === created.uid));
    assert.ok(fixture.calls.changes.length >= 3);
}

{
    const context = makeContext();
    const host = {
        ...makeWorldInfo(),
        selected_world_info: [],
        world_info: { globalSelect: ['stale-unselected-book'] },
        METADATA_KEY: 'world_info',
    };
    const tools = await createAgentTools({ getContext: () => context, worldInfo: host });
    assert.deepEqual(tools.scope.books.map(({ kind }) => kind), ['character', 'chat']);
    assert.ok(!tools.scope.books.some(({ name }) => name === 'stale-unselected-book'));
    await assert.rejects(() => tools.execute('list_entries', { bookId: 'global:0' }), /Unknown bookId/);
}

{
    const context = makeContext();
    const fixture = adapters(context);
    const tools = await createAgentTools(fixture.args);
    const mainBookId = getBookId(tools, 'character');
    const first = await tools.readFullEntry(mainBookId, 1);
    fixture.mutateOnRead(fixture.reads + 2, (book) => { book.entries[1].content = 'External edit'; });
    await assert.rejects(() => tools.execute('update_entry', {
        bookId: mainBookId, uid: 1, beforeHash: first.beforeHash, patch: { content: 'Must not overwrite' },
    }), /changed since it was read/);
    assert.equal(fixture.calls.writes.length, 0);
}

{
    const context = makeContext();
    const fixture = adapters(context);
    const tools = await createAgentTools(fixture.args);
    fixture.setScope([{ kind: 'character', name: 'main-book' }]);
    await assert.rejects(() => tools.execute('list_books'), /scope changed/);

    const nextContext = makeContext();
    const replacementFixture = adapters(context);
    let currentContext = context;
    const replacementTools = await createAgentTools({ ...replacementFixture.args, getContext: () => currentContext });
    currentContext = nextContext;
    await assert.rejects(() => replacementTools.execute('get_regex'), /chat or character changed/);

    const groupContext = makeContext();
    groupContext.groupId = 'group-one';
    const groupFixture = adapters(groupContext);
    const groupTools = await createAgentTools(groupFixture.args);
    groupContext.groupId = 'group-two';
    await assert.rejects(() => groupTools.execute('list_books'), /chat or character changed/);
}

{
    const context = makeContext();
    const fixture = adapters(context);
    const tools = await createAgentTools(fixture.args);
    const installed = await tools.execute('install_regex', {
        id: 'owned', script: { id: 'owned', scriptName: 'new version', findRegex: '/x/g', replaceString: '', trimStrings: [], placement: [2] },
    });
    await assert.rejects(tools.execute('install_regex', { id: 'bad', script: { id: 'bad' } }), /Regex requires/);
    assert.equal(installed.filter((script) => script.id === 'owned').length, 1);
    assert.equal(installed.find((script) => script.id === 'owned').scriptName, 'new version');
    assert.equal(installed.find((script) => script.id === 'foreign').scriptName, 'leave me');
    assert.deepEqual(context.extensionSettings.character_allowed_regex, ['current.png']);
    assert.deepEqual(context.extensionSettings.disabledExtensions, ['regex']);
    assert.equal(context.writeCalls.at(-1).field, 'regex_scripts');
    await tools.execute('remove_regex', { id: 'owned' });
    assert.deepEqual(context.characters[0].data.extensions.regex_scripts.map((script) => script.id), ['foreign']);
}

{
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    try {
        const context = makeContext();
        const fixture = adapters(context);
        const tools = await createAgentTools(fixture.args);
        const full = await tools.readFullEntry(getBookId(tools, 'character'), 1);
        assert.match(full.beforeHash, /^fnv1a32x2-/);
        await tools.execute('update_entry', {
            bookId: getBookId(tools, 'character'), uid: 1, beforeHash: full.beforeHash, patch: { comment: 'HTTP-safe fingerprint' },
        });
        assert.equal(fixture.books.get('main-book').entries[1].comment, 'HTTP-safe fingerprint');
    } finally {
        Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
    }
}

{
    const context = makeContext();
    const fixture = adapters(context);
    const tools = await createAgentTools(fixture.args);
    const config = await tools.execute('get_ruby_config');
    assert.equal(JSON.stringify(config).includes('GLOBAL-SECRET'), false);
    assert.equal(JSON.stringify(config).includes('CARD-SECRET'), false);
    await tools.execute('update_ruby_config', { patch: { charName: 'Updated character', gen: { enabled: true, temperature: 0.7 } } });
    assert.equal(context.characters[0].data.extensions.RubyAnalyzer.charName, 'Updated character');
    assert.equal(context.characters[0].data.extensions.RubyAnalyzer.gen.temperature, 0.7);
    assert.equal(context.extensionSettings.RubyAnalyzer.api.key, 'GLOBAL-SECRET');
    assert.equal(context.writeCalls.at(-1).field, 'RubyAnalyzer');
}

{
    const context = makeContext({ longContent: true });
    const fixture = adapters(context);
    fixture.books.get('main-book').entries[1].content = 'x'.repeat(40000);
    const tools = await createAgentTools({
        ...fixture.args,
        testRegex: async (input) => ({ ok: true, pattern: input.pattern, textLength: input.text.length }),
        knowledge: {
            getKnowledgeIndex: async () => [{ id: 'step-1', title: 'Step one', summary: 'brief' }],
            readKnowledge: async (_id, { offset, limit }) => ({ content: 'k'.repeat(limit), total: 40000, nextOffset: offset + limit }),
        },
    });
    assert.ok(tools.definitions.some(({ function: fn }) => fn.name === 'test_regex'));
    assert.deepEqual(await tools.execute('test_regex', { pattern: 'x', text: 'example' }), { ok: true, pattern: 'x', textLength: 7 });
    const index = await tools.execute('list_knowledge');
    assert.equal(index[0].id, 'step-1');
    const page = await tools.execute('read_knowledge', { id: 'step-1', offset: 12000, limit: 18000 });
    assert.equal(page.content.length, 18000);
    assert.equal(page.nextOffset, 30000);
    await assert.rejects(() => tools.execute('read_knowledge', { id: '../outside' }), /Unknown knowledge id/);
    const content = await tools.execute('read_entry_content', { bookId: getBookId(tools, 'character'), uid: 1, offset: 30000, limit: 10000 });
    assert.equal(content.content.length, 10000);
    assert.equal(content.nextOffset, null);
    assert.equal(content.total, 40000);
}

{
    const context = makeContext();
    const host = makeWorldInfo();
    const tools = await createAgentTools({
        getContext: () => context,
        loadScope: async () => [{ kind: 'character', name: 'main-book' }],
        worldInfo: host,
    });
    const disk = { 'main-book': initialBook() };
    let failSave = false;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        const payload = JSON.parse(options.body);
        if (url.endsWith('/get')) return { ok: true, json: async () => clone(disk[payload.name]) };
        if (url.endsWith('/edit')) {
            if (failSave) return { ok: false, status: 503, json: async () => ({}) };
            disk[payload.name] = clone(payload.data);
            return { ok: true, json: async () => ({ ok: true }) };
        }
        throw new Error(`Unexpected endpoint ${url}`);
    };
    try {
        const entry = await tools.readFullEntry('character', 1);
        await tools.execute('update_entry', { bookId: 'character', uid: 1, beforeHash: entry.beforeHash, patch: { content: 'Saved through HTTP' } });
        assert.equal(disk['main-book'].entries[1].content, 'Saved through HTTP');
        assert.equal(host.worldInfoCache.get('main-book').entries[1].content, 'Saved through HTTP');
        assert.equal(tools.scope.books[0].kind, 'character');
        const changed = await tools.readFullEntry('character', 1);
        failSave = true;
        host.worldInfoCache.set('main-book', { stale: true });
        await assert.rejects(() => tools.execute('update_entry', {
            bookId: 'character', uid: 1, beforeHash: changed.beforeHash, patch: { content: 'must not cache' },
        }), /HTTP 503/);
        assert.equal(disk['main-book'].entries[1].content, 'Saved through HTTP');
        assert.equal(host.worldInfoCache.has('main-book'), false);
    } finally {
        globalThis.fetch = previousFetch;
    }
}

console.log('agent-tools tests passed');
