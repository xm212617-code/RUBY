import { ctx, log } from './env.js';

const BOOKMARK_NS = 'RubyAnalyzer';
export const MAX_READ_FLOORS = 20;
export const MAX_INPUT_CHARS = 200000;

export function capText(text, limit = MAX_INPUT_CHARS) {
    const s = String(text || '');
    if (s.length <= limit) return { text: s, truncated: 0 };
    return { text: s.slice(0, limit), truncated: s.length - limit };
}

export function isSystemHiddenMsg(m) {
    if (!m) return false;
    if (!m.is_system) return false;
    if (m.is_user) return false;
    return !!(m.name && m.mes && String(m.mes).trim().length > 0);
}

export function isAiReplyMsg(m) {
    if (!m) return false;
    if (m.is_user) return false;
    if (!m.is_system) return true;
    return isSystemHiddenMsg(m);
}

export function isUserMsg(m) {
    if (!m) return false;
    return !!m.is_user;
}

export function isReadableMsg(m) {
    return isAiReplyMsg(m) || isUserMsg(m);
}

export function countAiReplies(chatArr) {
    let n = 0;
    for (const m of chatArr || []) {
        if (isAiReplyMsg(m)) n++;
    }
    return n;
}

export function findAiReplyIndexByOrdinal(chatArr, ord) {
    let n = 0;
    for (let i = 0; i < (chatArr || []).length; i++) {
        if (isAiReplyMsg(chatArr[i])) {
            if (++n === ord) return i;
        }
    }
    return -1;
}

export function extractContent(mes, customTags = []) {
    if (!mes) return '';
    const defaultTags = ['content', 'maintext', 'text', 'body', 'message'];
    const contentTags = [...customTags, ...defaultTags];
    for (const tag of contentTags) {
        const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
        const match = String(mes).match(regex);
        if (match) return match[1].trim();
    }
    return mes;
}

export function cleanText(text) {
    if (!text) return '';
    let s = String(text);
    const blockTags = ['statusblock', 'options', 'other', 'thinking'];
    for (const tag of blockTags) {
        const re = new RegExp(`<\\s*${tag}\\b[\\s\\S]*?<\\s*\\/\\s*${tag}\\s*>`, 'ig');
        s = s.replace(re, '');
    }
    s = s.replace(/<!--[\s\S]*?-->/g, '');
    return s.trim();
}

function bookmarkStore() {
    const c = ctx();
    const meta = c?.chatMetadata;
    if (!meta) return null;
    meta.extensions ||= {};
    meta.extensions[BOOKMARK_NS] ||= {};
    meta.extensions[BOOKMARK_NS].lastReadFloor ||= {};
    return meta.extensions[BOOKMARK_NS].lastReadFloor;
}

export function getBookmark(taskKey) {
    const store = bookmarkStore();
    if (!store) return 0;
    const v = Number(store[taskKey]);
    return Number.isFinite(v) && v > 0 ? v : 0;
}

export function saveBookmark(taskKey, ordinal) {
    const store = bookmarkStore();
    if (!store || !Number.isFinite(ordinal) || ordinal <= 0) return;
    store[taskKey] = ordinal;
    const c = ctx();
    if (typeof c?.saveMetadataDebounced === 'function') {
        c.saveMetadataDebounced();
    }
}

export function resetBookmark(taskKey) {
    const store = bookmarkStore();
    if (store) delete store[taskKey];
}

/**
 * 消息删除后的书签重同步：deletedOldOrdinals 为被删消息在删除前的 AI 楼层序数。
 * 删除使后续楼层序数整体前移，书签须减去位于书签位之前（含）的被删楼层数，
 * 否则书签之后的未读内容会跨过书签被永久跳过，删除过多时书签越界、任务永久卡死。
 * 返回发生变动的书签描述列表（用于日志）。
 */
