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

// ---------- 龙血玄黄·数据库（shujuku）总结接口 ----------
// 数据库插件（龙血玄黄·数据库）把表格快照挂在聊天消息上（TavernDB_ACU_* 字段），并把可读
// 数据写入世界书条目。条目命名随模板/版本演进（对齐 shujuku 1.3.x）：
//  - 旧模板固定表：总结条目N / 小总结条目N（旧版兼容）/ 重要人物条目N / TavernDB-ACU-OutlineTable；
//    列头分别写在 TavernDB-ACU-MemoryStart（总结表）与 TavernDB-ACU-PersonsHeader（人物表）里，
//    标准表快照整体写入 TavernDB-ACU-ReadableDataTable。
//  - 1.3.x 默认模板：表格经"自定义导出"拆分为 TavernDB-ACU-CustomExport-{条目名}-表头 /
//    -包裹-上 / -包裹-下 / -{行号}，整表导出与附加索引为 TavernDB-ACU-CustomExport-{条目名}[-索引]；
//    默认模板导出"纪要"（逐轮记录）与"重要人物表"，不再生成 总结条目/剧情大纲 条目。
// 只匹配默认（无 ACU-[code]- 隔离前缀、无 外部导入- 前缀）的条目：隔离组属于插件高级功能，
// RUBY 无法得知当前激活的隔离码，混入会造成数据串组。RUBY 只读，零耦合。

const SHUJUKU_SUMMARY_RE = /^总结条目(\d+)$/;
const SHUJUKU_SMALL_SUMMARY_RE = /^小总结条目(\d+)$/;
const SHUJUKU_PERSON_RE = /^重要人物条目(\d+)$/;
const SHUJUKU_OUTLINE_RE = /^TavernDB-ACU-OutlineTable$/;
const SHUJUKU_READABLE_RE = /^TavernDB-ACU-ReadableDataTable$/;
const SHUJUKU_PERSONS_HEADER_RE = /^TavernDB-ACU-PersonsHeader$/;
const SHUJUKU_MEMORY_START_RE = /^TavernDB-ACU-MemoryStart$/;
const SHUJUKU_CUSTOM_EXPORT_RE = /^TavernDB-ACU-CustomExport-(.+)$/;
const SHUJUKU_ROW_TAIL_RE = /-(\d+)$/;
const SHUJUKU_ISOLATION_RE = /^ACU-\[[^\]]+\]-/;
const SHUJUKU_IMPORT_PREFIX = '外部导入-';
// 纯包裹/提示性条目：对分析无信息量，不纳入（MemoryStart/PersonsHeader 仅用于提取列头）
const SHUJUKU_SKIP_COMMENTS = new Set([
    'TavernDB-ACU-WrapperStart',
    'TavernDB-ACU-WrapperEnd',
    'TavernDB-ACU-MemoryEnd',
    'TavernDB-ACU-ImportantPersonsIndex',
]);
const SHUJUKU_MAX_TOTAL_CHARS = 60000;

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

/** 从条目内容中提取 markdown 表头行（首个紧跟分隔行的 | 单元格 | 行） */
function shujukuExtractHeaderLine(content) {
    const lines = String(content || '').split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (/^\|.+\|$/.test(line) && /^\|[\s:|-]+$/.test(lines[i + 1].trim())) return line;
    }
    return '';
}

/**
 * 读取 龙血玄黄·数据库的世界书可读条目并组装总结文本。
 * @param {string[]} books 世界书名列表（角色世界书 + 聊天世界书）
 * @returns {Promise<{boundary: number, text: string}|null>} 无已处理消息或无条目时返回 null
 */
