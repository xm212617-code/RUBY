// RUBY 写卡模式 v2：记录制引擎。
// 监听原生对话通道，捕捉 <ruby新条目>/<ruby更新条目 编号="X"> 标记入库；
// <ruby合成> 触发合成角色卡：整理干净条目 + 生成 RubyAnalyzer 方案 + 下载 v3 JSON。
// 完全不干预生成——创作者用自己的预设/API 对话，RUBY 只监听并操作世界书。
import { ctx, st, q, log, warn } from './env.js';
import * as config from './config.js';
import { CARDWRITER_DATA } from './cardwriter-data.js';

const DRAFT_BOOK = CARDWRITER_DATA.draftBook;
const DEEP_DEPTH = 0;
const DEEP_ORDER = 999;
const GUIDE_ORDER = 500;
const REGISTRY_ORDER = 460;

const RULES_KEY = 'RUBY写卡规则';
const PERSONA_KEY = 'Ruby写卡助手';
const APPENDIX_KEY = 'RUBY分析器原理附录';
const STEP_PREFIX = 'RUBY写卡';
const ROADMAP_KEY = 'RUBY写卡_路线图';
const REGISTRY_KEY = 'RUBY写卡_编号知识';
const INVENTORY_KEY = 'RUBY写卡_世界书现状';
const HOLD_KEY = 'RUBY写卡_继续聊聊';
const RECORD_PREFIX = 'ruby记录_';
const LEGACY_DRAFT_PREFIX = 'ruby草稿_';
const LEGACY_STEP_IDS = ['Step6.5', 'Step8'];

const state = {
    enabled: false,
    active: false,
    stepId: null,
    lastStepId: null,
    lastHandledMessage: -1,
    busy: false,
    lastError: null,
    lastAction: '',
    draftCount: 0,
    startedAt: null,
};

const listeners = new Set();
let initialized = false;

export function onStateChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function emitState() {
    for (const fn of listeners) {
        try { fn(getState()); } catch { /* ignore */ }
    }
}

export function getState() {
    return { ...state, stepName: getStep(state.stepId)?.name || '' };
}

export function getStep(stepId) {
    return CARDWRITER_DATA.steps.find((s) => s.id === stepId) || null;
}

export function getSteps() {
    return CARDWRITER_DATA.steps.map(({ id, name, optional, tool, special }) => ({ id, name, optional, tool, special: !!special }));
}

function isScanStep(stepId) {
    return stepId === 'ScanChar' || stepId === 'ScanChat';
}

function notify(kind, message) {
    if (!config.getUi().notify) return;
    const fn = window.toastr?.[kind];
    if (typeof fn === 'function') fn(message, '', { timeOut: 4500 });
}

// ---------- 配置（写卡开关存 UI 偏好，随聊天元数据存步骤进度） ----------

function uiKey() {
    return 'cardwriter';
}

export function getSettings() {
    const ui = config.getUi() || {};
    return {
        enabled: !!ui[uiKey()]?.enabled,
        draftToBook: ui[uiKey()]?.draftToBook !== false,
        showGuide: ui[uiKey()]?.showGuide !== false,
    };
}

export function saveSettings(patch) {
    const ui = config.getUi() || {};
    const cur = { enabled: false, draftToBook: true, showGuide: true, ...(ui[uiKey()] || {}) };
    const next = { ...cur, ...patch };
    config.saveUi({ [uiKey()]: next });
    window.dispatchEvent(new CustomEvent('ruby:cardwriter-changed'));
    return next;
}

function chatMetaKey() { return 'ruby_cardwriter'; }

function readProgress() {
    const c = ctx();
    const raw = c?.chatMetadata?.[chatMetaKey()];
    return (raw && typeof raw === 'object') ? raw : null;
}

async function writeProgress(patch) {
    const c = ctx();
    if (!c?.chatMetadata) return;
    const cur = readProgress() || {};
    c.chatMetadata[chatMetaKey()] = { ...cur, ...patch, updatedAt: Date.now() };
    try {
        if (typeof c.saveMetadata === 'function') await c.saveMetadata();
    } catch (e) {
        warn(`saveMetadata failed: ${e.message}`);
    }
}

function clearProgress() {
    const c = ctx();
    if (!c?.chatMetadata) return;
    delete c.chatMetadata[chatMetaKey()];
    try { if (typeof c.saveMetadata === 'function') c.saveMetadata(); } catch { /* ignore */ }
}

// ---------- 世界书条目操作（直接 API，绕过斜杠命令解析器） ----------

const ROLE_SYSTEM = 0;
const POS_AT_DEPTH = 4;

function stepKey(step) {
    return `${STEP_PREFIX}_${step.id.replace('.', '_')}`;
}

async function ensureDraftBook() {
    try {
        const named = String(await st(`/getchatbook create=true name=${q(DRAFT_BOOK)}`)).trim();
        if (named) return named;
    } catch (e) {
        warn(`[cardwriter] named chat book unavailable (${e.message}), falling back to auto name`);
    }
    return String(await st('/getchatbook create=true')).trim();
}

function findEntryIn(entries, key) {
    for (const e of Object.values(entries)) {
        if (Array.isArray(e?.key) && e.key.includes(key)) return e;
    }
    return null;
}

async function ensureEntryIn(book, entries, key) {
    const found = findEntryIn(entries, key);
    if (found) return found;
    const uidRaw = await st(`/createentry file=${q(book)} key=${q(key)} ""`);
    const uid = parseInt(uidRaw, 10);
    if (isNaN(uid)) throw new Error(`create entry failed: ${key}`);
    const c = ctx();
    const fresh = await c.loadWorldInfo(book);
    const e = fresh?.entries?.[uid];
    if (!e) throw new Error(`entry missing after create: ${key}`);
    if (!entries[uid]) entries[uid] = e;
    return e;
}

async function saveBook(book, data) {
    const c = ctx();
    await c.saveWorldInfo(book, data, true);
}

async function loadBookData(book) {
    const c = ctx();
    const data = await c.loadWorldInfo(book);
    if (!data?.entries) throw new Error(`world book not found: ${book}`);
    return data;
}

async function setupBaseEntries(book) {
    const data = await loadBookData(book);
    const entries = data.entries;

    const rules = await ensureEntryIn(book, entries, RULES_KEY);
    Object.assign(rules, {
        content: CARDWRITER_DATA.rules,
        comment: 'RUBY写卡·步骤规则（常驻）',
        position: POS_AT_DEPTH, depth: DEEP_DEPTH, order: DEEP_ORDER,
        role: ROLE_SYSTEM, constant: true, disable: false,
    });

    const persona = await ensureEntryIn(book, entries, PERSONA_KEY);
    Object.assign(persona, {
        content: CARDWRITER_DATA.persona,
        comment: 'RUBY写卡·人设（常驻）',
        position: POS_AT_DEPTH, depth: DEEP_DEPTH, order: DEEP_ORDER - 1,
        role: ROLE_SYSTEM, constant: true, disable: false,
    });

    const appendix = await ensureEntryIn(book, entries, APPENDIX_KEY);
    Object.assign(appendix, {
        content: CARDWRITER_DATA.appendix,
        comment: 'RUBY写卡·分析器原理附录（按需）',
        position: POS_AT_DEPTH, depth: 4, order: 100,
        role: ROLE_SYSTEM, constant: true, disable: true,
    });

    await saveBook(book, data);
    log('[cardwriter] base entries ready');
}

// ---------- 记录系统 ----------

/** 各步骤记录的默认条目形态（草稿书内） */
function recordDefaults(stepId) {
    switch (stepId) {
        case 'StepW': return { position: 0, order: 10, constant: false, disable: false };
        case 'Step0': return { position: 0, order: 11, constant: false, disable: false };
        case 'Step1': return { position: 0, order: 12, constant: false, disable: false };
        case 'StepL': return { position: 0, order: 13, constant: false, disable: false };
        case 'Step2': return { position: 0, order: 14, constant: false, disable: false };
        case 'Step3': return { position: 0, order: 105, constant: false, disable: false };
        case 'Step4': return { position: 0, order: 15, constant: false, disable: false };
        case 'Step5': return { position: 0, order: 50, constant: false, disable: false };
        case 'Step6': return { position: 0, order: 40, constant: true, disable: false };
        case 'Step7': return { position: 0, order: 200, constant: false, disable: true };
        default: return { position: 0, order: 90, constant: false, disable: false };
    }
}

