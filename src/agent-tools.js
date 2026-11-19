import { ctx as defaultContext } from './env.js';
import { normalizeConfigData } from './config.js';

const SETTINGS_KEY = 'RubyAnalyzer';
const ENTRY_FIELDS = new Set([
    'key', 'keysecondary', 'comment', 'content', 'constant', 'vectorized', 'selective',
    'selectiveLogic', 'addMemo', 'order', 'position', 'disable', 'ignoreBudget',
    'excludeRecursion', 'preventRecursion', 'matchPersonaDescription',
    'matchCharacterDescription', 'matchCharacterPersonality', 'matchCharacterDepthPrompt',
    'matchScenario', 'matchCreatorNotes', 'delayUntilRecursion', 'probability',
    'useProbability', 'depth', 'outletName', 'group', 'groupOverride', 'groupWeight',
    'scanDepth', 'caseSensitive', 'matchWholeWords', 'useGroupScoring', 'automationId',
    'role', 'sticky', 'cooldown', 'delay', 'characterFilter', 'triggers',
]);
const ENTRY_DEFAULTS = {
    key: [], keysecondary: [], comment: '', content: '', constant: false, vectorized: false,
    selective: true, selectiveLogic: 0, addMemo: false, order: 100, position: 0,
    disable: false, ignoreBudget: false, excludeRecursion: false, preventRecursion: false,
    matchPersonaDescription: false, matchCharacterDescription: false,
    matchCharacterPersonality: false, matchCharacterDepthPrompt: false, matchScenario: false,
    matchCreatorNotes: false, delayUntilRecursion: 0, probability: 100, useProbability: true,
    depth: 4, outletName: '', group: '', groupOverride: false, groupWeight: 100,
    scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null,
    automationId: '', role: 0, sticky: null, cooldown: null, delay: null,
    characterFilter: { names: [], tags: [], isExclude: false }, triggers: [],
};
const MAX_LIST_LIMIT = 100;
const MAX_READ_LIMIT = 25;
const LIST_CONTENT_LIMIT = 240;
const READ_CONTENT_LIMIT = 30000;
const PAGE_CONTENT_LIMIT = 30000;

const clone = (value) => structuredClone(value);
const text = (value) => String(value ?? '');
const checkAbort = (signal) => {
    if (signal?.aborted) throw new Error('Agent tool operation aborted');
};

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

