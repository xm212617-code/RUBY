import { ctx, st, q, log, warn } from './env.js';

export async function getCharBookName() {
    return String(await st('/getcharbook')).trim();
}

/**
 * 聊天世界书取名：ruby-<角色卡名或主世界书名>·剧情分析·<聊天ID>。
 * ST 的 /getchatbook 默认命名是 "Chat Book <聊天ID>"，ASCII 清洗会把中文角色名洗成下划线，
 * 得到 "Chat Book _ - 2026-..." 这类不可读名字；这里在聊天未绑定时主动用可读名创建。
 * v3.0.18 修复「重开聊天被绑回上一本书」：
 * - 先查当前聊天已绑定的书（/getchatbook create=false），有就直接用，绝不重绑；
 * - 未绑定时用带聊天 ID 的唯一名创建——旧的角色名候选（撞名后缀）在 ST 实测中会把
 *   已存在的同名书绑到新聊天，导致新聊天读写上一本书，已弃用；
 * - 旧聊天已绑定的书名保持原样（向后兼容，不做改名）。
 */
export async function getChatBookName() {
    // 已绑定的聊天书直接返回（绝不重绑；旧聊天保持原书名）
    const existing = await getExistingChatBookName();
    if (existing) return existing;
    const c = ctx();
    let charName = c?.name2 || c?.characters?.[c?.characterId]?.name || '';
    if (!charName) {
        try { charName = String(await st('/getcharbook')).trim(); } catch { /* 主世界书名兜底失败，用默认名 */ }
    }
    const sanitize = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '').trim();
    const chatId = sanitize(String(c?.chatId ?? c?.chat?.chatId ?? '')).slice(-40);
    const base = sanitize(`ruby-${sanitize(charName).slice(0, 40) || '聊天'}·剧情分析${chatId ? `·${chatId}` : ''}`);
    if (base) {
        try {
            const created = String(await st(`/getchatbook create=true name=${q(base)}`)).trim();
            if (created) return created;
        } catch { /* 撞名（同聊天 ID 重建等，极少见）回落默认命名 */ }
    }
    // 兜底：ST 默认命名（Chat Book <聊天ID>），保证永远拿得到书
    return String(await st('/getchatbook create=true')).trim();
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

/**
 * 通用只读检索：在一本已知名的世界书里按关键词找条目。
 * 匹配顺序：精确命中（key 数组含逗号拆分）优先，其次包含式模糊命中。
 * all=true 返回全部命中（无关键词时返回整本书）；默认返回最佳单条。
 * 纯读：不创建书、不写条目、不改状态。
 */
async function readEntriesFromBook(book, key, { all = false } = {}) {
    const wanted = String(key || '').trim();
    const data = await loadBookData(book);
    if (!data?.entries || typeof data.entries !== 'object') return [];

    const recordOf = (uid, entry) => ({
        uid: parseInt(uid, 10),
        book,
        keys: entryKeys(entry),
        comment: String(entry?.comment || ''),
        content: String(entry?.content ?? ''),
        disabled: !!entry?.disable,
        constant: !!entry?.constant,
    });

    const exact = [];
    const fuzzy = [];
    for (const [uid, entry] of Object.entries(data.entries)) {
        const keys = entryKeys(entry);
        if (keys.length === 0 && !wanted) continue; // 无关键词时跳过无键条目
        if (!wanted) {
            fuzzy.push(recordOf(uid, entry));
        } else if (keys.includes(wanted)) {
            exact.push(recordOf(uid, entry));
        } else if (keys.some((k) => k.includes(wanted))) {
            fuzzy.push(recordOf(uid, entry));
        }
    }

    if (all) {
        const exactUids = new Set(exact.map((r) => r.uid));
        return [...exact, ...fuzzy.filter((r) => !exactUids.has(r.uid))];
    }
    return exact.length ? [exact[0]] : (fuzzy.length ? [fuzzy[0]] : []);
}

/**
 * 只读接口（供 /ruby read 与消息内 HTML 前端使用）：检索聊天世界书条目。
 * 已绑定的聊天书直接用；未绑定时只探测本聊天 ID 对应的 RUBY 输出书（不创建、不探测他聊天书，
 * 防止读到上一本书的内容——v3.0.18 与 getChatBookName 的聊天唯一命名对齐）。
 */