export async function getShujukuSummary(books) {
    const boundary = getShujukuBoundary();
    if (boundary < 0) return null;

    const c = ctx();
    const booksToScan = (Array.isArray(books) ? books : []).filter(Boolean);
    const summaryRows = []; // 总结条目N：{ idx, content }
    const smallSummaryRows = []; // 小总结条目N（旧版兼容）：{ idx, content }
    const personRows = []; // 重要人物条目N：{ idx, content }
    const exportGroups = new Map(); // 自定义导出：条目名 -> { header, wrapperHeader, rows: [{idx, content}], wholes: [content] }
    let outline = '';
    let readableData = '';
    let personsHeader = '';
    let memoryStart = '';

    for (const bookName of booksToScan) {
        let data = null;
        try {
            data = await c?.loadWorldInfo?.(bookName);
        } catch { /* book unreadable */ }
        if (!data?.entries) continue;
        for (const e of Object.values(data.entries)) {
            const comment = String(e?.comment || '').trim();
            if (!comment) continue;
            // 隔离组（ACU-[code]- 前缀）与外部导入批次不属于默认数据视图，跳过防串组
            if (SHUJUKU_ISOLATION_RE.test(comment) || comment.startsWith(SHUJUKU_IMPORT_PREFIX)) continue;
            let m = comment.match(SHUJUKU_SUMMARY_RE);
            if (m) {
                const content = String(e.content || '').trim();
                if (content) summaryRows.push({ idx: parseInt(m[1], 10), content });
                continue;
            }
            m = comment.match(SHUJUKU_SMALL_SUMMARY_RE);
            if (m) {
                const content = String(e.content || '').trim();
                if (content) smallSummaryRows.push({ idx: parseInt(m[1], 10), content });
                continue;
            }
            m = comment.match(SHUJUKU_PERSON_RE);
            if (m) {
                const content = String(e.content || '').trim();
                if (content) personRows.push({ idx: parseInt(m[1], 10), content });
                continue;
            }
            if (SHUJUKU_OUTLINE_RE.test(comment)) {
                outline = String(e.content || '').trim();
                continue;
            }
            if (SHUJUKU_READABLE_RE.test(comment)) {
                readableData = String(e.content || '').trim();
                continue;
            }
            if (SHUJUKU_PERSONS_HEADER_RE.test(comment)) {
                personsHeader = String(e.content || '').trim();
                continue;
            }
            if (SHUJUKU_MEMORY_START_RE.test(comment)) {
                memoryStart = String(e.content || '').trim();
                continue;
            }
            if (SHUJUKU_SKIP_COMMENTS.has(comment)) continue;
            m = comment.match(SHUJUKU_CUSTOM_EXPORT_RE);
            if (m) {
                const rest = m[1];
                let base = rest;
                let kind = 'whole';
                let idx = 0;
                if (rest.endsWith('-表头')) {
                    base = rest.slice(0, -3);
                    kind = 'header';
                } else if (rest.endsWith('-包裹-上')) {
                    base = rest.slice(0, -5);
                    kind = 'wrapperBefore';
                } else if (rest.endsWith('-包裹-下')) {
                    continue; // 纯收尾包裹文本，无信息量
                } else {
                    const rm = rest.match(SHUJUKU_ROW_TAIL_RE);
                    if (rm) {
                        base = rest.slice(0, -rm[0].length);
                        kind = 'row';
                        idx = parseInt(rm[1], 10);
                    }
                }
                let group = exportGroups.get(base);
                if (!group) {
                    group = { header: '', wrapperHeader: '', rows: [], wholes: [] };
                    exportGroups.set(base, group);
                }
                const content = String(e.content || '').trim();
                if (kind === 'header') group.header ||= content;
                else if (kind === 'wrapperBefore') group.wrapperHeader ||= content;
                else if (kind === 'row') {
                    if (content) group.rows.push({ idx, content });
                } else if (content) group.wholes.push(content);
            }
            // 其余未知 TavernDB-ACU-* 条目不纳入：插件会写入包裹/提示类条目，避免把提示词噪声混进分析素材
        }
    }

    // 总结行：新旧条目编号空间可能重叠，优先用现行"总结条目"，无才回退旧版"小总结条目"
    const activeSummaryRows = summaryRows.length > 0 ? summaryRows : smallSummaryRows;
    if (activeSummaryRows.length === 0 && personRows.length === 0 && exportGroups.size === 0 && !outline && !readableData) {
        return null;
    }

    const byIdx = (a, b) => a.idx - b.idx;
    activeSummaryRows.sort(byIdx);
    personRows.sort(byIdx);
    for (const group of exportGroups.values()) group.rows.sort(byIdx);

    const assemble = () => {
        const sections = [];
        const push = (title, lines) => {
            const body = lines.filter(Boolean).join('\n').trim();
            if (body) sections.push(`【${title}】\n${body}`);
        };
        if (outline) push('龙血玄黄·数据库·剧情大纲', [outline]);
        if (activeSummaryRows.length > 0) {
            push('龙血玄黄·数据库·总结表', [shujukuExtractHeaderLine(memoryStart), ...activeSummaryRows.map((r) => r.content)]);
        }
        if (personRows.length > 0) {
            push('龙血玄黄·数据库·重要人物', [shujukuExtractHeaderLine(personsHeader), ...personRows.map((r) => r.content)]);
        }
        for (const [name, group] of exportGroups) {
            if (group.rows.length > 0) {
                const header = shujukuExtractHeaderLine(group.header) || shujukuExtractHeaderLine(group.wrapperHeader);
                push(`龙血玄黄·数据库·${name}`, [header, ...group.rows.map((r) => r.content)]);
            }
            for (const w of group.wholes) push(`龙血玄黄·数据库·${name}`, [w]);
        }
        if (readableData) push('龙血玄黄·数据库·当前数据表', [readableData]);
        return sections;
    };

    // 防膨胀：总结/纪要行随聊天楼层数线性增长，超上限时从贡献最大的行池自最旧行开始丢弃，
    // 保留最新内容（与柚月接口同策略：牺牲最旧记录，保住当前剧情与状态）
    const pools = [activeSummaryRows, ...[...exportGroups.values()].map((g) => g.rows), personRows]
        .filter((p) => p.length > 0);
    const poolChars = (pool) => pool.reduce((s, r) => s + r.content.length + 1, 0);
    let sections = assemble();
    let total = sections.reduce((s, sec) => s + sec.length + 2, 0);
    while (total > SHUJUKU_MAX_TOTAL_CHARS) {
        let best = null;
        let bestLen = 0;
        for (const pool of pools) {
            if (pool.length === 0) continue;
            const len = poolChars(pool);
            if (len > bestLen) { bestLen = len; best = pool; }
        }
        if (!best) break;
        const excess = total - SHUJUKU_MAX_TOTAL_CHARS;
        const avg = Math.max(1, Math.ceil(bestLen / best.length));
        best.splice(0, Math.min(best.length, Math.max(1, Math.ceil(excess / avg))));
        sections = assemble();
        total = sections.reduce((s, sec) => s + sec.length + 2, 0);
    }

    if (sections.length === 0) return null;
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

// ---------- 柏宝书（BaiBaiBook）记忆快照接口 ----------
// 只读 globalThis.STBaiBaiBook.getSnapshot()，不 import 柏宝书模块，零耦合。
// 快照的 point.floor（零基 mesid）与小白x lastSummarizedMesId 同语义，
// 直接进引擎的 ordinalForIndex 转换为 AI 楼层序数。

const BAIBAIBOOK_MAX_TOTAL_CHARS = 40000;

const AFFINITY_INNER_LABELS = {
    '-2': '强烈反感', '-1': '不喜欢', '0': '无明显好恶', '1': '有好感', '2': '感情深厚',
};
const AFFINITY_OUTER_LABELS = {
    '-2': '明显敌对', '-1': '冷淡疏远', '0': '不明显亲近或排斥', '1': '友善亲近', '2': '明显亲近、积极表达',
};

function baibaibookAffinityLabel(value, labels) {
    if (value === null || value === undefined) return '';
    const key = String(value);
    return labels[key] || key;
}

/** 安全读取柏宝书全局 API 快照，不可用时返回 null */
function baibaibookSnapshot() {
    const api = globalThis.STBaiBaiBook;
    if (!api || typeof api.getSnapshot !== 'function') return null;
    try {
        return api.getSnapshot();
    } catch {
        return null;
    }
}

/** 把柏宝书快照渲染为可分析的紧凑文本（全板块） */
function renderBaibaibookSummary(s) {
    if (!s) return '';
    const lines = [];

    // 覆盖完整性
    if (s.coverage && s.coverage.complete === false) {
        const missing = Array.isArray(s.coverage.missingAiFloors) ? s.coverage.missingAiFloors : [];
        if (missing.length > 0) {
            lines.push(`⚠️ 记忆不完整：缺失AI楼层 ${missing.join('、')}`);
        }
    }

    // 当前状态
    if (s.state) {
        const parts = [];
        if (s.state.time) parts.push(`时间: ${s.state.time}`);
        if (s.state.location) parts.push(`地点: ${s.state.location}`);
        if (Array.isArray(s.state.locationPath) && s.state.locationPath.length > 0) {
            parts.push(`位置: ${s.state.locationPath.join(' > ')}`);
        }
        if (parts.length > 0) lines.push(`【当前状态】\n${parts.join('；')}`);
    }

    // 主角
    if (s.protagonist) {
        const p = s.protagonist;
        const parts = [];
        if (p.gender) parts.push(`性别: ${p.gender}`);
        if (p.identity) parts.push(`身份: ${p.identity}`);
        if (p.appearance) parts.push(`外貌: ${p.appearance}`);
        if (p.outfit) parts.push(`穿着: ${p.outfit}`);
        if (p.condition) parts.push(`状态: ${p.condition}`);
        if (parts.length > 0) lines.push(`【主角】\n${parts.join('；')}`);
    }

    // NPC（含好感与外在态度）
    if (Array.isArray(s.npcs) && s.npcs.length > 0) {
        lines.push('【登场人物】');
        for (const npc of s.npcs) {
            const parts = [];
            if (npc.name) parts.push(npc.name);
            if (npc.identity) parts.push(`身份: ${npc.identity}`);
            if (npc.appearance) parts.push(`外貌: ${npc.appearance}`);
            if (npc.outfit) parts.push(`穿着: ${npc.outfit}`);
            if (npc.condition) parts.push(`状态: ${npc.condition}`);
            if (npc.personality) parts.push(`性格: ${npc.personality}`);
            if (npc.tier) parts.push(`分级: ${npc.tier}`);
            const inner = baibaibookAffinityLabel(npc.affinityInner, AFFINITY_INNER_LABELS);
            const outer = baibaibookAffinityLabel(npc.affinityOuter, AFFINITY_OUTER_LABELS);
            if (inner) parts.push(`内心好感: ${inner}`);
            if (outer) parts.push(`外在态度: ${outer}`);
            if (npc.affinityNote) parts.push(`好感说明: ${npc.affinityNote}`);
            if (parts.length > 1) lines.push(`  - ${parts.join('；')}`);
        }
    }

    // 物品清单
    if (Array.isArray(s.items) && s.items.length > 0) {
        lines.push('【物品清单】');
        for (const item of s.items) {
            const parts = [];
            if (item.name) parts.push(item.name);
            if (item.description) parts.push(`描述: ${item.description}`);
            if (item.location) parts.push(`位置: ${item.location}`);
            if (item.quantity !== undefined && item.quantity !== null) parts.push(`数量: ${item.quantity}`);
            if (item.status) parts.push(`状态: ${item.status}`);
            if (parts.length > 1) lines.push(`  - ${parts.join('；')}`);
        }
    }

    // 物品变动日志（取最近20条）
    if (Array.isArray(s.itemLog) && s.itemLog.length > 0) {
        lines.push('【物品变动日志】');
        for (const log of s.itemLog.slice(-20)) {
            const parts = [];
            if (log.action) parts.push(log.action);
            if (log.item) parts.push(log.item);
            if (log.detail) parts.push(log.detail);
            if (log.floor !== undefined && log.floor !== null) parts.push(`楼层: ${log.floor}`);
            if (parts.length > 0) lines.push(`  - ${parts.join('；')}`);
        }
    }

    // 计划与悬念
    if (Array.isArray(s.plans) && s.plans.length > 0) {
        lines.push('【计划与悬念】');
        for (const plan of s.plans) {
            const parts = [];
            if (plan.title) parts.push(plan.title);
            if (plan.description) parts.push(plan.description);
            if (plan.status) parts.push(`状态: ${plan.status}`);
            if (parts.length > 0) lines.push(`  - ${parts.join('；')}`);
        }
    }

    // 场景
    if (Array.isArray(s.scenes) && s.scenes.length > 0) {
        lines.push('【场景】');
        for (const scene of s.scenes) {
            const parts = [];
            if (scene.name) parts.push(scene.name);
            if (scene.path) parts.push(`路径: ${scene.path}`);
            if (scene.description) parts.push(scene.description);
            if (parts.length > 0) lines.push(`  - ${parts.join('；')}`);
        }
    }

    // 生活档案
    if (Array.isArray(s.lifeDetails) && s.lifeDetails.length > 0) {
        lines.push('【生活档案】');
        for (const detail of s.lifeDetails) {
            const parts = [];
            if (detail.subject) parts.push(detail.subject);
            if (detail.text) parts.push(detail.text);
            if (Array.isArray(detail.topics) && detail.topics.length > 0) parts.push(`话题: ${detail.topics.join('、')}`);
            if (detail.tier) parts.push(`层级: ${detail.tier}`);
            if (parts.length > 0) lines.push(`  - ${parts.join('；')}`);
        }
    }

    // 自定义变量
    if (s.vars && typeof s.vars === 'object' && Object.keys(s.vars).length > 0) {
        lines.push('【自定义变量】');
        for (const [key, value] of Object.entries(s.vars)) {
            const v = typeof value === 'object' ? JSON.stringify(value) : String(value);
            lines.push(`  ${key}: ${v}`);
        }
    }

    let text = lines.join('\n');
    // 防膨胀：超出上限截断（保留靠前部分）
    if (text.length > BAIBAIBOOK_MAX_TOTAL_CHARS) {
        text = text.slice(0, BAIBAIBOOK_MAX_TOTAL_CHARS) + '…（已截断）';
    }
    return text;
}

/**
 * 读取柏宝书记忆快照并组装为可分析的紧凑文本（全板块）。
 * @returns {{boundary: number, text: string}|null} 无插件/无快照/无覆盖楼层时返回 null（回退纯原文）
 */
export function getBaibaibookSummary() {
    const snapshot = baibaibookSnapshot();
    if (!snapshot) return null;
    const floor = Number(snapshot.point?.floor);
    if (!Number.isFinite(floor) || floor < 0) return null;
    // at: "before" 时状态不含目标楼，边界退一格；at: "after"（默认）包含目标楼
    const at = String(snapshot.point?.at || 'after');
    const boundary = at === 'before' ? Math.max(0, floor - 1) : floor;
    if (boundary < 0) return null;
    const text = renderBaibaibookSummary(snapshot);
    if (!text) return null;
    return { boundary, text };
}

/** 面板状态探测：有快照数据时返回 { revision, boundary }，否则 null */
export function getBaibaibookStatus() {
    const snapshot = baibaibookSnapshot();
    if (!snapshot) return null;
    const floor = Number(snapshot.point?.floor);
    if (!Number.isFinite(floor) || floor < 0) return null;
    const at = String(snapshot.point?.at || 'after');
    const boundary = at === 'before' ? Math.max(0, floor - 1) : floor;
    if (boundary < 0) return null;
    return { revision: Number(snapshot.revision) || 0, boundary };
}
