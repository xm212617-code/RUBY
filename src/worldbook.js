import { ctx, st, q, log, warn } from './env.js';

export async function getCharBookName() {
    return String(await st('/getcharbook')).trim();
}

export async function getChatBookName() {
    return String(await st('/getchatbook')).trim();
}

async function loadBookData(bookName) {
    const c = ctx();
    if (!bookName || typeof c?.loadWorldInfo !== 'function') return null;
    try {
        return await c.loadWorldInfo(bookName);
    } catch (e) {
        warn(`loadWorldInfo failed: ${bookName} - ${e?.message || e}`);
        return null;
    }
}

function entryKeys(entry) {
    const raw = entry?.key;
    const list = Array.isArray(raw) ? raw : (raw !== undefined && raw !== null ? [raw] : []);
    const keys = [];
    for (const item of list) {
        const s = String(item ?? '').trim();
        if (!s) continue;
        keys.push(s);
        if (s.includes(',')) {
            for (const part of s.split(',')) {
                const p = part.trim();
                if (p) keys.push(p);
            }
        }
    }
    return keys;
}

/**
 * 精确查找条目：直接遍历世界书数据，key 数组元素逐一比对。
 * 不经斜杠命令（/getentryfield 的返回值是 JSON 序列化字符串，
 * 直接 String() 会带上中括号导致匹配失败），读取结果与 UI 数据一致。
 */
export async function findEntry(book, exactKey) {
    if (!book || !exactKey) return null;
    const data = await loadBookData(book);
    if (!data?.entries || typeof data.entries !== 'object') return null;
    const target = String(exactKey).trim();
    if (!target) return null;
    for (const [uid, entry] of Object.entries(data.entries)) {
        if (entryKeys(entry).includes(target)) {
            return { uid: parseInt(uid, 10), entry, data };
        }
    }
    return null;
}

const substitute = (text) => {
    const c = ctx();
    const s = String(text ?? '');
    if (typeof c?.substituteParams !== 'function') return s;
    try {
        return String(c.substituteParams(s));
    } catch {
        return s;
    }
};

async function readEntryFrom(book, key) {
    const found = await findEntry(book, key);
    if (!found) return '';
    const content = found.entry?.content;
    if (content === undefined || content === null) return '';
    return substitute(content).trim();
}

export async function readEntry(charBook, chatBook, key, preferChat = false) {
    if (!key) return '';
    try {
        if (preferChat && chatBook) {
            const chat = await readEntryFrom(chatBook, key);
            if (chat) return chat;
        }
        const char = await readEntryFrom(charBook, key);
        if (char) return char;
        if (chatBook && !preferChat) {
            return await readEntryFrom(chatBook, key);
        }
        return '';
    } catch (e) {
        warn(`readEntry failed: ${key} - ${e.message}`);
        return '';
    }
}

export async function entryExists(book, key) {
    return (await findEntry(book, key)) !== null;
}

/** 按 key 精确查找条目（公开接口：传入书名或数据对象），返回 { uid, entry } 或 null */
export async function findEntryPublic(book, key) {
    return findEntry(book, key);
}

export async function disableCharEntry(charBook, entryKey) {
    if (!charBook || !entryKey) return;
    try {
        const found = await findEntry(charBook, entryKey);
        if (found) {
            await st(`/setentryfield file=${q(charBook)} uid=${found.uid} field=disable 1`);
            log(`char book entry disabled: ${entryKey}`);
        }
    } catch (e) {
        warn(`disableCharEntry failed: ${entryKey}`);
    }
}