function recordKey(stepId, num) {
    const safe = String(num || '').replace(/[^\w-]/g, '').slice(0, 12) || '000';
    return `${RECORD_PREFIX}${stepId}_${safe}`;
}

/** 从记录 yaml 提取展示名：character: 行 → 任务名: 行 → 顶层首键 → 兜底 */
function extractRecordLabel(yamlText) {
    const s = String(yamlText || '');
    let m = s.match(/^\s*character:\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '').slice(0, 24);
    m = s.match(/^\s*任务名:\s*(.+)$/m);
    if (m) return m[1].trim().slice(0, 24);
    m = s.match(/^\s*任务:\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^生成/, '').slice(0, 24);
    m = s.match(/^[^\s#:'"][^:]{0,30}?:(?=[ \t]|$)/m);
    if (m) return m[0].replace(/:$/, '').trim();
    return '';
}

/** 记录的身份名（相似度合并用） */
function extractRecordNames(yamlText) {
    const s = String(yamlText || '');
    const names = [];
    let m = s.match(/^\s*character:\s*(.+)$/m);
    if (m) names.push(m[1].trim().replace(/^["']|["']$/g, ''));
    m = s.match(/生成(.+?)的【/);
    if (m) names.push(m[1].trim());
    if (names.length === 0) {
        m = s.match(/^[^\s#:'"][^:]{0,30}?:(?=[ \t]|$)/m);
        if (m) names.push(m[0].replace(/:$/, '').trim());
    }
    return names.filter((n) => n && n.length <= 24);
}

function normName(s) {
    return String(s || '').toLowerCase().replace(/[\s_-]+/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

export function namesSimilar(a, b) {
    const na = normName(a);
    const nb = normName(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.length >= 2 && nb.length >= 2) return na.includes(nb) || nb.includes(na);
    return false;
}

/** 提取消息中的全部记录标记。返回 [{action:'new'|'update', num, yaml}] */
export function extractRecords(text) {
    const s = String(text || '');
    const out = [];
    const patterns = [
        { re: /<ruby新条目>\s*```yaml[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*\r?\n?<\/ruby新条目>/g, action: 'new' },
        { re: /<ruby更新条目([^>]*)>\s*```yaml[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*\r?\n?<\/ruby更新条目>/g, action: 'update' },
    ];
    for (const { re, action } of patterns) {
        for (const m of s.matchAll(re)) {
            let num = '';
            let yaml = '';
            if (action === 'new') {
                yaml = m[1];
            } else {
                const attr = m[1] || '';
                const nm = attr.match(/编号\s*=\s*["']?([\w-]*)["']?/);
                num = nm ? nm[1] : '';
                yaml = m[2];
            }
            yaml = yaml.trim();
            if (!yaml) continue;
            out.push({ action, num, yaml });
        }
    }
    return out;
}

/** 合成标记：提取 <ruby合成> 内的 JSON manifest */
export function extractManifest(text) {
    const m = String(text || '').match(/<ruby合成>\s*```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*\r?\n?<\/ruby合成>/);
    if (!m) return null;
    try {
        const parsed = JSON.parse(m[1]);
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.条目)) return null;
        return parsed;
    } catch {
        return null;
    }
}

/** 切换标记：创作者表示可以进入下一步时 AI 输出 <ruby切换/>（可带 步骤="StepX"）。返回 {target} 或 null */
export function extractSwitch(text) {
    const s = String(text || '');
    let m = s.match(/<ruby切换(?:\s+步骤\s*=\s*["']([^"']+)["'])?\s*\/>/);
    if (!m) m = s.match(/<ruby切换(?:\s+步骤\s*=\s*["']([^"']+)["'])?\s*>\s*<\/ruby切换>/);
    if (!m) return null;
    return { target: m[1] || '' };
}

/** 主链上的下一步（跳过工具/特殊步骤：StepX、Overview、ScanChar、ScanChat） */
function nextStepOf(stepId) {
    const main = CARDWRITER_DATA.steps.filter((s) => !s.tool);
    const i = main.findIndex((s) => s.id === stepId);
    if (i < 0 || i === main.length - 1) return null;
    return main[i + 1].id;
}

/** 从世界书 entries 收集记录清单：[{stepId, num, label, key}] */
function collectRecords(entries) {
    const out = [];
    for (const e of Object.values(entries)) {
        const primary = String(Array.isArray(e?.key) ? e.key[0] : '');
        if (!primary.startsWith(RECORD_PREFIX)) continue;
        const rest = primary.slice(RECORD_PREFIX.length); // StepId_num
        const m = rest.match(/^([^_]+)_(.+)$/);
        if (!m) continue;
        const comment = String(e.comment || '');
        const cm = comment.match(/·([^·]+)·([^·]*)$/);
        out.push({
            stepId: m[1],
            num: m[2],
            label: cm ? (cm[2] || cm[1]) : (extractRecordLabel(String(e.content || '')) || m[2]),
            key: primary,
        });
    }
    return out.sort((a, b) => a.stepId.localeCompare(b.stepId) || a.num.localeCompare(b.num));
}

/** 编号知识注入：当前步骤的记录清单（Overview=全部步骤），告知AI该更新哪条 */
function buildRegistryContent(stepId, records) {
    const list = stepId === 'Overview' ? records : records.filter((r) => r.stepId === stepId);
    const lines = ['【RUBY写卡·编号知识】（本条目由RUBY自动维护，禁止在回复中复述）'];
    if (list.length === 0) {
        lines.push(stepId === 'Overview' ? '全部步骤暂无入库记录。' : `当前步骤（${stepId}）暂无入库记录——首次产出用 <ruby新条目>。`);
    } else {
        const scope = stepId === 'Overview' ? '全部步骤的记录' : `当前步骤（${stepId}）的记录`;
        lines.push(`${scope}：`);
        for (const r of list) lines.push(`  ${r.stepId}_${r.num} · ${r.label || '（未命名）'}`);
        lines.push('');
        lines.push('更新已有内容 → <ruby更新条目 编号="编号">（编号取下划线后的部分，如 001）');
        lines.push('全新交付物 → <ruby新条目>（拿不准归属就开新条目）');
        if (stepId === 'Overview') {
            lines.push('合成清单的"记录"字段引用上面的 步骤_编号（如 Step3_001）。');
        }
    }
    lines.push('记录标记只在创作者认可定稿时输出；平时讨论严禁使用。');
    return lines.join('\n');
}

async function refreshRegistryEntry(book, entries, stepId) {
    const records = collectRecords(entries);
    const entry = await ensureEntryIn(book, entries, REGISTRY_KEY);
    Object.assign(entry, {
        content: buildRegistryContent(stepId, records),
        comment: 'RUBY写卡·编号知识（自动维护）',
        position: POS_AT_DEPTH, depth: 1, order: REGISTRY_ORDER,
        role: ROLE_SYSTEM, constant: true, disable: false,
    });
    return records;
}

/** 写入一条记录（新/更新）。返回 {key, label, action} */
async function writeRecord(record, stepId) {
    if (!getSettings().draftToBook) return null;
    const book = await ensureDraftBook();
    const data = await loadBookData(book);
    const entries = data.entries;
    const step = getStep(stepId);
    const label = extractRecordLabel(record.yaml) || '未命名';
    const names = extractRecordNames(record.yaml);
    const defaults = recordDefaults(stepId);

    let target = null;
    let action = record.action;

    if (record.action === 'update') {
        // 优先按编号精确命中；编号为空或没中，按身份相似度兜底
        const exact = record.num ? findEntryIn(entries, recordKey(stepId, record.num)) : null;
        if (exact) {
            target = exact;
        } else {
            const sameStep = collectRecords(entries).filter((r) => r.stepId === stepId);
            for (const r of sameStep) {
                const e = findEntryIn(entries, r.key);
                const storedNames = Array.isArray(e?.key) ? e.key.slice(1) : [];
                if (names.some((n) => storedNames.some((s) => namesSimilar(s, n)))) {
                    target = e;
                    log(`[cardwriter] record update: matched ${r.key} by name similarity (编号 ${record.num || '(空)'} 未命中)`);
                    break;
                }
            }
            if (!target) {
                const num = record.num || nextRecordNum(entries, stepId);
                target = await ensureEntryIn(book, entries, recordKey(stepId, num));
                action = 'new';
            }
        }
    } else {
        // 新条目：编号撞已有记录时按更新处理（AI复用了编号）
        const num = record.num || nextRecordNum(entries, stepId);
        const exists = findEntryIn(entries, recordKey(stepId, num));
        if (exists) {
            target = exists;
            action = 'update';
            log(`[cardwriter] record new: 编号 ${num} 已存在，按更新处理`);
        } else {
            target = await ensureEntryIn(book, entries, recordKey(stepId, num));
        }
    }

    const primary = String(target.key?.[0] || '');
    const oldExtras = Array.isArray(target.key) ? target.key.slice(1) : [];
    target.key = [...new Set([primary, ...oldExtras, ...names])];
    target.comment = `RUBY写卡记录·${stepId}·${primary.slice(RECORD_PREFIX.length + stepId.length + 1)}·${label}`;
    target.content = record.yaml;
    target.position = defaults.position;
    target.order = defaults.order;
    target.constant = defaults.constant;
    target.disable = defaults.disable;
    target.excludeRecursion = true;
    target.preventRecursion = true;

    await refreshRegistryEntry(book, entries, stepId);
    // 清点步骤中落库：聊天书清单同步刷新，Ruby 看到的 uid 始终最新
    if (isScanStep(stepId)) {
        await refreshInventoryEntry(book, entries, stepId === 'ScanChar' ? 'char' : 'chat');
    }
    await saveBook(book, data);
    state.draftCount += 1;
    log(`[cardwriter] record ${action === 'new' ? 'created' : 'updated'}: ${primary} (${label}) -> ${book}`);
    return { key: primary, label, action };
}

/** 给当前步骤分配下一个可用编号（三位数字递增） */
function nextRecordNum(entries, stepId) {
    const nums = collectRecords(entries)
        .filter((r) => r.stepId === stepId)
        .map((r) => parseInt(r.num, 10))
        .filter((n) => !isNaN(n));
    const next = (nums.length ? Math.max(...nums) : 0) + 1;
    return String(next).padStart(3, '0');
}

// ---------- 步骤条目管理 ----------

/** 世界书编辑器当前正显示该书时，重渲染为最新落盘状态。 */
function reloadEditorIfShowing(book) {
    try {
        const sel = $('#world_editor_select');
        if (!sel?.length) return;
        const selected = sel.find('option:selected')?.[0];
        if (!selected || selected.textContent !== book) return;
        sel.trigger('change');
    } catch { /* 编辑器未打开或不可用 */ }
}

function deleteEntriesByKeys(entries, keys) {
    const keySet = new Set(keys);
    let removed = 0;
    for (const [uid, e] of Object.entries(entries)) {
        if (Array.isArray(e?.key) && e.key.some((k) => keySet.has(k))) {
            delete entries[uid];
            removed++;
        }
    }
    return removed;
}

async function setStepEntries(book, stepId) {
    const data = await loadBookData(book);
    const entries = data.entries;

    // 清理遗留：旧会话的临时注入、已移除步骤（Step6.5/Step8）工件、v1 草稿条目
    const legacyKeys = [
        HOLD_KEY,
        ...LEGACY_STEP_IDS.flatMap((id) => {
            const sk = `RUBY写卡_${id.replace('.', '_')}`;
            return [sk, `${sk}_说明`, `${RECORD_PREFIX}${id}_`, `${LEGACY_DRAFT_PREFIX}${id}`];
        }),
    ];
    deleteEntriesByKeys(entries, legacyKeys);
    let legacyDraftRemoved = 0;
    for (const [uid, e] of Object.entries(entries)) {
        const primary = String(Array.isArray(e?.key) ? e.key[0] : '');
        if (primary.startsWith(LEGACY_DRAFT_PREFIX)) {
            delete entries[uid];
            legacyDraftRemoved++;
        }
    }

    // 关闭全部步骤条目（含说明条目）
    for (const s of CARDWRITER_DATA.steps) {
        const key = stepKey(s);
        for (const k of [key, `${key}_说明`]) {
            const e = findEntryIn(entries, k);
            if (e) e.disable = true;
        }
    }

    // ★ 第一段原子提交：先落盘"全部步骤已关闭"的基准状态。
    await saveBook(book, data);

    if (stepId) {
        const step = getStep(stepId);
        if (step) {
            const key = stepKey(step);
            const entry = await ensureEntryIn(book, entries, key);
            Object.assign(entry, {
                content: step.instruction,
                comment: `RUBY写卡·${step.id} ${step.name}`,
                position: POS_AT_DEPTH, depth: 1, order: 600,
                role: ROLE_SYSTEM, constant: true, disable: false,
            });

            if (getSettings().showGuide && step.guide) {
                const gEntry = await ensureEntryIn(book, entries, `${key}_说明`);
                Object.assign(gEntry, {
                    content: step.guide,
                    comment: `RUBY写卡·${step.id} 说明（气泡同步）`,
                    position: POS_AT_DEPTH, depth: 1, order: GUIDE_ORDER,
                    role: ROLE_SYSTEM, constant: true, disable: false,
                });
            }
        }
    }

    // 流程路线图 + 编号知识：常驻注入，随当前状态刷新
    await refreshRoadmapEntry(book, entries, stepId);
    await refreshRegistryEntry(book, entries, stepId);

    // 特殊步骤（ScanChar/ScanChat）：代码清点对应世界书 → 【世界书现状】常驻知识
    if (isScanStep(stepId)) {
        await refreshInventoryEntry(book, entries, stepId === 'ScanChar' ? 'char' : 'chat');
    }

    // ★ 第二段原子提交：开启目标步骤的最终状态
    await saveBook(book, data);
    reloadEditorIfShowing(book);

    if (legacyDraftRemoved) {
        log(`[cardwriter] removed ${legacyDraftRemoved} legacy v1 draft entries`);
    }

    // 验证日志
    const verify = [];
    for (const e of Object.values(data.entries)) {
        if (Array.isArray(e?.key) && e.key.some((k) => String(k).startsWith(STEP_PREFIX) || k === RULES_KEY || k === PERSONA_KEY || k === REGISTRY_KEY || k === ROADMAP_KEY || k === INVENTORY_KEY)) {
            if (!e.disable) verify.push(`${e.key[0]}(${String(e.content || '').length}ch)`);
        }
    }
    log(`[cardwriter] step entries active: ${stepId || 'none'} | injecting: ${verify.join(' | ') || 'nothing'}`);
}

// ---------- 路线图 ----------

function buildRoadmapContent(stepId) {
    const mainSteps = CARDWRITER_DATA.steps.filter((s) => !s.tool);
    const overview = CARDWRITER_DATA.steps.find((s) => s.id === 'Overview');
    const lines = ['【RUBY写卡·流程路线图】（本条目由RUBY自动维护，禁止在回复中复述整个路线图）', '完整写卡流程：'];
    mainSteps.forEach((s, i) => {
        lines.push(`${i + 1}. ${s.id} ${s.name}——${s.brief}`);
    });
    lines.push(`终. ${overview.id} ${overview.name}——${overview.brief}（创作者手动进入）`, '');
    const cur = getStep(stepId);
    if (!cur) {
        lines.push('当前：无活跃步骤。');
    } else {
        const idx = mainSteps.findIndex((s) => s.id === stepId);
        const total = mainSteps.length;
        if (cur.id === 'Overview') {
            lines.push(`当前：合成阶段（${overview.name}）。${overview.brief}。`);
        } else if (idx >= 0) {
            lines.push(`当前：第${idx + 1}/${total}步——${cur.id} ${cur.name}，${cur.brief}。`);
            lines.push('每个步骤都可以反复工作：产出按记录入库，RUBY不自动切换，创作者自己决定何时走下一步。');
        } else {
            lines.push(`当前：${cur.id} ${cur.name}——${cur.brief}（${cur.special ? '特殊步骤，仅手动进入；重新点击步骤卡可刷新清点' : '工具步骤，不在主流程序列中'}）。`);
        }
    }
    return lines.join('\n');
}

async function refreshRoadmapEntry(book, entries, stepId) {
    const entry = await ensureEntryIn(book, entries, ROADMAP_KEY);
    Object.assign(entry, {
        content: buildRoadmapContent(stepId),
        comment: 'RUBY写卡·流程路线图（自动维护）',
        position: POS_AT_DEPTH, depth: 1, order: 450,
        role: ROLE_SYSTEM, constant: true, disable: false,
    });
}

// ---------- 世界书现状清点（特殊步骤 ScanChar / ScanChat） ----------

const POS_LABELS = { 0: '角色前', 1: '角色后', 4: 'D0' };
const ROLE_NAMES = ['system', 'user', 'assistant'];

function posLabelOf(entry) {
    const pos = entry?.position;
    const name = POS_LABELS[pos] ?? `位置${pos ?? '?'}`;
    if (pos === 4 && typeof entry?.role === 'number' && entry.role > 0) {
        return `${name}·${ROLE_NAMES[entry.role] || entry.role}`;
    }
    return name;
}

function isRubyProcessEntry(primary) {
    return primary === RULES_KEY || primary === PERSONA_KEY || primary === APPENDIX_KEY || primary === HOLD_KEY ||
        primary === ROADMAP_KEY || primary === REGISTRY_KEY || primary === INVENTORY_KEY ||
        primary.startsWith(STEP_PREFIX);
}

/** 把一本书的 entries 清点成人话清单（uid/条目名/关键词/位置/灯位/概率/预览） */
function buildInventoryContent(scope, bookName, entries) {
    const scopeName = scope === 'char' ? '主世界书' : '聊天世界书';
    const lines = [
        '【RUBY写卡·世界书现状】（本条目由RUBY代码自动维护，禁止在回复中整段复述）',
        `清点范围：《${bookName}》（${scopeName}）· 共 ${Object.keys(entries).length} 条`,
        '',
    ];
    const sorted = Object.entries(entries)
        .map(([uid, e]) => ({ uid: parseInt(uid, 10), e }))
        .sort((a, b) => a.uid - b.uid);
    for (const { uid, e } of sorted) {
        const keys = (Array.isArray(e?.key) ? e.key : []).map(String).filter(Boolean);
        const sec = (Array.isArray(e?.keysecondary) ? e.keysecondary : []).map(String).filter(Boolean);
        const comment = String(e?.comment || '').trim();
        const primary = keys[0] || '';
        const content = String(e?.content || '');
        const preview = content.replace(/\s+/g, ' ').trim().slice(0, 60);
        const light = e?.disable ? '关闭' : (e?.constant ? '蓝灯' : '绿灯');
        const prob = e?.useProbability && typeof e?.probability === 'number' && e.probability < 100 ? ` · 概率${e.probability}%` : '';
        const sel = sec.length ? ` · 副词${e?.selective ? 'AND生效' : '未生效'}` : '';
        lines.push(`uid=${uid} · ${comment || primary || '（未命名）'}${isRubyProcessEntry(primary) ? ' ·（RUBY流程条目，合成清单禁止引用）' : ''}`);
        lines.push(`  关键词[${keys.join('、')}]${sec.length ? ` · 副关键词[${sec.join('、')}]` : ''} · ${posLabelOf(e)} · 顺序${e?.order ?? '?'} · ${light}${sel}${prob}${content.length ? ` · 内容${content.length}字` : ' · 无内容'}`);
        if (preview) lines.push(`  预览：${preview}…`);
    }
    lines.push('');
    lines.push('合成清单引用既有条目：对象 {"书": "...", "uid": N} 或字符串 "主世界书:N"/"聊天世界书:N"；条目字段省略=沿用现状，填写=覆盖。');
    return lines.join('\n');
}

/**
 * 清点并写入【世界书现状】常驻知识条目。
 * scope='char' 扫当前卡主世界书；scope='chat' 扫当前聊天世界书（写卡会话即草稿书）。
 * 条目创建后常驻注入（不随离开步骤关闭），重新进入扫描步骤即刷新。
 */
async function refreshInventoryEntry(book, entries, scope) {
    let scanName = '';
    let scanEntries = null;
    let error = '';
    if (scope === 'char') {
        try { scanName = String(await st('/getcharbook')).trim(); } catch { /* 无主世界书 */ }
        if (!scanName) {
            error = '当前角色卡未绑定主世界书（或不可读）——没有可清点的既有条目；如创作者有设定文件，请走常规步骤存记录。';
        } else {
            try {
                const d = await loadBookData(scanName);
                scanEntries = d.entries;
            } catch (e) {
                error = `主世界书读取失败：${e.message}`;
            }
        }
    } else {
        scanName = book;
        scanEntries = entries;
    }
    const content = error || buildInventoryContent(scope, scanName || '（无）', scanEntries || {});
    const entry = await ensureEntryIn(book, entries, INVENTORY_KEY);
    Object.assign(entry, {
        content,
        comment: `RUBY写卡·世界书现状（${scope === 'char' ? '主世界书' : '聊天世界书'}清点，自动维护）`,
        position: POS_AT_DEPTH, depth: 1, order: 470,
        role: ROLE_SYSTEM, constant: true, disable: false,
    });
    log(`[cardwriter] inventory refreshed: ${scope === 'char' ? 'char' : 'chat'} book "${scanName}" (${error ? 'error' : Object.keys(scanEntries || {}).length + ' entries'})`);
    return entry;
}

// ---------- 步骤切换与会话 ----------

/** 内部切换核心（无 busy 守卫）：供 handleGenerationEnded 在记录落库后执行切换标记 */
async function applyStepSwitch(stepId) {
    const book = await ensureDraftBook();
    await setStepEntries(book, stepId);
    state.stepId = stepId;
    state.lastStepId = stepId;
    state.lastAction = `切换标记 → ${stepId} ${getStep(stepId)?.name || ''}`;
    await writeProgress({ stepId, stepName: getStep(stepId)?.name || '' });
    notify('info', `RUBY写卡：已自动切换到 ${stepId} ${getStep(stepId)?.name || ''}`);
}

export async function switchStep(stepId, { manual = false } = {}) {
    if (state.busy) return false;
    if (!state.active) {
        state.lastError = '写卡会话未激活';
        emitState();
        return false;
    }
    const step = getStep(stepId);
    if (stepId && !step) {
        state.lastError = `未知步骤: ${stepId}`;
        emitState();
        return false;
    }
    state.busy = true;
    try {
        const book = await ensureDraftBook();
        await setStepEntries(book, stepId);
        state.stepId = stepId;
        state.lastStepId = stepId;
        state.lastAction = `${manual ? '手动' : '自动'}切换 → ${stepId || '结束'}`;
        await writeProgress({ stepId, stepName: step?.name || '' });
        emitState();
        notify('info', `RUBY写卡：已切换到 ${stepId ? `${stepId} ${step?.name}` : '空闲'}`);
        return true;
    } catch (e) {
        state.lastError = e.message;
        warn(`[cardwriter] switchStep failed: ${e.message}`);
        emitState();
        return false;
    } finally {
        state.busy = false;
    }
}

export async function startSession(stepId = 'StepW') {
    if (state.busy) return false;
    if (!ctx()?.chat) {
        state.lastError = '请先打开一个聊天';
        emitState();
        return false;
    }
    state.busy = true;
    try {
        const book = await ensureDraftBook();
        await setupBaseEntries(book);
        await setStepEntries(book, stepId);
        const c = ctx();
        Object.assign(state, {
            active: true,
            stepId,
            lastStepId: stepId,
            // 楼层游标从当前聊天末尾起算：只捕捉会话开始后的新楼层，历史楼层不重放
            // （历史里的合成清单由 scanAndPromptManifest 按 manifestPrompted 水位补扫）
            lastHandledMessage: Array.isArray(c?.chat) ? c.chat.length - 1 : -1,
            lastError: null,
            lastAction: `会话开始 → ${stepId}`,
            draftCount: 0,
            startedAt: Date.now(),
        });
        await writeProgress({ stepId, stepName: getStep(stepId)?.name || '', book });
        emitState();
        notify('success', `RUBY写卡会话已开始（${stepId} ${getStep(stepId)?.name || ''}），规则与路线图已注入`);
        setTimeout(() => { scanAndPromptManifest().catch(() => { }); }, 0);
        return true;
    } catch (e) {
        state.lastError = e.message;
        warn(`[cardwriter] startSession failed: ${e.message}`);
        emitState();
        return false;
    } finally {
        state.busy = false;
    }
}

export async function endSession({ keepDrafts = true } = {}) {
    if (state.busy) return false;
    state.busy = true;
    try {
        const book = await ensureDraftBook();
        const data = await loadBookData(book);
        if (!keepDrafts) {
            for (const [uid, e] of Object.entries(data.entries)) {
                const k = Array.isArray(e?.key) ? e.key[0] : '';
                if (k === RULES_KEY || k === PERSONA_KEY || k === APPENDIX_KEY || k === HOLD_KEY || k === ROADMAP_KEY || k === REGISTRY_KEY || k === INVENTORY_KEY ||
                    k.startsWith(STEP_PREFIX) || k.startsWith(RECORD_PREFIX) || k.startsWith(LEGACY_DRAFT_PREFIX)) {
                    delete data.entries[uid];
                }
            }
        } else {
            const offKeys = new Set([RULES_KEY, PERSONA_KEY, ROADMAP_KEY, REGISTRY_KEY, INVENTORY_KEY]);
            for (const s of CARDWRITER_DATA.steps) {
                offKeys.add(stepKey(s));
                offKeys.add(`${stepKey(s)}_说明`);
            }
            for (const e of Object.values(data.entries)) {
                if (Array.isArray(e?.key) && e.key.some((k) => offKeys.has(k))) e.disable = true;
            }
        }
        await saveBook(book, data);
        reloadEditorIfShowing(book);
        Object.assign(state, {
            active: false,
            stepId: null,
            lastStepId: null,
            lastHandledMessage: -1,
            lastAction: keepDrafts ? '会话结束（记录保留）' : '会话结束（条目清空）',
        });
        clearProgress();
        emitState();
        notify('info', keepDrafts ? 'RUBY写卡会话已结束，记录保留在聊天世界书' : 'RUBY写卡会话已结束，写卡条目已清空');
        return true;
    } catch (e) {
        state.lastError = e.message;
        warn(`[cardwriter] endSession failed: ${e.message}`);
        emitState();
        return false;
    } finally {
        state.busy = false;
    }
}

// ---------- 合成角色卡 ----------

const POS_MAP = { '角色前': 0, '角色后': 1, 'D0': 4 };

function sanitizeDownloadName(name) {
    return String(name || '角色卡').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
}

function manifestSummary(manifest) {
    const entries = manifest.条目 || [];
    const tasks = manifest.分析任务 || [];
    const nameOf = (e) => e.条目名 || (e.uid != null ? `${e.书 || '书'}:${e.uid}` : (e.记录 || '未命名'));
    return [
        `卡名：${manifest.卡名 || '（未命名）'}`,
        `条目 ${entries.length} 条：${entries.map((e) => `${nameOf(e)}[${(e.关键词 || []).join('/')}]·${e.位置 || '角色前'}${e.顺序 != null ? '#' + e.顺序 : ''}·${e.灯位 || '蓝灯'}`).join('；') || '（无）'}`,
        `分析任务 ${tasks.length} 个：${tasks.map((t) => `${t.任务名}（捕捉:${(t.捕捉关键词 || []).join('/')}）`).join('；') || '（无）'}`,
    ].join('\n');
}

/** 合成确认弹窗：检测到合成清单 → 现在下载 / 再改改。返回 Promise<'build'|'chat'> */
function showBuildConfirm(manifest) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.id = 'ruby_cw_confirm';
        overlay.innerHTML = `
            <div class="cw-confirm-card">
                <div class="cw-confirm-title">📦 卡已写好：${sanitizeDownloadName(manifest.卡名)}</div>
                <div class="cw-confirm-body"><pre style="white-space:pre-wrap;font-size:12px;margin:0;">${String(manifestSummary(manifest)).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}</pre></div>
                <div class="cw-confirm-body">检测到合成清单——是否现在合成并下载？<br>确认后：聊天世界书整理为干净条目 · RubyAnalyzer 方案写入 · 下载 v3 角色卡 JSON。</div>
                <div class="cw-confirm-actions">
                    <button class="cw-btn cw-btn-green" data-choice="build">📦 现在下载</button>
                    <button class="cw-btn cw-btn-outline" data-choice="chat">💬 再改改</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const done = (choice) => {
            overlay.remove();
            document.removeEventListener('keydown', onKey);
            resolve(choice);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') done('chat');
        };
        document.addEventListener('keydown', onKey);
        overlay.querySelector('[data-choice="build"]')?.addEventListener('click', () => done('build'));
        overlay.querySelector('[data-choice="chat"]')?.addEventListener('click', () => done('chat'));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) done('chat');
        });
    });
}

/** 由记录条目构建 v3 卡条目（与 build-card.js 的 v3 形状一致）；引用既有条目时未覆盖字段沿用来源现状 */
function buildCardEntry(index, mEntry) {
    const positionStr = mEntry.位置 === 'D0' ? 'at_depth' : (mEntry.位置 === '角色后' ? 'after_char' : 'before_char');
    const light = mEntry.灯位 === '蓝灯';
    const disabled = mEntry.灯位 === '关闭' || mEntry.启用 === false;
    const keys = [...new Set([mEntry.条目名, ...(mEntry.关键词 || [])])].filter(Boolean);
    const depth = typeof mEntry.深度 === 'number' ? mEntry.深度 : (mEntry.位置 === 'D0' ? 0 : 4);
    const src = mEntry._source || null;
    const ROLE_MAP = { system: 0, user: 1, assistant: 2 };
    const role = typeof mEntry.角色 === 'number' ? mEntry.角色
        : (ROLE_MAP[mEntry.角色] ?? (src && typeof src.role === 'number' ? src.role : 0));
    const selective = src ? (mEntry._hasExplicitSec || !!src.selective) : true;
    return {
        id: index,
        keys,
        secondary_keys: (mEntry.副关键词 || []).filter(Boolean),
        comment: mEntry.条目名,
        content: mEntry._content,
        constant: light,
        selective,
        use_regex: true,
        enabled: !disabled,
        position: positionStr,
        insertion_order: typeof mEntry.顺序 === 'number' ? mEntry.顺序 : 100,
        extensions: {
            position: POS_MAP[mEntry.位置 || '角色前'] ?? 0,
            exclude_recursion: src ? !!src.excludeRecursion : true,
            display_index: index,
            probability: src && typeof src.probability === 'number' ? src.probability : 100,
            useProbability: src ? !!src.useProbability : true,
            depth,
            selectiveLogic: src && typeof src.selectiveLogic === 'number' ? src.selectiveLogic : 0,
            prevent_recursion: src ? !!src.preventRecursion : true,
            delay_until_recursion: src ? !!src.delayUntilRecursion : false,
            role,
            vectorized: src ? !!src.vectorized : false,
        },
    };
}

/** 由 manifest.分析任务 构建 RubyAnalyzer preset */
function buildRubyAnalyzer(manifest) {
    const tasksSrc = manifest.分析任务 || [];
    const pool = [];
    const poolVarOf = new Map();
    for (const t of tasksSrc) {
        for (const ref of (t.参考条目 || [])) {
            if (!poolVarOf.has(ref)) {
                poolVarOf.set(ref, `ref_item_${pool.length}${Math.random().toString(36).slice(2, 5)}`);
                pool.push({ entryKey: ref, varName: poolVarOf.get(ref), label: ref });
            }
        }
    }
    const tasks = tasksSrc.map((t, i) => {
        const id = i + 1;
        const refs = [...(t.参考条目 || []).map((r) => poolVarOf.get(r)).filter(Boolean), 'constraintLibrary'];
        return {
            id,
            displayName: String(t.任务名 || `任务${id}`),
            triggerFloors: [],
            cyclePositions: [typeof t.周期位置 === 'number' ? t.周期位置 : (i + 1) * 2],
            promptKey: String(t.提示词条目名 || ''),
            outputKey: String(t.输出条目名 || `${t.任务名}输出`),
            extraKeys: String((t.捕捉关键词 || [])[0] || ''),
            outputVarName: `task_${id}_Output`,
            enableJailbreak: true,
            outputConstant: false,
            outputDisable: 0,
            selective: false,
            selectiveKeysEnabled: false,
            selectiveKeys: [],
            noRecursion: false,
            position: 1,
            depth: 4,
            order: 9 + id,
            useReferences: refs,
            useOutputs: [`task_${id}_Output`],
            keywordScanEnabled: (t.捕捉关键词 || []).length > 0,
            keywordScanKeywords: (t.捕捉关键词 || []).map(String),
            characters: [],
            enabled: true,
        };
    });
    return {
        charName: String(manifest.卡名 || ''),
        summaryProvider: null,
        yuzukiIncludePlot: false,
        activePresetId: 'preset_generated_1',
        jailbreak: null,
        gen: null,
        customContentTags: null,
        presets: [{
            id: 'preset_generated_1',
            name: '方案一',
            tasks,
            referencePool: pool,
            startupTask: {
                enabled: false,
                displayName: '开局分析',
                triggerFloors: [1, 2],
                cyclePositions: [1, 2],
                promptKey: '',
                outputKey: '',
                extraKeys: '',
                outputVarName: 'startupOutput',
                enableJailbreak: true,
                outputConstant: false,
                outputDisable: 0,
                selective: false,
                selectiveKeysEnabled: false,
                selectiveKeys: [],
                noRecursion: false,
                position: 0,
                depth: 4,
                order: 100,
                useReferences: [],
                useOutputs: [],
                keywordScanEnabled: false,
                keywordScanKeywords: [],
                characters: [],
            },
            director: {
                enabled: false,
                displayName: '导演模式',
                cycleLength: 2,
                aggressive: true,
                minSpacing: 0,
                retryLimit: 2,
                planKey: 'ruby导演计划',
                useReferences: [],
            },
        }],
    };
}

/** 下载文本文件 */
function downloadJson(fileName, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * 合成角色卡：按 manifest 把记录整理为成品。
 * ① 聊天世界书 → 干净条目（正规名称/关键词/位置/灯位），未引用的记录与过程条目清除
 * ② RubyAnalyzer preset 按分析任务生成
 * ③ 下载 v3 角色 JSON
 */
async function buildCharacterCardFromManifest(manifest) {
    const book = await ensureDraftBook();
    const data = await loadBookData(book);
    const records = collectRecords(data.entries);
    const recordOf = (ref) => {
        const m = String(ref || '').match(/^([^_]+)_(.+)$/);
        if (!m) return null;
        const key = `${RECORD_PREFIX}${m[1]}_${m[2]}`;
        const rec = records.find((r) => r.key === key);
        return rec ? findEntryIn(data.entries, key) : null;
    };
    const contentOf = (entry) => String(entry?.content || '').replace(/```yaml[ \t]*\r?\n?/g, '').replace(/```[ \t]*\r?\n?/g, '').trim();

    // ---- 既有条目引用：主世界书 / 聊天世界书 的 "书:uid"（对象或字符串形式） ----
    let charBookName = '';
    try { charBookName = String(await st('/getcharbook')).trim(); } catch { /* 无主世界书 */ }
    const extBooks = { 主世界书: null, 聊天世界书: data };
    if (charBookName) {
        try { extBooks.主世界书 = await loadBookData(charBookName); } catch { /* 主世界书不可读 */ }
    }
    const parseBookRef = (ref) => {
        if (ref && typeof ref === 'object' && ref.uid != null) {
            const scope = String(ref.书 || ref.book || ref.source || '');
            if (/主|char/i.test(scope)) return { scope: '主世界书', uid: parseInt(ref.uid, 10) };
            if (/聊天|chat/i.test(scope)) return { scope: '聊天世界书', uid: parseInt(ref.uid, 10) };
            return null;
        }
        const m = String(ref || '').match(/^(主世界书|聊天世界书)\s*[:：]\s*#?(\d+)\s*$/);
        return m ? { scope: m[1], uid: parseInt(m[2], 10) } : null;
    };
    const bookEntryOf = (pr) => {
        const d = extBooks[pr.scope];
        const e = d?.entries?.[pr.uid];
        return e ? e : null;
    };
    /** 统一解析：记录引用 → 草稿记录内容；书:uid 引用 → 既有条目内容 + 来源数据（供默认值沿用） */
    const resolveRef = (ref) => {
        const pr = parseBookRef(ref);
        if (pr) {
            const hit = bookEntryOf(pr);
            if (!hit) return null;
            return { content: String(hit.content ?? ''), source: hit, bookRef: pr };
        }
        const rec = recordOf(ref);
        if (!rec) return null;
        return { content: contentOf(rec), source: null, bookRef: null };
    };
    const refDisplay = (ref) => {
        if (ref && typeof ref === 'object') return `${ref.书 || '书'}:${ref.uid}`;
        return String(ref ?? '');
    };
    const resolveInto = (holder, refField, required = false) => {
        const ref = refField ? holder[refField] : (holder.uid != null ? { 书: holder.书, uid: holder.uid } : holder.记录);
        if (ref == null || ref === '') {
            if (required) missing.push(`${refField || '条目'}未指定来源`);
            return !required;
        }
        const r = resolveRef(ref);
        if (!r) { missing.push(refDisplay(ref)); return false; }
        holder._content = r.content;
        holder._source = r.source;
        holder._bookRef = r.bookRef;
        return true;
    };

    // 引用解析 + 缺失检查（条目 / 分析任务 / 角色描述来源 / 开场白来源）
    const missing = [];
    for (const mEntry of (manifest.条目 || [])) resolveInto(mEntry, null, true);
    for (const t of (manifest.分析任务 || [])) resolveInto(t, '记录', true);
    resolveInto(manifest, '角色描述来源');
    const description = manifest._content || '';
    manifest._content = undefined;
    resolveInto(manifest, '开场白来源');
    const first_mes = manifest._content || '';
    manifest._content = undefined;
    if (missing.length) throw new Error(`清单引用了不存在的条目：${[...new Set(missing)].join('、')}（记录编号请对照编号知识，uid 引用请对照世界书现状）`);

    // 既有条目默认值：清单省略的字段沿用来源条目现状（位置/顺序/深度/灯位/关键词等）
    const keysOf = (src) => (Array.isArray(src?.key) ? src.key.map(String).filter(Boolean) : []);
    for (const mEntry of (manifest.条目 || [])) {
        const src = mEntry._source;
        if (!src) continue;
        mEntry._hasExplicitSec = Array.isArray(mEntry.副关键词) && mEntry.副关键词.length > 0;
        if (mEntry.条目名 == null) mEntry.条目名 = String(src.comment || '').trim() || keysOf(src)[0] || '未命名条目';
        if (!Array.isArray(mEntry.关键词) || mEntry.关键词.length === 0) mEntry.关键词 = keysOf(src);
        if (!Array.isArray(mEntry.副关键词)) mEntry.副关键词 = (Array.isArray(src.keysecondary) ? src.keysecondary.map(String).filter(Boolean) : []);
        if (mEntry.位置 == null) mEntry.位置 = POS_LABELS[src.position] ?? '角色前';
        if (mEntry.顺序 == null) mEntry.顺序 = typeof src.order === 'number' ? src.order : 100;
        if (mEntry.深度 == null) mEntry.深度 = typeof src.depth === 'number' ? src.depth : (mEntry.位置 === 'D0' ? 0 : 4);
        if (mEntry.灯位 == null) mEntry.灯位 = src.disable ? '关闭' : (src.constant ? '蓝灯' : '绿灯');
        if (mEntry.启用 == null) mEntry.启用 = !src.disable;
    }

    // 分析任务缺提示词条目时自动补挂（关闭条目，角色前 999）
    const entryNames = new Set((manifest.条目 || []).flatMap((e) => [e.条目名, ...(e.关键词 || [])]));
    for (const t of (manifest.分析任务 || [])) {
        if (t.提示词条目名 && !entryNames.has(t.提示词条目名)) {
            manifest.条目.push({
                记录: t.记录,
                条目名: t.提示词条目名,
                关键词: [t.提示词条目名],
                位置: '角色前',
                顺序: 999,
                灯位: '关闭',
                深度: 4,
                副关键词: [],
                启用: false,
                _content: t._content,
            });
            entryNames.add(t.提示词条目名);
            log(`[cardwriter] manifest: auto-appended prompt entry ${t.提示词条目名}`);
        }
    }

    // ---- 构建卡 JSON（v3，与 build-card.js 同形） ----
    const cardEntries = (manifest.条目 || []).map((e, i) => buildCardEntry(i, e));
    const cardName = String(manifest.卡名 || '角色卡');
    const extensions = {
        talkativeness: '0.5',
        fav: false,
        world: cardName,
        depth_prompt: { prompt: '', depth: 4, role: 'system' },
        regex_scripts: [],
        RubyAnalyzer: buildRubyAnalyzer(manifest),
    };
    const cardData = {
        name: cardName,
        description,
        personality: '',
        scenario: '',
        first_mes,
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        tags: [],
        creator: '',
        character_version: '1.0',
        alternate_greetings: [],
        extensions,
        group_only_greetings: [],
        character_book: { entries: cardEntries, name: cardName },
    };
    const card = {
        name: cardName,
        description,
        personality: '',
        scenario: '',
        first_mes,
        mes_example: '',
        creatorcomment: '',
        avatar: 'none',
        talkativeness: '0.5',
        fav: false,
        tags: [],
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: cardData,
        create_date: new Date().toISOString(),
    };

    // ---- 重写聊天世界书：引用的记录/聊天书条目转干净条目，其余 RUBY 条目清除 ----
    const referencedKeys = new Set();
    const chatRefByUid = new Map();
    for (const mEntry of (manifest.条目 || [])) {
        if (mEntry._bookRef) {
            if (mEntry._bookRef.scope === '聊天世界书') chatRefByUid.set(mEntry._bookRef.uid, mEntry);
        } else if (mEntry.记录) {
            referencedKeys.add(`${RECORD_PREFIX}${mEntry.记录}`);
        }
    }
    for (const [uid, e] of Object.entries(data.entries)) {
        const primary = String(Array.isArray(e?.key) ? e.key[0] : '');
        const isRuby = primary === RULES_KEY || primary === PERSONA_KEY || primary === APPENDIX_KEY || primary === HOLD_KEY ||
            primary === ROADMAP_KEY || primary === REGISTRY_KEY || primary === INVENTORY_KEY ||
            primary.startsWith(STEP_PREFIX) || primary.startsWith(RECORD_PREFIX) || primary.startsWith(LEGACY_DRAFT_PREFIX);
        if (!isRuby) continue;
        if (!referencedKeys.has(primary) && !chatRefByUid.has(parseInt(uid, 10))) {
            delete data.entries[uid];
        }
    }
    (manifest.条目 || []).forEach((mEntry) => {
        let e = null;
        if (mEntry._bookRef) {
            if (mEntry._bookRef.scope !== '聊天世界书') return; // 主世界书条目不动原书，只进卡JSON
            e = data.entries[mEntry._bookRef.uid];
        } else if (mEntry.记录) {
            e = findEntryIn(data.entries, `${RECORD_PREFIX}${mEntry.记录}`);
        }
        if (!e) return;
        const disabled = mEntry.灯位 === '关闭' || mEntry.启用 === false;
        Object.assign(e, {
            key: [...new Set([mEntry.条目名, ...(mEntry.关键词 || [])])].filter(Boolean),
            comment: mEntry.条目名,
            content: mEntry._content,
            position: POS_MAP[mEntry.位置 || '角色前'] ?? 0,
            depth: typeof mEntry.深度 === 'number' ? mEntry.深度 : (mEntry.位置 === 'D0' ? 0 : 4),
            order: typeof mEntry.顺序 === 'number' ? mEntry.顺序 : 100,
            constant: mEntry.灯位 === '蓝灯',
            disable: disabled,
            excludeRecursion: mEntry._source ? !!mEntry._source.excludeRecursion : true,
            preventRecursion: mEntry._source ? !!mEntry._source.preventRecursion : true,
        });
        if (mEntry.位置 === 'D0' && typeof mEntry.角色 === 'number') e.role = mEntry.角色;
    });
    await saveBook(book, data);
    reloadEditorIfShowing(book);

    // ---- 下载 JSON ----
    downloadJson(`${sanitizeDownloadName(cardName)}.json`, JSON.stringify(card, null, 4));

    const entryCount = (manifest.条目 || []).length;
    const taskCount = (manifest.分析任务 || []).length;
    log(`[cardwriter] card composed: ${cardName} | entries=${entryCount} | tasks=${taskCount}`);
    return { cardName, entryCount, taskCount };
}

// ---------- 合成清单补扫（历史楼层） ----------

function manifestWatermark() {
    const v = readProgress()?.manifestPrompted;
    return typeof v === 'number' ? v : -1;
}

function findLatestManifestInChat(chat, fromIndex = 0, { includeUser = false } = {}) {
    for (let i = chat.length - 1; i >= fromIndex; i--) {
        const m = chat[i];
        if (m?.is_user !== false && !(includeUser && m?.is_user === true)) continue;
        const manifest = extractManifest(String(m.mes || ''));
        if (manifest) return { manifest, index: i };
    }
    return null;
}

async function promptManifestChoice(manifest, stepId, messageIndex) {
    try { await writeProgress({ manifestPrompted: messageIndex }); } catch { /* ignore */ }
    try {
        const choice = await showBuildConfirm(manifest);
        if (choice !== 'build') {
            state.lastAction = `${stepId} 检测到合成清单 → 创作者选择再改改`;
            return null;
        }
        const result = await buildCharacterCardFromManifest(manifest);
        Object.assign(state, {
            active: false,
            stepId: null,
            lastStepId: null,
            lastHandledMessage: -1,
            lastAction: `合成完成 → ${result.cardName}（条目 ${result.entryCount} · 任务 ${result.taskCount}）`,
        });
        clearProgress();
        // 保留清单水位：同聊天再次开始会话/重载时，这条已合成的清单不会被补扫重弹
        try { await writeProgress({ manifestPrompted: messageIndex }); } catch { /* ignore */ }
        notify('success', `RUBY写卡：${result.cardName} 合成完成！角色卡 JSON 已开始下载，聊天世界书已整理为干净条目`, { timeOut: 8000 });
        return result;
    } catch (e) {
        state.lastError = e.message;
        warn(`[cardwriter] build failed: ${e.message}`);
        notify('error', `RUBY写卡：合成失败（第 ${messageIndex + 1} 楼的清单：${e.message}）`, { timeOut: 10000 });
        try { await writeProgress({ manifestPrompted: -1 }); } catch { /* 失败后同楼可重试 */ }
        return null;
    }
}

async function scanAndPromptManifest({ ignoreWatermark = false, includeUser = false } = {}) {
    if (!state.active || state.busy || !state.stepId) return null;
    const c = ctx();
    if (!Array.isArray(c?.chat)) return null;
    const from = ignoreWatermark ? 0 : manifestWatermark() + 1;
    const hit = findLatestManifestInChat(c.chat, from, { includeUser });
    if (!hit) return null;
    state.busy = true;
    try {
        const result = await promptManifestChoice(hit.manifest, state.stepId, hit.index);
        return result ? 'built' : 'declined';
    } finally {
        state.busy = false;
        emitState();
    }
}

export async function composeFromChat() {
    if (!state.active) return '写卡会话未激活：请先开始写卡会话（/ruby cw action=start），或让 Ruby 重新输出 <ruby合成> 清单';
    // 手动合成接受任意楼层的清单：AI 楼层（Ruby 输出）与用户楼层（创作者手动粘贴测试）均可
    const res = await scanAndPromptManifest({ ignoreWatermark: true, includeUser: true });
    if (!res) return '聊天中未找到可用的 <ruby合成> 清单（需含 ```json 围栏的完整合法 JSON——注意逗号/引号完整性）';
    return res === 'built' ? `合成完成：${state.lastAction}` : '已弹出确认，创作者选择再改改';
}

// ---------- 消息监听 ----------

async function handleGenerationEnded() {
    if (!state.active || state.busy) return;
    const c = ctx();
    const chat = c?.chat;
    if (!Array.isArray(chat)) return;

    // 批量收集未处理的 AI 楼：错过事件窗口（busy/切换竞态）的楼下次事件补处理，标记永不丢失
    const pending = [];
    for (let i = Math.max(state.lastHandledMessage + 1, 0); i < chat.length; i++) {
        if (chat[i]?.is_user === false && String(chat[i]?.mes || '').trim()) {
            pending.push({ index: i, message: chat[i] });
        }
    }
    if (pending.length === 0) return;
    state.lastHandledMessage = pending[pending.length - 1].index;

    const stepId = state.stepId;
    if (!stepId) return;
    const texts = pending.map((p) => String(p.message.mes || ''));
    const text = texts.join('\n\n');

    // 合成标记：任意步骤的 <ruby合成> JSON（逐楼扫描，跳过已询问过的楼层）→ 同楼记录先落库 → 立刻弹窗询问是否现在下载
    const watermark = manifestWatermark();
    let manifest = null;
    let manifestIdx = -1;
    for (const p of pending) {
        if (p.index <= watermark) continue;
        const m = extractManifest(String(p.message.mes || ''));
        if (m) { manifest = m; manifestIdx = p.index; break; }
    }

    // 记录阶段：捕捉 <ruby新条目>/<ruby更新条目 编号>；随后处理 <ruby切换/>（记录与切换可同楼共存；有合成标记时切换忽略）
    let records = extractRecords(text);
    const switchMark = manifest ? null : extractSwitch(text);
    if (records.length === 0 && !switchMark && !manifest) {
        state.lastAction = stepId === 'Overview'
            ? `收到回复（合成阶段未检测到 <ruby合成> 标记）`
            : `收到回复（${stepId} 无记录标记，视为讨论）`;
        emitState();
        return;
    }
    if (stepId === 'Step7' && records.length > 1) {
        warn(`[cardwriter] Step7 outputs ${records.length} records in one message, keeping the first only`);
        notify('warning', 'RUBY写卡：动态任务设计一次只允许定稿一个任务，本楼只记录了第一个');
        records = records.slice(0, 1);
    }

    state.busy = true;
    try {
        const results = [];
        for (const record of records.slice(0, 3)) {
            const r = await writeRecord(record, stepId);
            if (r) results.push(r);
        }
        if (results.length) {
            const r0 = results[0];
            const step = getStep(stepId);
            state.lastAction = `${stepId} 已${r0.action === 'new' ? '记录' : '更新'} ${r0.key}（${r0.label}）——可继续本步骤，或手动切换下一步`;
            await writeProgress({ stepId, stepName: step?.name || '' });
            notify('info', `RUBY写卡：${r0.action === 'new' ? '已记录' : '已更新'} ${r0.label}（${stepId} ${step?.name || ''}）`);
            for (const r of results) {
                window.dispatchEvent(new CustomEvent('ruby:cardwriter-draft', { detail: { stepId, key: r.key, action: r.action } }));
            }
        }

        // 合成标记：同楼记录已落库 → 立刻弹窗询问是否现在下载，确认后构建并下载
        if (manifest) {
            await promptManifestChoice(manifest, stepId, manifestIdx);
            return;
        }

        // 切换标记：创作者表示可以进入下一步（记录已先行落库）
        if (switchMark) {
            const target = switchMark.target || nextStepOf(stepId);
            if (getStep(target)?.manualOnly) {
                state.lastAction = `${stepId} 切换目标无效：${target}（特殊步骤只能手动进入）`;
                notify('warning', 'RUBY写卡：该步骤是特殊步骤，只能在面板手动进入，已忽略切换标记');
            } else if (target && getStep(target) && target !== 'Overview') {
                await applyStepSwitch(target);
            } else if (switchMark.target === 'Overview' || (!target && stepId === 'Step7')) {
                // 主链终点：引导进入合成阶段
                await applyStepSwitch('Overview');
            } else if (!target) {
                state.lastAction = `${stepId} 切换标记无效（已是主链最后一步），请手动进入合成角色卡`;
                notify('warning', 'RUBY写卡：当前已是主流程最后一步，请在写卡页手动进入「合成角色卡」');
            } else {
                state.lastAction = `${stepId} 切换目标无效：${switchMark.target}`;
                notify('warning', `RUBY写卡：切换目标无效（${switchMark.target}），已忽略`);
            }
        }
    } catch (e) {
        state.lastError = e.message;
        warn(`[cardwriter] handleGenerationEnded failed: ${e.message}`);
        notify('error', `RUBY写卡：处理记录失败（${e.message}）`);
    } finally {
        state.busy = false;
        emitState();
    }
}

// ---------- 初始化 ----------

export function initCardWriter() {
    if (initialized) return;
    initialized = true;

    const c = ctx();
    if (!c?.eventSource || !c?.eventTypes) {
        warn('[cardwriter] event system unavailable');
        return;
    }

    c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => {
        setTimeout(async () => {
            state.active = false;
            state.stepId = null;
            state.lastStepId = null;
            state.lastHandledMessage = -1;
            state.lastError = null;
            state.draftCount = 0;
            const progress = readProgress();
            if (progress?.stepId && getStep(progress.stepId)) {
                state.active = true;
                state.stepId = progress.stepId;
                state.lastStepId = progress.stepId;
                // 游标跳到当前聊天末尾：重载/切聊天不重放历史楼层（合成清单仍按水位补扫）
                const cur = ctx();
                state.lastHandledMessage = Array.isArray(cur?.chat) ? cur.chat.length - 1 : -1;
                state.lastAction = `从聊天进度恢复（${progress.stepId}）`;
                notify('info', `RUBY写卡：检测到本聊天的写卡进度（${progress.stepId}），已恢复`);
            }
            emitState();
            if (state.active) scanAndPromptManifest().catch(() => { });
        }, 400);
    });

    c.eventSource.on(c.eventTypes.GENERATION_ENDED, () => {
        setTimeout(() => { handleGenerationEnded().catch((e) => warn(`[cardwriter] ${e.message}`)); }, 800);
    });

    log('[cardwriter] v2 record engine initialized, listening to generation events');
}

export function openDraftBook() {
    try {
        $('#WIDrawerIcon')?.trigger?.('click');
        const sel = $('#world_editor_select');
        if (sel?.length) {
            const opt = sel.find('option').toArray().find((o) => o.textContent === DRAFT_BOOK);
            if (opt) {
                sel.val(opt.value).trigger('change');
                return true;
            }
            warn('[cardwriter] draft book not found in world list (is a chat open?)');
            return false;
        }
        warn('[cardwriter] world editor select not found');
        return false;
    } catch (e) {
        warn(`[cardwriter] open draft book failed: ${e.message}`);
        return false;
    }
}