export async function readChatBookEntries(key, { all = false } = {}) {
    const c = ctx();
    const wanted = String(key || '').trim();

    let book = '';
    try { book = String(await st('/getchatbook')).trim(); } catch { /* 无聊天书 */ }
    if (!book) {
        let charName = c?.name2 || c?.characters?.[c?.characterId]?.name || '';
        if (!charName) {
            try { charName = String(await st('/getcharbook')).trim(); } catch { /* ignore */ }
        }
        const sanitize = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '').trim();
        const chatId = sanitize(String(c?.chatId ?? c?.chat?.chatId ?? '')).slice(-40);
        const base = sanitize(`ruby-${sanitize(charName).slice(0, 40) || '聊天'}·剧情分析${chatId ? `·${chatId}` : ''}`);
        if (base) {
            const probe = await loadBookData(base);
            if (probe?.entries && Object.keys(probe.entries).length > 0) book = base;
        }
    }
    if (!book) return [];
    return readEntriesFromBook(book, wanted, { all });
}

/** 只读接口：检索角色（主）世界书条目——设定/参考条目所在的书。 */
export async function readCharBookEntries(key, { all = false } = {}) {
    let book = '';
    try { book = String(await st('/getcharbook')).trim(); } catch { /* 无主世界书 */ }
    if (!book) return [];
    return readEntriesFromBook(book, String(key || '').trim(), { all });
}

/** 只读接口：按书名检索任意已存在的世界书（全局导入的书等，无需绑定聊天/角色）。 */
export async function readBookEntriesByName(bookName, key, { all = false } = {}) {
    const name = String(bookName || '').trim();
    if (!name) return [];
    const probe = await loadBookData(name);
    if (!probe?.entries || typeof probe.entries !== 'object') return [];
    return readEntriesFromBook(name, String(key || '').trim(), { all });
}