export function resyncBookmarksAfterDeletion(deletedOldOrdinals, currentAiCount) {
    const store = bookmarkStore();
    if (!store || deletedOldOrdinals.length === 0) return [];
    const changed = [];
    for (const [taskKey, raw] of Object.entries(store)) {
        const b = Number(raw);
        if (!Number.isFinite(b) || b <= 0) continue;
        let next = b - deletedOldOrdinals.filter((d) => d <= b).length;
        let note = '';
        if (next > currentAiCount) {
            next = 0;
            note = ' (out of range, reset to rescan)';
        }
        if (next !== b) {
            store[taskKey] = next;
            changed.push(`${taskKey} ${b}→${next}${note}`);
        }
    }
    if (changed.length > 0) {
        const c = ctx();
        if (typeof c?.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
    }
    return changed;
}

export function incrementalRead(taskKey, customTags = [], options = {}) {
    const c = ctx();
    const liveChat = c?.chat || [];
    const charName = c?.name2 || c?.characters?.[c?.characterId]?.name || '角色';
    const currentOrd = countAiReplies(liveChat);
    if (currentOrd <= 0) return { text: '', startFloor: 0, endFloor: 0, count: 0 };

    const bookmark = getBookmark(taskKey);
    // 总结接口启用时取消20楼窗口限制：窗口内靠前楼层将被总结替代，实际token成本很小
    const startFloor = (options.noWindowLimit && bookmark > 0)
        ? bookmark + 1
        : Math.max(
            bookmark > 0 ? bookmark + 1 : 1,
            currentOrd - MAX_READ_FLOORS + 1,
        );
    if (startFloor > currentOrd) {
        return { text: '', startFloor, endFloor: currentOrd, count: 0 };
    }

    const startIdx = startFloor > 1
        ? findAiReplyIndexByOrdinal(liveChat, startFloor - 1) + 1
        : 0;

    const lines = [];
    for (let i = startIdx; i < liveChat.length; i++) {
        const m = liveChat[i];
        if (!isReadableMsg(m)) continue;
        const role = isUserMsg(m) ? '{{user}}' : (m.name || charName);
        let text = extractContent(m.mes || '', customTags);
        text = cleanText(text);
        if (text) lines.push(`【${role}】${text}`);
    }
    return {
        text: lines.join('\n\n'),
        startFloor,
        endFloor: currentOrd,
        count: currentOrd - startFloor + 1,
    };
}

/** 读取一段楼层序数区间 [fromOrdinal, toOrdinal] 的原始正文（与增量阅读同格式） */
export function readFloorsRange(fromOrdinal, toOrdinal, customTags = []) {
    const c = ctx();
    const liveChat = c?.chat || [];
    const charName = c?.name2 || c?.characters?.[c?.characterId]?.name || '角色';
    if (!Number.isFinite(fromOrdinal) || !Number.isFinite(toOrdinal) || fromOrdinal > toOrdinal || fromOrdinal < 1) {
        return { text: '', count: 0 };
    }
    const startIdx = fromOrdinal > 1
        ? findAiReplyIndexByOrdinal(liveChat, fromOrdinal - 1) + 1
        : 0;
    const lines = [];
    let ord = fromOrdinal - 1;
    for (let i = startIdx; i < liveChat.length; i++) {
        const m = liveChat[i];
        if (isAiReplyMsg(m)) ord++;
        if (ord > toOrdinal) break;
        if (!isReadableMsg(m)) continue;
        const role = isUserMsg(m) ? '{{user}}' : (m.name || charName);
        let text = extractContent(m.mes || '', customTags);
        text = cleanText(text);
        if (text) lines.push(`【${role}】${text}`);
    }
    return { text: lines.join('\n\n'), count: toOrdinal - fromOrdinal + 1 };
}

/** 消息数组索引 → AI回复楼层序数（小白x边界转换用） */
export function ordinalForIndex(chatArr, idx) {
    if (!Number.isFinite(idx) || idx < 0) return 0;
    let n = 0;
    for (let i = 0; i <= Math.min(idx, (chatArr || []).length - 1); i++) {
        if (isAiReplyMsg(chatArr[i])) n++;
    }
    return n;
}

// ---------- 小白x（LittleWhiteBox）总结接口 ----------
// 只读 chat_metadata.extensions.LittleWhiteBox.storySummary，不 import 小白x模块，零耦合。

export function getLittleWhiteBoxSummary() {
    const c = ctx();
    const store = c?.chatMetadata?.extensions?.LittleWhiteBox?.storySummary;
    if (!store || !store.json) return null;
    const boundary = Number(store.lastSummarizedMesId);
    if (!Number.isFinite(boundary) || boundary < 0) return null;
    const json = store.json;
    const facts = (Array.isArray(json.facts) ? json.facts : []).filter((f) => f && !f.retracted);
    const events = Array.isArray(json.events) ? json.events : [];
    if (facts.length === 0 && events.length === 0) return null;
    const chars = (json.characters?.main || []).map((m) => (typeof m === 'string' ? m : m?.name)).filter(Boolean);
    const arcs = Array.isArray(json.arcs) ? json.arcs : [];
    return { boundary, facts, events, characters: chars, arcs };
}

/** 把小白x结构化总结渲染为可分析的紧凑文本 */
export function renderLittleWhiteBoxSummary(s) {
    if (!s) return '';
    const lines = [];

    if (s.characters.length > 0) {
        lines.push(`主要人物: ${s.characters.join('、')}`);
    }

    if (s.arcs.length > 0) {
        lines.push('剧情阶段:');
        for (const arc of s.arcs.slice(0, 12)) {
            const name = arc?.name || arc?.title || arc?.label || '';
            const desc = arc?.description || arc?.summary || arc?.progress || '';
            if (name || desc) lines.push(`  - ${name}${desc ? `：${desc}` : ''}`);
        }
    }

    if (s.events.length > 0) {
        lines.push('关键事件:');
        for (const ev of s.events.slice(0, 40)) {
            const people = Array.isArray(ev?.participants) && ev.participants.length > 0 ? `［${ev.participants.join('/')}］` : '';
            const summary = String(ev?.summary || '').trim();
            const moments = Array.isArray(ev?.moments) ? ev.moments.map((m) => String(m?.text || '').trim()).filter(Boolean) : [];
            if (!summary && moments.length === 0) continue;
            if (summary) lines.push(`  - ${people}${summary}`);
            for (const mo of moments.slice(0, 4)) lines.push(`    · 动态：${mo}`);
        }
    }

    if (s.facts.length > 0) {
        // 按 s（主体）分组：角色名 → 谓词: 宾语
        const bySubject = new Map();
        for (const f of s.facts) {
            const subj = String(f?.s || '').trim() || '未知';
            if (!bySubject.has(subj)) bySubject.set(subj, []);
            const p = String(f?.p || '').trim();
            const o = String(f?.o || '').trim();
            if (p || o) bySubject.get(subj).push(`${p ? `${p}: ` : ''}${o}`);
        }
        lines.push('人物状态事实:');
        for (const [subj, items] of bySubject) {
            lines.push(`  ${subj}:`);
            for (const item of items.slice(0, 15)) lines.push(`    - ${item}`);
        }
    }

    return lines.join('\n');
}

// ---------- SP·数据库（shujuku）总结接口 ----------
// 数据库插件把表格快照挂在聊天消息上（TavernDB_ACU_* 字段），并把可读总结
// 写入世界书条目（总结条目N / 重要人物条目N / TavernDB-ACU-OutlineTable）。
// 只匹配默认（无 ACU-[code]- 隔离前缀）的条目：隔离组属于插件高级功能，
// RUBY 无法得知当前激活的隔离码，混入会造成数据串组。RUBY 只读，零耦合。

const SHUJUKU_SUMMARY_RE = /^总结条目(\d+)$/;
const SHUJUKU_PERSON_RE = /^重要人物条目(\d+)$/;
const SHUJUKU_OUTLINE_RE = /^TavernDB-ACU-OutlineTable$/;

/** 数据库已处理到的最后消息索引（消息上出现 TavernDB_ACU_* 字段即被处理过） */
export function getShujukuBoundary() {
    const c = ctx();
    const chat = c?.chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && typeof m === 'object' && Object.keys(m).some((k) => k.startsWith('TavernDB_ACU_'))) {
            return i;
        }
    }
    return -1;
}

