import { ctx, st, q, log, warn } from './env.js';

export async function getCharBookName() {
    return String(await st('/getcharbook')).trim();
}

export async function getChatBookName() {
    return String(await st('/getchatbook')).trim();
}

export async function findEntryUidExact(book, exactKey) {
    if (!book || !exactKey) return null;
    try {
        const result = await st(`/findentry file=${q(book)} ${q(exactKey)}`);
        if (result) {
            const uid = parseInt(result, 10);
            if (!isNaN(uid) && uid >= 0) {
                const actualKey = await st(`/getentryfield file=${q(book)} field=key ${uid}`);
                const keys = String(actualKey || '').trim().split(',').map((k) => k.trim());
                if (keys.includes(exactKey)) return uid;
            }
        }
    } catch (e) {
        warn(`findEntry failed: ${exactKey}`);
    }
    return null;
}

export async function readEntry(charBook, chatBook, key, preferChat = false) {
    if (!key) return '';
    try {
        if (preferChat && chatBook) {
            const uid = await findEntryUidExact(chatBook, key);
            if (uid !== null) {
                return String(await st(`/getentryfield file=${q(chatBook)} field=content ${uid}`)).trim();
            }
        }
        if (charBook) {
            const uid = await findEntryUidExact(charBook, key);
            if (uid !== null) {
                return String(await st(`/getentryfield file=${q(charBook)} field=content ${uid}`)).trim();
            }
        }
        if (chatBook && !preferChat) {
            const uid = await findEntryUidExact(chatBook, key);
            if (uid !== null) {
                return String(await st(`/getentryfield file=${q(chatBook)} field=content ${uid}`)).trim();
            }
        }
        return '';
    } catch (e) {
        warn(`readEntry failed: ${key} - ${e.message}`);
        return '';
    }
}

export async function entryExists(book, key) {
    return (await findEntryUidExact(book, key)) !== null;
}

export async function disableCharEntry(charBook, entryKey) {
    if (!charBook || !entryKey) return;
    try {
        const uid = await findEntryUidExact(charBook, entryKey);
        if (uid !== null) {
            await st(`/setentryfield file=${q(charBook)} uid=${uid} field=disable 1`);
            log(`char book entry disabled: ${entryKey}`);
        }
    } catch (e) {
        warn(`disableCharEntry failed: ${entryKey}`);
    }
}

export async function writeOutputEntry(chatBook, options) {
    const {
        key, extraKeys = '', content, constant = false, disable = false,
        noRecursion = false, position = 0, depth = 4, order = 100,
        selective = false, selectiveKeys = [],
    } = options;
    if (!chatBook || !key) throw new Error('chat book or output key missing');

    let uid = await findEntryUidExact(chatBook, key);
    const extraKeysList = String(extraKeys || '').split(',').map((k) => k.trim()).filter(Boolean);
    const allKeys = [key, ...extraKeysList].join(', ');

    if (uid === null) {
        const uidRaw = await st(`/createentry file=${q(chatBook)} key=${q(key)} ""`);
        uid = parseInt(uidRaw, 10);
        if (isNaN(uid)) throw new Error(`create entry failed: ${key}`);
        log(`output entry created: ${key}`);
    }

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