export async function writeOutputEntry(chatBook, options) {
    const {
        key, extraKeys = '', content, comment = '', constant = false, disable = false,
        noRecursion = false, position = 0, depth = 4, order = 100,
        selective = false, selectiveKeys = [],
    } = options;
    if (!chatBook || !key) throw new Error('chat book or output key missing');

    let uid;
    const found = await findEntry(chatBook, key);
    if (found) {
        uid = found.uid;
        log(`output entry found, updating: ${key} (uid ${uid})`);
    } else {
        const uidRaw = await st(`/createentry file=${q(chatBook)} key=${q(key)} ""`);
        uid = parseInt(uidRaw, 10);
        if (isNaN(uid)) throw new Error(`create entry failed: ${key}`);
        log(`output entry created: ${key}`);
    }

    if (comment) {
        await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=comment ${q(String(comment).trim())}`);
    }

    const extraKeysList = String(extraKeys || '').split(',').map((k) => k.trim()).filter(Boolean);
    const allKeys = [key, ...extraKeysList].join(', ');

    if (extraKeysList.length > 0) {
        const varName = `_ruby_key_${Date.now()}`;
        await st(`/setvar key=${varName} ${q(allKeys)}`);
        await st(`/getvar ${varName} | /setentryfield file=${q(chatBook)} uid=${uid} field=key`);
    }

    const contentVar = `_ruby_tmp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    await st(`/setvar key=${contentVar} ${q(String(content || '').trim())}`);
    await st(`/getvar ${contentVar} | /setentryfield file=${q(chatBook)} uid=${uid} field=content`);

    await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=constant ${constant ? 1 : 0}`);
    await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=disable ${disable ? 1 : 0}`);

    if (noRecursion) {
        await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=excludeRecursion 1`);
        await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=preventRecursion 1`);
    }

    await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=position ${position}`);
    await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=order ${order}`);

    if (position === 4) {
        await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=depth ${depth}`);
    }

    if (selective) {
        await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=selective 1`);
        await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=selectiveLogic 0`);
        const keys = selectiveKeys?.length ? selectiveKeys : ['nsfw'];
        const selVar = `_ruby_sel_${Date.now()}`;
        await st(`/setvar key=${selVar} ${q(keys.join(', '))}`);
        await st(`/getvar ${selVar} | /setentryfield file=${q(chatBook)} uid=${uid} field=keysecondary`);
    }
    log(`output written: ${key}${extraKeysList.length ? ` (keys: ${allKeys})` : ''}`);
}

export async function persistBook(bookName) {
    const c = ctx();
    if (!bookName || typeof c?.loadWorldInfo !== 'function' || typeof c?.saveWorldInfo !== 'function') {
        if (typeof c?.saveChat === 'function') {
            try { await c.saveChat(); } catch (e) { warn(`saveChat fallback failed: ${e.message}`); }
        }
        return;
    }
    try {
        const worldData = await c.loadWorldInfo(bookName);
        await c.saveWorldInfo(bookName, worldData, true);
        log(`world book persisted: ${bookName}`);
    } catch (e) {
        warn(`saveWorldInfo failed: ${e.message}`);
        if (typeof c?.saveChat === 'function') {
            try { await c.saveChat(); } catch (e2) { warn(`saveChat fallback failed: ${e2.message}`); }
        }
    }
}

export function extractEntryKeywords(entry) {
    const out = [];
    const pushKeywords = (v) => {
        if (!v) return;
        if (Array.isArray(v)) {
            v.forEach(pushKeywords);
            return;
        }
        const s = String(v).trim();
        if (!s) return;
        s.split(',').map((x) => x.trim()).filter(Boolean).forEach((k) => out.push(k));
    };
    pushKeywords(entry?.key);
    pushKeywords(entry?.keys);
    return [...new Set(out)];
}

export async function scanBookKeys(bookName) {
    const c = ctx();
    if (!bookName || typeof c?.loadWorldInfo !== 'function') throw new Error('world info API unavailable');
    const worldData = await c.loadWorldInfo(bookName);
    const entries = Object.values(worldData?.entries || {});
    const allKeys = [];
    for (const entry of entries) {
        for (const key of extractEntryKeywords(entry)) {
            allKeys.push(key);
        }
    }
    return [...new Set(allKeys)].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}