/**
 * 读取 SP·数据库的世界书可读条目并组装总结文本。
 * @param {string[]} books 世界书名列表（角色世界书 + 聊天世界书）
 * @returns {Promise<{boundary: number, text: string}|null>} 无已处理消息或无条目时返回 null
 */
export async function getShujukuSummary(books) {
    const boundary = getShujukuBoundary();
    if (boundary < 0) return null;

    const c = ctx();
    const booksToScan = (Array.isArray(books) ? books : []).filter(Boolean);
    const summaryRows = [];
    const personRows = [];
    let outline = '';

    for (const bookName of booksToScan) {
        let data = null;
        try {
            data = await c?.loadWorldInfo?.(bookName);
        } catch { /* book unreadable */ }
        if (!data?.entries) continue;
        for (const e of Object.values(data.entries)) {
            const comment = String(e?.comment || '');
            let m = comment.match(SHUJUKU_SUMMARY_RE);
            if (m) {
                summaryRows.push({ idx: parseInt(m[1], 10), content: String(e.content || '').trim() });
                continue;
            }
            m = comment.match(SHUJUKU_PERSON_RE);
            if (m) {
                personRows.push({ idx: parseInt(m[1], 10), content: String(e.content || '').trim() });
                continue;
            }
            if (SHUJUKU_OUTLINE_RE.test(comment)) {
                outline = String(e.content || '').trim();
            }
        }
    }

    if (summaryRows.length === 0 && personRows.length === 0 && !outline) return null;

    const sections = [];
    if (summaryRows.length > 0) {
        summaryRows.sort((a, b) => a.idx - b.idx);
        sections.push(`【SP·数据库·总结表】\n${summaryRows.map((r) => r.content).join('\n')}`);
    }
    if (personRows.length > 0) {
        personRows.sort((a, b) => a.idx - b.idx);
        sections.push(`【SP·数据库·重要人物】\n${personRows.map((r) => r.content).join('\n')}`);
    }
    if (outline) {
        sections.push(`【SP·数据库·剧情大纲】\n${outline}`);
    }
    return { boundary, text: sections.join('\n\n') };
}