async function entryHash(entry) {
    const source = canonical(entry);
    if (globalThis.crypto?.subtle) {
        const bytes = new TextEncoder().encode(source);
        const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
        return `sha256-${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
    }
    // Concurrency fingerprint only; it is not an authorization token.
    let first = 0x811c9dc5;
    let second = 0x12345678;
    for (let i = 0; i < source.length; i++) {
        const code = source.charCodeAt(i);
        first = Math.imul(first ^ code, 0x01000193);
        second = Math.imul(second ^ code, 0x01000193);
    }
    return `fnv1a32x2-${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function strings(value) {
    if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean);
    if (value === undefined || value === null || value === '') return [];
    return [text(value)];
}

function setPath(object, path, value) {
    const parts = String(path).split('.');
    let target = object;
    for (const part of parts.slice(0, -1)) target = target[part] ||= {};
    target[parts.at(-1)] = clone(value);
}

function normalizeEntryField(key, value) {
    const expected = ENTRY_DEFAULTS[key];
    if (expected === undefined) throw new Error(`Unsupported world book field: ${key}`);
    if (key === 'key' || key === 'keysecondary') {
        const values = Array.isArray(value) ? value : [value];
        if (values.length > 100 || values.some((item) => typeof item !== 'string')) throw new Error(`${key} must be an array of at most 100 strings`);
        return values.map((item) => text(item).trim()).filter(Boolean);
    }
    if (key === 'comment' || key === 'content' || key === 'outletName' || key === 'group' || key === 'automationId') {
        if (typeof value !== 'string') throw new Error(`${key} must be a string`);
        if (value.length > 200000) throw new Error(`${key} is too long`);
        return value;
    }
    if (key === 'characterFilter') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('characterFilter must be an object');
        for (const property of Object.keys(value)) {
            if (!['names', 'tags', 'isExclude'].includes(property)) throw new Error(`Unsupported characterFilter field: ${property}`);
        }
        const names = value.names ?? [];
        const tags = value.tags ?? [];
        const isExclude = value.isExclude ?? false;
        if (!Array.isArray(names) || names.length > 100 || names.some((item) => typeof item !== 'string')) throw new Error('characterFilter.names must be a string array');
        if (!Array.isArray(tags) || tags.length > 100 || tags.some((item) => typeof item !== 'string')) throw new Error('characterFilter.tags must be a string array');
        if (typeof isExclude !== 'boolean') throw new Error('characterFilter.isExclude must be a boolean');
        return { names: [...names], tags: [...tags], isExclude };
    }
    if (Array.isArray(expected)) {
        if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== 'string')) throw new Error(`${key} must be a string array`);
        return [...value];
    }
    if (typeof expected === 'boolean' && typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
    if (typeof expected === 'number' && (!Number.isFinite(value) || typeof value !== 'number')) throw new Error(`${key} must be a finite number`);
    if (expected === null && value !== null && typeof value !== (key === 'scanDepth' ? 'number' : key === 'caseSensitive' || key === 'matchWholeWords' || key === 'useGroupScoring' ? 'boolean' : 'number')) {
        throw new Error(`${key} has an invalid value type`);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${key} must be finite`);
    if (['selectiveLogic', 'position', 'role'].includes(key) && (!Number.isInteger(value) || value < 0 || value > ({ selectiveLogic: 3, position: 7, role: 3 }[key]))) {
        throw new Error(`${key} is out of range`);
    }
    if (key === 'probability' && (value < 0 || value > 100)) throw new Error('probability must be between 0 and 100');
    if (['depth', 'scanDepth', 'delayUntilRecursion', 'sticky', 'cooldown', 'delay'].includes(key) && value !== null && value < 0) throw new Error(`${key} must be non-negative`);
    return clone(value);
}

function summarizeDeltaValue(field, value) {
    if (value === undefined) return null;
    if (typeof value === 'string') return { preview: value.slice(0, 240), length: value.length };
    if (field === 'content') {
        const content = text(value);
        return { preview: content.slice(0, 240), length: content.length };
    }
    const serialized = JSON.stringify(value);
    if (serialized.length <= 500) return clone(value);
    return { preview: serialized.slice(0, 240), length: serialized.length, truncated: true };
}

function entryDelta(fields, before, after, operation) {
    const names = fields.length ? fields : ['content', 'comment', 'key', 'keysecondary'];
    return {
        operation,
        fields: names.map((field) => ({
            field,
            before: summarizeDeltaValue(field, before?.[field]),
            after: summarizeDeltaValue(field, after?.[field]),
        })),
    };
}

async function truncateEntry(entry, contentLimit) {
    const result = clone(entry);
    const content = text(result.content);
    result.content = content.slice(0, contentLimit);
    if (content.length > contentLimit) result.contentTruncated = true;
    result.beforeHash = await entryHash(entry);
    return result;
}

function publicScope(items, includeNames = true) {
    return {
        books: items.map(({ id, kind, name, sources }) => ({
            id, kind, ...(includeNames ? { name } : {}), sources: [...sources],
        })),
    };
}

function scopeFingerprint(items) {
    return JSON.stringify(items.map(({ id, kind, name, sources }) => ({ id, kind, name, sources })));
}

function normalizeScopeItems(raw) {
    const input = Array.isArray(raw) ? raw : raw?.books;
    if (!Array.isArray(input)) throw new Error('Book scope unavailable');
    const byName = new Map();
    let globalIndex = 0;
    for (const item of input) {
        const name = text(item?.name).trim();
        const kind = text(item?.kind);
        if (!name || !['character', 'global', 'chat'].includes(kind)) continue;
        const current = byName.get(name);
        if (current) {
            if (!current.sources.includes(kind)) current.sources.push(kind);
            continue;
        }
        const id = kind === 'global' ? `global:${globalIndex++}` : kind;
        byName.set(name, { id, kind, name, sources: [kind] });
    }
    const items = [...byName.values()];
    if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error('Ambiguous book scope');
    return items;
}

function safeSecrets(value, parent = '') {
    if (Array.isArray(value)) return value.map((item) => safeSecrets(item, parent));
    if (!value || typeof value !== 'object') return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
        const normalized = key.replace(/[-_]/g, '').toLowerCase();
        const secretName = /^(apikey|accesstoken|refreshtoken|secret|authorization|password)$/.test(normalized)
            || (normalized === 'key' && /api|credential|auth/i.test(parent));
        if (secretName) continue;
        result[key] = safeSecrets(item, `${parent}.${key}`);
    }
    return result;
}

function tool(name, description, properties = {}, required = []) {
    return {
        type: 'function',
        function: {
            name,
            description,
            parameters: {
                type: 'object',
                properties,
                required,
                additionalProperties: false,
            },
        },
    };
}

const bookIdSchema = { type: 'string', description: 'Opaque ID from list_books; never a book name.' };
const uidSchema = { type: 'integer' };
const hashSchema = { type: 'string', description: 'beforeHash returned for this exact entry.' };

export async function createAgentTools({
    getContext = defaultContext,
    loadScope,
    readBook,
    saveBook,
    saveRegex,
    saveRuby,
    testRegex,
    knowledge,
    signal,
    onChange,
    worldInfo,
} = {}) {
    let hostPromise;
    const getWorldInfo = async () => {
        if (worldInfo) return worldInfo;
        hostPromise ||= import('/scripts/world-info.js');
        return hostPromise;
    };

    const context = () => {
        checkAbort(signal);
        const value = getContext?.();
        if (!value) throw new Error('SillyTavern context unavailable');
        return value;
    };

    const defaultLoadScope = async (value) => {
        const host = await getWorldInfo();
        const character = value.characters?.[value.characterId];
        const items = [];
        const primary = text(character?.data?.extensions?.world).trim();
        if (primary) items.push({ id: 'character', kind: 'character', name: primary });

        const selected = Array.isArray(host.selected_world_info)
            ? host.selected_world_info
            : (Array.isArray(host.world_info?.globalSelect) ? host.world_info.globalSelect : []);
        const seenGlobal = new Set();
        let globalIndex = 0;
        for (const candidate of selected) {
            const name = text(candidate).trim();
            if (!name || seenGlobal.has(name)) continue;
            seenGlobal.add(name);
            items.push({ id: `global:${globalIndex++}`, kind: 'global', name });
        }

        const chatName = text(value.chatMetadata?.[host.METADATA_KEY || 'world_info']).trim();
        if (chatName) items.push({ id: 'chat', kind: 'chat', name: chatName });
        return items;
    };
    const resolveScope = async (value) => normalizeScopeItems(await (loadScope ? loadScope(value) : defaultLoadScope(value)));

    const initialContext = context();
    if (initialContext.chatMetadata == null) throw new Error('Current chat metadata unavailable');
    const initialCharacter = initialContext.characters?.[initialContext.characterId];
    if (!initialCharacter?.avatar) throw new Error('Current character unavailable');
    const initialScope = await resolveScope(initialContext);
    const baseline = {
        chatId: text(initialContext.chatId ?? initialContext.chat?.chatId),
        groupId: initialContext.groupId ?? null,
        chatMetadata: initialContext.chatMetadata,
        characterId: initialContext.characterId,
        avatar: text(initialCharacter.avatar),
        scope: scopeFingerprint(initialScope),
    };
    if (!baseline.chatId) throw new Error('Current chat ID unavailable');

    const guard = async (bookId) => {
        checkAbort(signal);
        const current = context();
        const character = current.characters?.[current.characterId];
        const currentChatId = text(current.chatId ?? current.chat?.chatId);
        if (current.chatMetadata !== baseline.chatMetadata
            || currentChatId !== baseline.chatId
            || (current.groupId ?? null) !== baseline.groupId
            || current.characterId !== baseline.characterId
            || text(character?.avatar) !== baseline.avatar) {
            throw new Error('Current chat or character changed; create a new agent session');
        }
        const liveScope = await resolveScope(current);
        if (scopeFingerprint(liveScope) !== baseline.scope) {
            throw new Error('Authorized book scope changed; create a new agent session');
        }
        if (bookId !== undefined && !initialScope.some((item) => item.id === bookId)) {
            throw new Error('Unknown bookId');
        }
        checkAbort(signal);
        return current;
    };

    async function defaultReadBook({ name, context: current }) {
        if (typeof fetch !== 'function' || typeof current.getRequestHeaders !== 'function') {
            throw new Error('World book read unavailable');
        }
        const response = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: current.getRequestHeaders(),
            body: JSON.stringify({ name }),
            cache: 'no-store',
            signal,
        });
        checkAbort(signal);
        if (!response.ok) throw new Error(`World book read failed (HTTP ${response.status})`);
        const data = await response.json();
        if (!data || !data.entries || typeof data.entries !== 'object') throw new Error('World book data is invalid');
        return data;
    }

    async function defaultSaveBook({ name, data, uid, operation, beforeHash, fields = [], context: current, guard: checkScope, host: hostOverride }) {
        if (typeof fetch !== 'function' || typeof current.getRequestHeaders !== 'function') {
            throw new Error('World book persistence unavailable');
        }
        const host = hostOverride || await getWorldInfo();
        await checkScope();
        const latest = await defaultReadBook({ name, context: current });
        await checkScope();
        const latestEntry = latest.entries?.[uid];
        if (operation === 'create' && latestEntry) throw new Error('Entry UID conflict; retry with a fresh read');
        if (operation !== 'create' && (!latestEntry || await entryHash(latestEntry) !== beforeHash)) {
            throw new Error('Entry changed since it was read; reload before writing');
        }

        const submittedEntry = data.entries?.[uid];
        if (operation !== 'delete' && !submittedEntry) throw new Error('Updated entry missing');
        if (operation === 'delete') delete latest.entries[uid];
        else latest.entries[uid] = clone(submittedEntry);

        if (latest.originalData && !Array.isArray(latest.originalData.entries) && operation === 'create') {
            latest.originalData.entries = [];
        }
        if (latest.originalData && Array.isArray(latest.originalData.entries)) {
            const sourceIndex = latest.originalData.entries.findIndex((entry) => String(entry?.uid) === String(uid));
            const submittedOriginal = data.originalData?.entries?.find((entry) => String(entry?.uid) === String(uid));
            if (operation === 'delete') {
                if (sourceIndex >= 0) latest.originalData.entries.splice(sourceIndex, 1);
            } else if (operation === 'create' && submittedOriginal) {
                if (sourceIndex < 0) latest.originalData.entries.push(clone(submittedOriginal));
            } else if (operation === 'update' && sourceIndex >= 0) {
                const source = latest.originalData.entries[sourceIndex];
                const target = latest.entries[uid];
                for (const field of fields) {
                    const originalKey = host.originalWIDataKeyMap?.[field];
                    if (originalKey) host.setWIOriginalDataValue?.(latest, uid, originalKey, field === 'disable' ? !target[field] : target[field]);
                    if (field === 'useProbability') host.setWIOriginalDataValue?.(latest, uid, 'extensions.useProbability', target[field]);
                    if (field === 'characterFilter') host.setWIOriginalDataValue?.(latest, uid, 'character_filter', target[field]);
                }
                latest.originalData.entries[sourceIndex] = source;
            }
        }

        let saved;
        try {
            await checkScope();
            const response = await fetch('/api/worldinfo/edit', {
                method: 'POST',
                headers: current.getRequestHeaders(),
                body: JSON.stringify({ name, data: latest }),
                cache: 'no-store',
                signal,
            });
            await checkScope();
            if (!response.ok) throw new Error(`World book save failed (HTTP ${response.status})`);
            saved = await defaultReadBook({ name, context: current });
            await checkScope();
            if (operation !== 'delete') {
                const stored = saved.entries?.[uid];
                if (!stored || await entryHash(stored) !== await entryHash(latest.entries[uid])) {
                    throw new Error('World book save could not be verified');
                }
            } else if (saved.entries?.[uid]) {
                throw new Error('World book deletion could not be verified');
            }
        } catch (error) {
            host.worldInfoCache?.delete?.(name);
            throw error;
        }
        host.worldInfoCache?.set?.(name, saved);
        try {
            await current.eventSource?.emit?.(current.eventTypes?.WORLDINFO_UPDATED, name, saved);
            current.reloadWorldInfoEditor?.(name);
        } catch { /* Cache and persisted data already agree. */ }
        return saved;
    }

    const getBook = async (bookId) => {
        const current = await guard(bookId);
        const book = initialScope.find((item) => item.id === bookId);
        const data = await (readBook
            ? readBook({ bookId, name: book.name, kind: book.kind, context: current, signal })
            : defaultReadBook({ bookId, name: book.name, kind: book.kind, context: current }));
        await guard(bookId);
        if (!data || !data.entries || typeof data.entries !== 'object') throw new Error('World book data is invalid');
        return { current, book, data };
    };

    const validateUid = (uid) => {
        if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('uid must be a non-negative safe integer');
        return String(uid);
    };
    const getEntry = (data, uid) => {
        const key = validateUid(uid);
        return Object.hasOwn(data.entries, key) ? data.entries[key] : undefined;
    };
    const persistEntry = async ({ bookId, current, book, data, uid, operation, beforeHash, fields = [], deltaFields = fields, beforeEntry = null }) => {
        await guard(bookId);
        const fresh = await (readBook
            ? readBook({ bookId, name: book.name, kind: book.kind, context: current, signal })
            : defaultReadBook({ bookId, name: book.name, kind: book.kind, context: current }));
        await guard(bookId);
        const freshEntry = fresh?.entries?.[uid];
        if (operation === 'create' && freshEntry) throw new Error('Entry UID conflict; retry with a fresh read');
        if (operation !== 'create' && (!freshEntry || await entryHash(freshEntry) !== beforeHash)) {
            throw new Error('Entry changed since it was read; reload before writing');
        }
        const merged = clone(fresh);
        if (operation === 'delete') delete merged.entries[uid];
        else merged.entries[uid] = clone(data.entries[uid]);
        const host = await getWorldInfo().catch(() => null);
        if (merged.originalData && operation === 'create' && !Array.isArray(merged.originalData.entries)) merged.originalData.entries = [];
        if (Array.isArray(merged.originalData?.entries)) {
            const oldIndex = merged.originalData.entries.findIndex((entry) => String(entry?.uid) === String(uid));
            const submitted = data.originalData?.entries?.find((entry) => String(entry?.uid) === String(uid));
            if (operation === 'delete') {
                if (oldIndex >= 0) merged.originalData.entries.splice(oldIndex, 1);
            } else if (operation === 'create' && submitted) {
                if (oldIndex < 0) merged.originalData.entries.push(clone(submitted));
            } else if (operation === 'update' && oldIndex >= 0) {
                const target = merged.entries[uid];
                for (const field of fields) {
                    const originalKey = host?.originalWIDataKeyMap?.[field];
                    if (originalKey) host.setWIOriginalDataValue?.(merged, uid, originalKey, field === 'disable' ? !target[field] : target[field]);
                    if (field === 'useProbability') host.setWIOriginalDataValue?.(merged, uid, 'extensions.useProbability', target[field]);
                    if (field === 'characterFilter') host.setWIOriginalDataValue?.(merged, uid, 'character_filter', target[field]);
                }
            }
        }
        const saved = await (saveBook
            ? saveBook({ bookId, name: book.name, kind: book.kind, data: merged, uid, operation, beforeHash, fields, context: current, signal, host, guard: () => guard(bookId) })
            : defaultSaveBook({ bookId, name: book.name, kind: book.kind, data: merged, uid, operation, beforeHash, fields, context: current, guard: () => guard(bookId) }));
        await guard(bookId);
        if (onChange) await onChange({
            type: `entry_${operation}`, bookId, uid,
            delta: entryDelta(deltaFields, beforeEntry, operation === 'delete' ? null : merged.entries[uid], operation),
        });
        const resultData = saved?.entries ? saved : data;
        return { uid, beforeHash: resultData.entries?.[uid] ? await entryHash(resultData.entries[uid]) : undefined };
    };

    const getRegexScripts = (current) => {
        const character = current.characters?.[current.characterId];
        return Array.isArray(character?.data?.extensions?.regex_scripts) ? character.data.extensions.regex_scripts : [];
    };

    async function persistRegex(current, scripts) {
        const avatar = text(current.characters?.[current.characterId]?.avatar);
        if (!current.extensionSettings) throw new Error('Scoped Regex authorization settings unavailable');
        if (saveRegex) {
            await saveRegex({ scripts, avatar, context: current, signal });
        } else {
            if (typeof current.writeExtensionField !== 'function') throw new Error('Scoped Regex persistence unavailable');
            await current.writeExtensionField(current.characterId, 'regex_scripts', scripts);
        }
        const checked = await guard();
        const character = checked.characters?.[checked.characterId];
        character.data ||= {};
        character.data.extensions ||= {};
        character.data.extensions.regex_scripts = scripts;
        const settings = checked.extensionSettings;
        if (settings) {
            settings.character_allowed_regex ||= [];
            if (!settings.character_allowed_regex.includes(avatar)) settings.character_allowed_regex.push(avatar);
            checked.saveSettingsDebounced?.();
        }
        if (onChange) await onChange({ type: 'regex', avatar });
        return scripts;
    }

    const normalizedCharacterRubyConfig = (current) => {
        const raw = current.characters?.[current.characterId]?.data?.extensions?.[SETTINGS_KEY];
        return normalizeConfigData(raw);
    };

    async function persistRuby(current, value) {
        if (saveRuby) {
            await saveRuby({ value, avatar: baseline.avatar, context: current, signal });
        } else {
            if (typeof current.writeExtensionField !== 'function') throw new Error('Character Ruby configuration persistence unavailable');
            await current.writeExtensionField(current.characterId, SETTINGS_KEY, value);
        }
        const checked = await guard();
        const character = checked.characters?.[checked.characterId];
        character.data ||= {};
        character.data.extensions ||= {};
        character.data.extensions[SETTINGS_KEY] = value;
        if (onChange) await onChange({ type: 'ruby_config', avatar: baseline.avatar });
        return value;
    }

    const definitions = [
        tool('list_books', 'List only authorized current books. Book IDs are opaque and cannot be used to address other books.', {}),
        tool('list_entries', 'List a bounded page of entries from one authorized book. Returns complete entry fields with bounded content and beforeHash.', {
            bookId: bookIdSchema, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT },
        }, ['bookId']),
        tool('read_entries', 'Read bounded full entry records by UID or page. Each record includes all fields and beforeHash for safe edits.', {
            bookId: bookIdSchema, uids: { type: 'array', items: uidSchema, maxItems: MAX_READ_LIMIT },
            offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: MAX_READ_LIMIT },
        }, ['bookId']),
        tool('read_entry_content', 'Read a page of one entry content without the full-record size cap. Returns beforeHash for safe edits.', {
            bookId: bookIdSchema, uid: uidSchema, offset: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1, maximum: PAGE_CONTENT_LIMIT },
        }, ['bookId', 'uid']),
        tool('search_entries', 'Search keys, comments, and content within one authorized book. Returns at most 100 bounded records.', {
            bookId: bookIdSchema, query: { type: 'string', minLength: 1, maxLength: 500 },
            limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT },
        }, ['bookId', 'query']),
        tool('create_entry', 'Create one entry in an authorized book. Existing entries are never overwritten.', {
            bookId: bookIdSchema, entry: { type: 'object', additionalProperties: true },
        }, ['bookId', 'entry']),
        tool('update_entry', 'Update one entry only when beforeHash still matches. Unspecified and unknown fields are preserved.', {
            bookId: bookIdSchema, uid: uidSchema, beforeHash: hashSchema,
            patch: { type: 'object', additionalProperties: true },
        }, ['bookId', 'uid', 'beforeHash', 'patch']),
        tool('delete_entry', 'Delete one entry only when beforeHash still matches.', {
            bookId: bookIdSchema, uid: uidSchema, beforeHash: hashSchema,
        }, ['bookId', 'uid', 'beforeHash']),
        tool('get_regex', 'Read the current character card scoped regex_scripts only.', {}),
        tool('install_regex', 'Install or replace exactly one scoped regex script by stable ID; unrelated scripts are preserved.', {
            id: { type: 'string', minLength: 1, maxLength: 200 }, script: { type: 'object', additionalProperties: true },
        }, ['id', 'script']),
        tool('remove_regex', 'Remove only the scoped regex script with this stable ID.', {
            id: { type: 'string', minLength: 1, maxLength: 200 },
        }, ['id']),
        tool('get_ruby_config', 'Read the current character card RubyAnalyzer config only. Global API settings and credentials are not returned.', {}),
        tool('update_ruby_config', 'Patch the current character card RubyAnalyzer config after normalization; global settings are not read or written.', {
            patch: { type: 'object', additionalProperties: true },
        }, ['patch']),
    ];
    if (typeof testRegex === 'function') {
        definitions.push(tool('test_regex', 'Test a pattern through the injected isolated terminable Worker adapter; no HTML or JavaScript execution is allowed.', {
            pattern: { type: 'string', maxLength: 2000 }, flags: { type: 'string', maxLength: 20 }, text: { type: 'string', maxLength: 100000 },
        }, ['pattern', 'text']));
    }
    const knowledgeSearch = typeof knowledge === 'function' ? knowledge
        : (typeof knowledge?.search === 'function' ? knowledge.search.bind(knowledge) : null);
    if (knowledgeSearch) {
        definitions.push(tool('search_knowledge', 'Search the injected card-writing knowledge source; this tool cannot read arbitrary files.', {
            query: { type: 'string', minLength: 1, maxLength: 500 },
        }, ['query']));
    }
    const getKnowledgeIndex = typeof knowledge?.getKnowledgeIndex === 'function' ? knowledge.getKnowledgeIndex.bind(knowledge) : null;
    const readKnowledge = typeof knowledge?.readKnowledge === 'function' ? knowledge.readKnowledge.bind(knowledge) : null;
    if (getKnowledgeIndex && readKnowledge) {
        definitions.push(tool('list_knowledge', 'List the injected card-writing knowledge index; does not read arbitrary files.', {}));
        definitions.push(tool('read_knowledge', 'Read one document from the injected card-writing knowledge index by ID.', {
            id: { type: 'string', minLength: 1, maxLength: 200 },
            offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: PAGE_CONTENT_LIMIT },
        }, ['id']));
    }

    async function execute(name, args = {}) {
        checkAbort(signal);
        switch (name) {
            case 'list_books':
                await guard();
                return publicScope(initialScope);
            case 'list_entries': {
                const { data } = await getBook(args.bookId);
                const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
                const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(Number(args.limit) || 50)));
                const entries = await Promise.all(Object.entries(data.entries).slice(offset, offset + limit).map(async ([uid, entry]) => ({
                    ...await truncateEntry(entry, LIST_CONTENT_LIMIT), uid: Number.isFinite(Number(entry?.uid)) ? entry.uid : Number(uid),
                })));
                return { bookId: args.bookId, offset, limit, total: Object.keys(data.entries).length, entries };
            }
            case 'read_entries': {
                const { data } = await getBook(args.bookId);
                const uids = Array.isArray(args.uids) ? args.uids.map(validateUid) : null;
                const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
                const limit = Math.min(MAX_READ_LIMIT, Math.max(1, Math.floor(Number(args.limit) || MAX_READ_LIMIT)));
                const candidates = uids ? uids.map((uid) => [uid, getEntry(data, Number(uid))]).filter(([, entry]) => entry)
                    : Object.entries(data.entries).slice(offset, offset + limit);
                const entries = await Promise.all(candidates.slice(0, MAX_READ_LIMIT).map(async ([uid, entry]) => ({
                    ...await truncateEntry(entry, READ_CONTENT_LIMIT), uid: Number.isFinite(Number(entry?.uid)) ? entry.uid : Number(uid),
                })));
                return {
                    bookId: args.bookId,
                    entries,
                };
            }
            case 'read_entry_content': {
                const { data } = await getBook(args.bookId);
                const entry = getEntry(data, args.uid);
                if (!entry) throw new Error('Entry not found');
                const content = text(entry.content);
                const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
                const limit = Math.min(PAGE_CONTENT_LIMIT, Math.max(1, Math.floor(Number(args.limit) || PAGE_CONTENT_LIMIT)));
                const end = Math.min(content.length, offset + limit);
                return {
                    bookId: args.bookId, uid: Number.isFinite(Number(entry.uid)) ? entry.uid : Number(args.uid),
                    content: content.slice(offset, end), total: content.length,
                    nextOffset: end < content.length ? end : null, beforeHash: await entryHash(entry),
                };
            }
            case 'search_entries': {
                const { data } = await getBook(args.bookId);
                const query = text(args.query).trim().toLocaleLowerCase();
                const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(Number(args.limit) || 50)));
                const matches = Object.entries(data.entries).filter(([, entry]) => {
                    const searchable = [entry?.comment, entry?.content, ...strings(entry?.key), ...strings(entry?.keysecondary)]
                        .map(text).join('\n').toLocaleLowerCase();
                    return searchable.includes(query);
                }).slice(0, limit);
                const entries = await Promise.all(matches.map(async ([uid, entry]) => ({
                    ...await truncateEntry(entry, LIST_CONTENT_LIMIT), uid: Number.isFinite(Number(entry?.uid)) ? entry.uid : Number(uid),
                })));
                return { bookId: args.bookId, count: entries.length, entries };
            }
            case 'create_entry': {
                const { current, book, data } = await getBook(args.bookId);
                const nextData = clone(data);
                const host = await getWorldInfo().catch(() => null);
                let created;
                if (typeof host?.createWorldInfoEntry === 'function') {
                    created = host.createWorldInfoEntry(book.name, nextData);
                } else {
                    const uid = Object.keys(nextData.entries).reduce((max, value) => Math.max(max, Number(value) || 0), 0) + 1;
                    created = nextData.entries[uid] = { uid, ...clone(ENTRY_DEFAULTS) };
                }
                if (!created || !Number.isInteger(created.uid)) throw new Error('Could not allocate entry UID');
                const fields = args.entry && typeof args.entry === 'object' ? args.entry : {};
                for (const key of Object.keys(fields)) {
                    if (!ENTRY_FIELDS.has(key)) throw new Error(`Unsupported world book field: ${key}`);
                }
                for (const [key, value] of Object.entries(fields)) {
                    created[key] = normalizeEntryField(key, value);
                }
                if (!created.key?.length) throw new Error('New entry requires a primary key');
                const changedFields = Object.keys(created).filter((key) => ENTRY_FIELDS.has(key));
                if (nextData.originalData) {
                    nextData.originalData.entries ||= [];
                    const source = { uid: created.uid };
                    for (const field of changedFields) {
                        const originalKey = host?.originalWIDataKeyMap?.[field];
                        if (originalKey) setPath(source, originalKey, field === 'disable' ? !created[field] : created[field]);
                        if (field === 'useProbability') setPath(source, 'extensions.useProbability', created[field]);
                        if (field === 'characterFilter') source.character_filter = clone(created[field]);
                    }
                    nextData.originalData.entries.push(source);
                }
                const saved = await persistEntry({
                    bookId: args.bookId, current, book, data: nextData, uid: created.uid,
                    operation: 'create', fields: changedFields, deltaFields: Object.keys(fields),
                });
                return saved;
            }
            case 'update_entry':
            case 'delete_entry': {
                if (typeof args.beforeHash !== 'string' || !args.beforeHash) throw new Error('beforeHash is required');
                const { current, book, data } = await getBook(args.bookId);
                const currentEntry = getEntry(data, args.uid);
                if (!currentEntry) throw new Error('Entry not found');
                if (await entryHash(currentEntry) !== args.beforeHash) throw new Error('Entry changed since it was read; reload before writing');
                const nextData = clone(data);
                const uid = String(args.uid);
                let operation = 'update';
                let fields = [];
                if (name === 'delete_entry') {
                    delete nextData.entries[uid];
                    operation = 'delete';
                    const host = await getWorldInfo().catch(() => null);
                    if (typeof host?.deleteWIOriginalDataValue === 'function') host.deleteWIOriginalDataValue(nextData, args.uid);
                    else if (Array.isArray(nextData.originalData?.entries)) {
                        nextData.originalData.entries = nextData.originalData.entries.filter((entry) => String(entry?.uid) !== uid);
                    }
                } else {
                    const patch = args.patch && typeof args.patch === 'object' ? args.patch : {};
                    for (const key of Object.keys(patch)) {
                        if (!ENTRY_FIELDS.has(key)) throw new Error(`Unsupported world book field: ${key}`);
                    }
                    const target = nextData.entries[uid];
                    for (const [key, value] of Object.entries(patch)) {
                        if (key === 'uid' || !ENTRY_FIELDS.has(key)) continue;
                        target[key] = normalizeEntryField(key, value);
                    }
                    const host = await getWorldInfo().catch(() => null);
                    fields = Object.keys(patch).filter((key) => ENTRY_FIELDS.has(key));
                    for (const field of fields) {
                        const originalKey = host?.originalWIDataKeyMap?.[field];
                        if (originalKey && typeof host.setWIOriginalDataValue === 'function') {
                            host.setWIOriginalDataValue(nextData, args.uid, originalKey, field === 'disable' ? !target[field] : target[field]);
                        }
                        if (field === 'useProbability') host.setWIOriginalDataValue?.(nextData, args.uid, 'extensions.useProbability', target[field]);
                        if (field === 'characterFilter') host.setWIOriginalDataValue?.(nextData, args.uid, 'character_filter', target[field]);
                    }
                }
                return persistEntry({
                    bookId: args.bookId, current, book, data: nextData, uid: args.uid,
                    operation, beforeHash: args.beforeHash, fields, beforeEntry: currentEntry,
                });
            }
            case 'get_regex': {
                const current = await guard();
                return clone(getRegexScripts(current));
            }
            case 'install_regex': {
                if (typeof args.id !== 'string' || !args.id.trim() || args.script?.id !== args.id) {
                    throw new Error('script.id must exactly match the stable id');
                }
                const script = args.script;
                if (typeof script.scriptName !== 'string' || !script.scriptName.trim()
                    || typeof script.findRegex !== 'string' || !script.findRegex.trim()
                    || typeof script.replaceString !== 'string'
                    || !Array.isArray(script.placement) || !script.placement.length
                    || script.placement.some((value) => !Number.isInteger(value) || value < 1 || value > 6)) {
                    throw new Error('Regex requires scriptName, findRegex, replaceString and valid placement array');
                }
                for (const field of ['disabled', 'markdownOnly', 'promptOnly', 'runOnEdit']) {
                    if (script[field] !== undefined && typeof script[field] !== 'boolean') throw new Error(`Regex ${field} must be boolean`);
                }
                const current = await guard();
                const scripts = clone(getRegexScripts(current));
                const replacement = clone(script);
                let inserted = false;
                const next = [];
                for (const script of scripts) {
                    if (script?.id !== args.id) next.push(script);
                    else if (!inserted) { next.push(replacement); inserted = true; }
                }
                if (!inserted) next.push(replacement);
                return clone(await persistRegex(current, next));
            }
            case 'remove_regex': {
                if (typeof args.id !== 'string' || !args.id.trim()) throw new Error('Stable id is required');
                const current = await guard();
                const scripts = clone(getRegexScripts(current));
                const next = scripts.filter((script) => script?.id !== args.id);
                if (next.length === scripts.length) throw new Error('Regex id not found');
                return clone(await persistRegex(current, next));
            }
            case 'get_ruby_config': {
                const current = await guard();
                return clone(safeSecrets(normalizedCharacterRubyConfig(current)));
            }
            case 'update_ruby_config': {
                const current = await guard();
                const before = normalizedCharacterRubyConfig(current);
                const patch = safeSecrets(args.patch && typeof args.patch === 'object' ? args.patch : {});
                const next = safeSecrets(normalizeConfigData({ ...before, ...patch }));
                return clone(await persistRuby(current, next));
            }
            case 'test_regex': {
                if (typeof testRegex !== 'function') throw new Error('Regex testing is not configured');
                await guard();
                const result = await testRegex({ pattern: text(args.pattern), flags: text(args.flags), text: text(args.text), signal });
                await guard();
                return result;
            }
            case 'search_knowledge': {
                if (!knowledgeSearch) throw new Error('Knowledge search is not configured');
                await guard();
                const result = await knowledgeSearch(text(args.query), { signal });
                await guard();
                return Array.isArray(result) ? result.slice(0, 20) : result;
            }
            case 'list_knowledge': {
                if (!getKnowledgeIndex) throw new Error('Knowledge index is not configured');
                await guard();
                const index = await getKnowledgeIndex();
                await guard();
                const items = Array.isArray(index) ? index : index?.items;
                if (!Array.isArray(items)) return [];
                return items.slice(0, 100).map((item) => ({
                    id: text(item?.id ?? item?.key),
                    title: text(item?.title ?? item?.name ?? item?.id ?? item?.key),
                    ...(item?.category ? { category: text(item.category) } : {}),
                    ...(item?.summary ? { summary: text(item.summary).slice(0, 500) } : {}),
                })).filter((item) => item.id);
            }
            case 'read_knowledge': {
                if (!readKnowledge) throw new Error('Knowledge reader is not configured');
                await guard();
                const index = await getKnowledgeIndex();
                const items = Array.isArray(index) ? index : index?.items;
                const record = items?.find((item) => text(item?.id ?? item?.key) === text(args.id));
                if (!record) throw new Error('Unknown knowledge id');
                const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
                const limit = Math.min(PAGE_CONTENT_LIMIT, Math.max(1, Math.floor(Number(args.limit) || 12000)));
                const result = await readKnowledge(text(args.id), { offset, limit, signal });
                await guard();
                if (typeof result === 'string') return result.slice(0, PAGE_CONTENT_LIMIT);
                return {
                    id: text(args.id), title: text(record?.title ?? record?.name ?? args.id),
                    content: text(result?.content ?? result?.text).slice(0, PAGE_CONTENT_LIMIT),
                    total: Number.isFinite(Number(result?.total)) ? Number(result.total) : undefined,
                    nextOffset: result?.nextOffset == null ? null : (Number.isFinite(Number(result.nextOffset)) ? Number(result.nextOffset) : null),
                };
            }
            default:
                throw new Error(`Unknown agent tool: ${text(name)}`);
        }
    }

    async function readFullEntry(bookId, uid) {
        const { data } = await getBook(bookId);
        const entry = getEntry(data, uid);
        if (!entry) throw new Error('Entry not found');
        return { ...clone(entry), uid: Number.isFinite(Number(entry.uid)) ? entry.uid : Number(uid), beforeHash: await entryHash(entry) };
    }

    return { definitions, execute, scope: publicScope(initialScope), readFullEntry };
}