export const substitute = (text) => {
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

/** 查询当前聊天已绑定的世界书名；未绑定时返回 ''（不创建书） */
export async function getExistingChatBookName() {
    try {
        return String(await st('/getchatbook create=false')).trim();
    } catch {
        return '';
    }
}

let sanitizingFilters = false;

/**
 * 自动清理历史缺陷残留：早前版本的 writeOutputEntry 在任务未配置过滤关键词时，
 * 会给绿灯输出条目错误写入 "nsfw" 副关键词（keysecondary）。这里按当前任务配置
 * 自动清理聊天书中的分析输出条目（仅按任务 outputKey 精确匹配，绝不触碰创作者
 * 手写的其他条目）：
 * - 任务勾选「使用可选过滤关键词」并填入内容 → 副关键词以配置为准；
 * - 未勾选 → 清空副关键词（绿灯仅按主关键词触发）；
 * - 非绿灯任务 → 顺带复位 selective=0 并清空副关键词。
 * 返回清理的条目数（0=无需清理或未绑定聊天书）。
 */
export async function sanitizeOutputFilters(chatBook, tasks) {
    if (sanitizingFilters) return 0;
    if (!chatBook || !Array.isArray(tasks) || tasks.length === 0) return 0;
    sanitizingFilters = true;
    try {
        const data = await loadBookData(chatBook);
        if (!data?.entries || typeof data.entries !== 'object') return 0;

        const fixes = [];
        for (const task of tasks) {
            const outputKey = String(task?.outputKey || '').trim();
            if (!outputKey) continue;
            const found = Object.entries(data.entries).find(([, entry]) => entryKeys(entry).includes(outputKey));
            if (!found) continue;
            const uid = parseInt(found[0], 10);
            if (isNaN(uid)) continue;
            const entry = found[1];
            const wantSelective = !!task?.selective;
            const wantKeys = wantSelective && task?.selectiveKeysEnabled && Array.isArray(task?.selectiveKeys)
                ? task.selectiveKeys.map((k) => String(k ?? '').trim()).filter(Boolean)
                : [];
            const currentKeys = Array.isArray(entry?.keysecondary)
                ? entry.keysecondary.map((k) => String(k ?? '').trim()).filter(Boolean)
                : [];
            const keysDiffer = currentKeys.join('\u0001') !== wantKeys.join('\u0001');
            const selectiveDiffers = !!entry?.selective !== wantSelective;
            if (!keysDiffer && !selectiveDiffers) continue;
            fixes.push({ uid, outputKey, keysDiffer, selectiveDiffers, wantKeys, wantSelective, currentKeys });
        }
        if (fixes.length === 0) return 0;

        for (const fix of fixes) {
            if (fix.keysDiffer) {
                if (fix.wantKeys.length > 0) {
                    const selVar = `_ruby_sel_${Date.now()}_${fix.uid}`;
                    await st(`/setvar key=${selVar} ${q(fix.wantKeys.join(', '))}`);
                    await st(`/getvar ${selVar} | /setentryfield file=${q(chatBook)} uid=${fix.uid} field=keysecondary`);
                } else {
                    await st(`/setentryfield file=${q(chatBook)} uid=${fix.uid} field=keysecondary ""`);
                }
            }
            if (fix.selectiveDiffers) {
                await st(`/setentryfield file=${q(chatBook)} uid=${fix.uid} field=selective ${fix.wantSelective ? 1 : 0}`);
            }
            log(`output filter sanitized: ${fix.outputKey} (uid ${fix.uid}) keysecondary [${fix.currentKeys.join(', ')}] -> [${fix.wantKeys.join(', ')}]`);
        }
        await persistBook(chatBook);
        return fixes.length;
    } finally {
        sanitizingFilters = false;
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

    // 副关键词（过滤关键词）是高效用字段，严禁任何默认值兜底：
    // 只有调用方显式传入非空 selectiveKeys 才写入，否则一律清空；
    // 非绿灯条目一律复位 selective=0 并清空副关键词，防止旧状态残留。
    const filterKeys = (Array.isArray(selectiveKeys) ? selectiveKeys : [])
        .map((k) => String(k ?? '').trim()).filter(Boolean);
    if (filterKeys.length > 0) {
        const selVar = `_ruby_sel_${Date.now()}`;
        await st(`/setvar key=${selVar} ${q(filterKeys.join(', '))}`);
        await st(`/getvar ${selVar} | /setentryfield file=${q(chatBook)} uid=${uid} field=keysecondary`);
    } else {
        await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=keysecondary ""`);
    }
    await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=selective ${selective ? 1 : 0}`);
    if (selective) {
        await st(`/setentryfield file=${q(chatBook)} uid=${uid} field=selectiveLogic 0`);
    }
    log(`output written: ${key}${extraKeysList.length ? ` (keys: ${allKeys})` : ''}`);
}

/** 读单个条目当前内容（快照用）；条目不存在返回空串 */
export async function readEntryContent(book, key) {
    const found = await findEntry(book, key);
    return String(found?.entry?.content || '');
}

/**
 * 直写接口（供 /ruby write 与消息内 HTML 前端使用）：
 * 不经分析 AI，前端把整份内容直接写进世界书条目（不存在则创建）。
 * 典型用途：装甲叛客战斗结算——前端算完骰子后把新敌情 YAML 整体覆写，
 * 完整度归零的敌机直接从内容里删掉即完成「删除」。
 * 新建条目默认 @D4、order 100、递归双禁、可注入（constant 按参数）。
 * 返回 { uid, created }。
 */
export async function writeEntryByKey(bookName, options) {
    const {
        key, content = '', comment = '', keys = [],
        constant = false, order = 100, depth = 4, position = 4,
    } = options;
    if (!bookName || !key) throw new Error('writeEntryByKey: book or key missing');

    const primaryKey = String(key).trim();
    const extraKeys = (Array.isArray(keys) ? keys : String(keys || '').split(','))
        .map((k) => String(k ?? '').trim()).filter(Boolean);
    const allKeys = [primaryKey, ...extraKeys];

    let uid;
    const found = await findEntry(bookName, primaryKey);
    if (found) {
        uid = found.uid;
        log(`write: entry found, updating: ${primaryKey} (uid ${uid})`);
    } else {
        const uidRaw = await st(`/createentry file=${q(bookName)} key=${q(allKeys.join(', '))} ""`);
        uid = parseInt(uidRaw, 10);
        if (isNaN(uid)) throw new Error(`create entry failed: ${primaryKey}`);
        // 新建条目：角色后注入（position 1），递归双禁
        await st(`/setentryfield file=${q(bookName)} uid=${uid} field=position ${position}`);
        await st(`/setentryfield file=${q(bookName)} uid=${uid} field=order ${order}`);
        await st(`/setentryfield file=${q(bookName)} uid=${uid} field=excludeRecursion 1`);
        await st(`/setentryfield file=${q(bookName)} uid=${uid} field=preventRecursion 1`);
        log(`write: entry created: ${primaryKey}`);
    }

    if (comment) {
        await st(`/setentryfield file=${q(bookName)} uid=${uid} field=comment ${q(String(comment).trim())}`);
    }
    if (found && extraKeys.length > 0) {
        // 已有条目且要求附加关键词：整体覆写 key 数组
        const keyVar = `_ruby_wk_${Date.now()}`;
        await st(`/setvar key=${keyVar} ${q(allKeys.join(', '))}`);
        await st(`/getvar ${keyVar} | /setentryfield file=${q(bookName)} uid=${uid} field=key`);
    }

    // 内容经临时变量写入（内容可能含竖线/引号/换行，与 writeOutputEntry 同款通道）
    const contentVar = `_ruby_wc_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    await st(`/setvar key=${contentVar} ${q(String(content ?? ''))}`);
    await st(`/getvar ${contentVar} | /setentryfield file=${q(bookName)} uid=${uid} field=content`);

    await st(`/setentryfield file=${q(bookName)} uid=${uid} field=constant ${constant ? 1 : 0}`);
    await persistBook(bookName);
    return { uid, created: !found };
}

/** 只恢复条目内容（快照回滚用）：不动 key/位置/状态等其余字段 */
export async function writeEntryContent(book, key, content) {
    if (!book || !key) throw new Error('chat book or entry key missing');
    const found = await findEntry(book, key);
    if (!found) throw new Error(`未找到输出条目：${key}`);
    const contentVar = `_ruby_restore_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    await st(`/setvar key=${contentVar} ${q(String(content ?? ''))}`);
    await st(`/getvar ${contentVar} | /setentryfield file=${q(book)} uid=${found.uid} field=content`);
    log(`entry content restored: ${key} (uid ${found.uid})`);
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

/**
 * 双版本条目组整备（供 /ruby preset 调用，前端开局选择 HTML 的落地实现）。
 *
 * 约定：孪生条目名以「老马版」结尾（如 沛霖老马版），其原版条目名为去掉后缀的名字（沛霖）。
 * - activeSuffix = '老马版'：启用孪生组、禁用原版组
 * - activeSuffix = '小马版'：启用原版组、禁用孪生组
 * - 两边都不到的共享条目一概不动
 *
 * 直接经 loadWorldInfo 取真实 uid 再 /setentryfield 写 disable——不做 uid 盲扫，
 * 不触发宿主对无效 uid 的 toastr 告警。返回统计 {laoCount, changedLao, changedXiao}。
 */
export async function setVersionEntryGroups(bookName, activeSuffix) {
    const suffix = String(activeSuffix || '').trim();
    if (suffix !== '老马版' && suffix !== '小马版') {
        throw new Error(`unknown version suffix: ${activeSuffix}`);
    }
    if (!bookName) throw new Error('world book name missing');
    const data = await loadBookData(bookName);
    if (!data?.entries || typeof data.entries !== 'object') {
        throw new Error(`world book not found: ${bookName}`);
    }

    const wantLao = suffix === '老马版';
    const byUid = new Map();
    const laoBases = new Set();
    const groups = [];
    for (const [uidRaw, entry] of Object.entries(data.entries)) {
        const uid = parseInt(uidRaw, 10);
        byUid.set(uid, entry);
        const comment = String(entry?.comment ?? '').trim();
        if (comment.endsWith('老马版')) {
            laoBases.add(comment.slice(0, -3));
            groups.push({ uid, group: 'lao' });
        } else {
            groups.push({ uid, comment });
        }
    }
    for (const g of groups) {
        if (g.group === undefined) {
            g.group = laoBases.has(g.comment) ? 'xiao' : 'shared';
        }
    }

    let changedLao = 0;
    let changedXiao = 0;
    for (const g of groups) {
        if (g.group === 'shared' || isNaN(g.uid)) continue;
        const targetDisabled = (g.group === 'lao') !== wantLao ? 1 : 0;
        const entry = byUid.get(g.uid);
        const currentDisabled = !!entry?.disable;
        if (currentDisabled === !!targetDisabled) continue;
        await st(`/setentryfield file=${q(bookName)} uid=${g.uid} field=disable ${targetDisabled}`);
        if (g.group === 'lao') changedLao++;
        else changedXiao++;
    }
    await persistBook(bookName);
    return { laoCount: laoBases.size, changedLao, changedXiao };
}