// ---------- 柚月记忆表（yuzuki-Memory）总结接口 ----------
// 只读 chat_metadata.yuzukiMemory 的 memory_summary（记忆总结）表，不 import 柚月模块，零耦合。
// 总结记录覆盖聊天消息索引区间（0基、含用户楼）：机读 meta.yzmMemoryTask.range（end 为开区间），
// 文本楼层数为闭区间 'start-end'（多段换行分隔，连接符 - ~ － — 至 到）。
// 边界 = 全部记录区间并集自最小覆盖楼层起的连续链末端（含端消息索引），
// 与小白x lastSummarizedMesId 同语义，直接进引擎的 ordinalForIndex 转换。

const YUZUKI_SUMMARY_TABLE_ID = 'memory_summary';
const YUZUKI_PLOT_TABLE_ID = 'plot_summary';
const YUZUKI_MAX_RECORD_CHARS = 600;
const YUZUKI_MAX_TOTAL_CHARS = 30000;
const YUZUKI_MAX_PLOT_LINES = 60;

function yuzukiState() {
    const c = ctx();
    const state = c?.chatMetadata?.yuzukiMemory;
    return (state && typeof state === 'object') ? state : null;
}

function yuzukiRecords(state, tableId) {
    const list = state?.records?.[tableId];
    return Array.isArray(list) ? list : [];
}

/** 单条总结记录覆盖的消息索引闭区间列表；meta.yzmMemoryTask.range 优先，楼层数文本兜底 */
function yuzukiRecordIntervals(record) {
    const metaRange = record?.meta?.yzmMemoryTask?.range;
    if (metaRange && Number.isFinite(Number(metaRange.start)) && Number.isFinite(Number(metaRange.end))) {
        const start = Math.max(0, Math.round(Number(metaRange.start)));
        const end = Math.max(start, Math.round(Number(metaRange.end)) - 1);
        return start <= end ? [[start, end]] : [];
    }
    const raw = String(record?.values?.['楼层数'] || record?.values?.range || record?.values?.['楼层范围'] || record?.values?.['楼层'] || '');
    const intervals = [];
    for (const m of raw.matchAll(/(\d+)\s*(?:-|~|－|—|至|到)\s*(\d+)/g)) {
        let start = Math.max(0, Math.round(Number(m[1])));
        let end = Math.max(0, Math.round(Number(m[2])));
        if (start > end) [start, end] = [end, start];
        intervals.push([start, end]);
    }
    return intervals;
}

