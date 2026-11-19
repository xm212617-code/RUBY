import { ctx } from './env.js';
import { normalizeConfigData } from './config.js';

export function cardEntryFromWorld(entry, id) {
    const extensions = { ...(entry.extensions || {}) };
    for (const [key, value] of Object.entries(entry)) {
        if (['uid', 'key', 'keysecondary', 'content', 'comment', 'constant', 'disable', 'selective', 'order', 'beforeHash', 'extensions'].includes(key)) continue;
        extensions[key.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase())] = value;
    }
    // ST uses these two extension field names without snake_case in character books.
    extensions.selectiveLogic = entry.selectiveLogic ?? 0;
    if (entry.useProbability !== undefined) extensions.useProbability = entry.useProbability;
    extensions.position = entry.position ?? 0;
    return { id, keys: entry.key || [], secondary_keys: entry.keysecondary || [], comment: entry.comment || '',
        content: entry.content || '', constant: entry.constant === true, selective: entry.selective === true,
        insertion_order: entry.order ?? 100, enabled: !entry.disable, use_regex: true,
        position: entry.position === 1 ? 'after_char' : entry.position === 4 ? 'at_depth' : 'before_char', extensions };
}

export function extendAgentArtifacts(tools, { getContext = ctx, signal, onArtifact = () => {}, download = downloadJson } = {}) {
    const origin = getContext();
    const id = origin?.getCurrentChatId?.();
    const avatar = origin?.characters?.[origin.characterId]?.avatar;
    const guard = () => {
        const c = getContext();
        if (signal?.aborted) throw new Error('Agent已停止');
        if (c?.chatMetadata !== origin?.chatMetadata || c?.characterId !== origin?.characterId
            || c?.groupId !== origin?.groupId || c?.getCurrentChatId?.() !== id
            || c?.characters?.[c.characterId]?.avatar !== avatar) throw new Error('聊天或角色已切换，未导出');
    };
    return {
        ...tools,
        definitions: [...tools.definitions, { type: 'function', function: {
            name: 'export_character_card', description: '从授权世界书中选取成品条目导出v3角色卡JSON，保留来源字段，不整理或删除原书。必须先与创作者确认交付；不要包含brief/draft/progress等工作记录。可附当前角色的局部正则和RUBY配置，不读取其他角色卡字段。',
            parameters: { type: 'object', properties: {
                name: { type: 'string' }, description: { type: 'string' }, firstMessage: { type: 'string' },
                entries: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'object', properties: { bookId: { type: 'string' }, uid: { type: 'integer', minimum: 0 } }, required: ['bookId', 'uid'], additionalProperties: false } },
                includeRegex: { type: 'boolean' }, includeRubyConfig: { type: 'boolean' },
            }, required: ['name', 'entries'], additionalProperties: false },
        } }],
        async execute(name, args) {
            if (name !== 'export_character_card') return tools.execute(name, args);
            guard();
            if (typeof args.name !== 'string' || !args.name.trim() || !Array.isArray(args.entries) || !args.entries.length || args.entries.length > 500) throw new Error('请指定卡名及1–500个成品条目引用');
            for (const field of ['description', 'firstMessage']) if (args[field] !== undefined && typeof args[field] !== 'string') throw new Error(`${field}必须是字符串`);
            const entries = [], seen = new Set();
            for (const reference of args.entries) {
                if (!reference || typeof reference.bookId !== 'string' || !Number.isSafeInteger(reference.uid) || reference.uid < 0) throw new Error('条目引用必须包含合法bookId和uid');
                const key = JSON.stringify([reference.bookId, reference.uid]);
                if (seen.has(key)) throw new Error('成品条目引用重复，请先整理清单');
                seen.add(key);
                const entry = await tools.readFullEntry(reference.bookId, reference.uid);
                guard();
                entries.push(cardEntryFromWorld(entry, entries.length));
            }
            const character = getContext().characters?.[origin.characterId];
            const extensions = {};
            if (args.includeRegex === true) extensions.regex_scripts = structuredClone(character?.data?.extensions?.regex_scripts || []);
            if (args.includeRubyConfig === true) {
                extensions.RubyAnalyzer = normalizeConfigData(await tools.execute('get_ruby_config', {}));
                guard();
            }
            const card = { spec: 'chara_card_v3', spec_version: '3.0', data: {
                name: args.name.trim(), description: args.description || '', first_mes: args.firstMessage || '',
                personality: '', scenario: '', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
                alternate_greetings: [], tags: [], creator: 'RUBY Agent', character_version: '1.0', extensions,
                character_book: { name: args.name.trim(), entries },
            } };
            guard();
            const fileName = args.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 80) + '.json';
            const artifact = await download(card, fileName);
            guard();
            onArtifact({ fileName, ...artifact });
            return { ok: true, fileName, entryCount: entries.length, regexCount: extensions.regex_scripts?.length || 0, sourceBooksUnchanged: true };
        },
    };
}

function downloadJson(card, fileName) {
    const blob = new Blob([JSON.stringify(card, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = fileName;
    document.body.appendChild(link); link.click(); link.remove();
    return { url };
}