/** 已总结边界：区间并集从最小覆盖楼层起的连续链末端（含端消息索引）；无记录或区间不可解析返回 -1 */
function yuzukiBoundary(records) {
    const intervals = [];
    for (const record of records) intervals.push(...yuzukiRecordIntervals(record));
    if (intervals.length === 0) return -1;
    intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let end = intervals[0][1];
    for (let i = 1; i < intervals.length; i++) {
        const [s, e] = intervals[i];
        // 覆盖出现空洞即停：孤岛区间只参与渲染，不推进边界，防止把未总结楼层误替换
        if (s > end + 1) break;
        if (e > end) end = e;
    }
    return end;
}

const yuzukiCut = (s, max) => (s.length > max ? `${s.slice(0, max)}…（已截断）` : s);

function yuzukiRenderRecord(record, index) {
    const v = record?.values || {};
    const title = String(v['总结标题'] || '').trim();
    const floors = String(v['楼层数'] || '').trim();
    const chars = String(v['核心角色'] || '').trim();
    const content = String(v['总结内容'] || '').trim();
    const unresolved = String(v['未解决问题'] || '').trim();
    const note = String(v['备注'] || '').trim();
    if (!title && !content && !floors) return '';
    const label = title || `总结#${index + 1}`;
    const head = floors ? `【${label}（覆盖楼层 ${floors.split(/\n+/).join('、')}）】` : `【${label}】`;
    const lines = [head];
    if (chars) lines.push(`核心角色: ${chars}`);
    if (content) lines.push(`内容: ${yuzukiCut(content, YUZUKI_MAX_RECORD_CHARS)}`);
    if (unresolved) lines.push(`未解决问题: ${unresolved}`);
    if (note) lines.push(`备注: ${note}`);
    return lines.join('\n');
}

function yuzukiPlotLines(state) {
    const lines = [];
    for (const record of yuzukiRecords(state, YUZUKI_PLOT_TABLE_ID)) {
        for (const col of ['主线', '支线']) {
            for (const line of String(record?.values?.[col] || '').split(/\n+/)) {
                const t = line.trim();
                if (t) lines.push(t);
            }
        }
    }
    return lines;
}

/**
 * 读取柚月记忆表总结并组装为可分析的紧凑文本。
 * @returns {{boundary: number, text: string}|null} 无插件数据/无总结记录/区间不可解析时返回 null（回退纯原文）
 */
export function getYuzukiSummary(includePlot = true) {
    const state = yuzukiState();
    if (!state) return null;
    const records = yuzukiRecords(state, YUZUKI_SUMMARY_TABLE_ID);
    const boundary = yuzukiBoundary(records);
    if (boundary < 0) return null;

    const sections = records.map(yuzukiRenderRecord).filter(Boolean);
    // 防膨胀：总文本超上限时从最旧开始丢弃，保留最新总结
    let total = sections.reduce((sum, s) => sum + s.length, 0);
    while (sections.length > 0 && total > YUZUKI_MAX_TOTAL_CHARS) {
        total -= sections[0].length;
        sections.shift();
    }

    const parts = [...sections];
    if (includePlot) {
        const plotLines = yuzukiPlotLines(state);
        if (plotLines.length > 0) {
            const kept = plotLines.slice(-YUZUKI_MAX_PLOT_LINES);
            parts.push(`【剧情摘要时间线（最近${kept.length}条）】\n${kept.join('\n')}`);
        }
    }
    if (parts.length === 0) return null;
    return { boundary, text: parts.join('\n\n') };
}

/** 面板状态探测：有可总结数据时返回 { records, boundary }，否则 null */
export function getYuzukiStatus() {
    const state = yuzukiState();
    if (!state) return null;
    const records = yuzukiRecords(state, YUZUKI_SUMMARY_TABLE_ID);
    const boundary = yuzukiBoundary(records);
    if (boundary < 0) return null;
    return { records: records.length, boundary };
}
