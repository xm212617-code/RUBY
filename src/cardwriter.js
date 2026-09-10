// RUBY 写卡模式：监听原生对话通道，按步骤自动管理世界书条目注入与草稿写入。
// 完全不干预生成——创作者用自己的预设/API 对话，RUBY 只监听并操作世界书。
import { ctx, st, q, log, warn } from './env.js';
import * as config from './config.js';
import { CARDWRITER_DATA } from './cardwriter-data.js';

const DRAFT_BOOK = CARDWRITER_DATA.draftBook;
const DEEP_DEPTH = 0;
const DEEP_ORDER = 999;
const GUIDE_ORDER = 500;

const RULES_KEY = 'RUBY写卡规则';
const PERSONA_KEY = 'Ruby写卡助手';
const APPENDIX_KEY = 'RUBY分析器原理附录';
const STEP_PREFIX = 'RUBY写卡';

const state = {
    enabled: false,
    active: false,          // 当前聊天是否处于写卡会话
    stepId: null,           // 当前步骤（Step0..Step8 / StepX）
    lastStepId: null,       // 上一次注入的步骤（检测切换）
    lastHandledMessage: -1, // 已处理的 AI 消息楼层，防重复
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
    return CARDWRITER_DATA.steps.map(({ id, name, optional, tool }) => ({ id, name, optional, tool }));
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
        mode: ui[uiKey()]?.mode === 'dialogue' ? 'dialogue' : 'fast',
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

// 聊天元数据存进度（每聊天独立）
function chatMetaKey() { return 'ruby_cardwriter'; }

function readProgress() {
    const c = ctx();
    const meta = c?.chatMetadata;
    const raw = meta?.[chatMetaKey()];
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
// 指令文本含 {{user}}/{{recentMessages}}/``` 等，走 /setvar 管道会触发宏替换或闭包解析；
// 因此统一用 loadWorldInfo → 改对象 → saveWorldInfo 直写，文本零损耗。
// role/position/depth/order 均为 number 字段（role: 0=system 1=user 2=assistant）。

const ROLE_SYSTEM = 0;
const POS_AT_DEPTH = 4;

function stepKey(step) {
    return `${STEP_PREFIX}_${step.id.replace('.', '_')}`;
}

async function ensureDraftBook() {
    // 优先以固定名「ruby写卡初稿」创建聊天附加世界书；名字被其他聊天占用时回退自动命名
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

/** 在已加载的 entries 里找条目；不存在则 /createentry 创建（key 为安全短标识） */
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

async function setupBaseEntries(book) {
    const c = ctx();
    const data = await c.loadWorldInfo(book);
    if (!data?.entries) throw new Error(`world book not found: ${book}`);
    const entries = data.entries;

    // 规则 + 人设：d0/999 深度常驻强调
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

    // 附录默认关闭（可手动开）
    const appendix = await ensureEntryIn(book, entries, APPENDIX_KEY);
    Object.assign(appendix, {
        content: CARDWRITER_DATA.appendix,
        comment: 'RUBY写卡·分析器原理附录（按需）',
        position: POS_AT_DEPTH, depth: 4, order: 100,
        role: ROLE_SYSTEM, constant: true, disable: true,
    });

    await saveBook(book, data);
    log('[cardwriter] base entries ready (rules/persona @ depth0 order999, appendix disabled)');
}

const HOLD_KEY = 'RUBY写卡_继续聊聊';
const ROADMAP_KEY = 'RUBY写卡_路线图';
const LEGACY_STEP_IDS = ['Step6.5'];

/** 进入某步骤时需要清除的历史步骤（条目+说明+草稿），避免世界书冗杂 */
const CLEANUP_ON_ENTER = {
    Step4: ['Step1', 'Step2'], // Step3 已整合进主角卡，灵魂/活人化草稿作废
    Step8: ['Step7'],          // 分析规划已被提示词取代
};

/** 各步骤草稿条目键 */
function draftKeyOf(stepId) {
    return stepId === 'Step6' ? 'ruby草稿_人物速览' : `ruby草稿_${stepId}`;
}

/** 从已加载的世界书数据中删除一组条目（按 key 精确匹配） */
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

/** 收集某步骤的全部关联键：注入条目、说明条目、草稿条目 */
function stepArtifactKeys(stepId) {
    const sk = `RUBY写卡_${stepId.replace('.', '_')}`;
    return [sk, `${sk}_说明`, draftKeyOf(stepId)];
}

/**
 * 内置写卡路线图（常驻注入，约300 token）：完整流程简表 + 当前位置 + 一句话指引。
 * 让 AI 每一轮都清楚整体流程、当前在哪一步、接下来做什么。
 */
function buildRoadmapContent(stepId) {
    const mainSteps = CARDWRITER_DATA.steps.filter((s) => s.id !== 'Overview' && s.id !== 'StepX');
    const overview = CARDWRITER_DATA.steps.find((s) => s.id === 'Overview');
    const lines = ['【RUBY写卡·流程路线图】（本条目由RUBY自动维护，禁止在回复中复述整个路线图）', '完整写卡流程：'];
    mainSteps.forEach((s, i) => {
        lines.push(`${i + 1}. ${s.id} ${s.name}——${s.brief}`);
    });
    lines.push(`终. ${overview.id} ${overview.name}——${overview.brief}（只能在创作者手动进入后触发）`, '');
    const cur = getStep(stepId);
    if (!cur) {
        lines.push('当前：无活跃步骤。');
    } else {
        const idx = mainSteps.findIndex((s) => s.id === stepId);
        const total = mainSteps.length;
        if (cur.id === 'Overview') {
            lines.push(`当前：收尾阶段（${overview.name}）。${overview.brief}。`);
        } else if (idx >= 0) {
            const next = mainSteps[idx + 1];
            lines.push(`当前：第${idx + 1}/${total}步——${cur.id} ${cur.name}，${cur.brief}。`);
            if (next) {
                lines.push(`下一步：${next.id} ${next.name}（${next.brief}）。本步骤完成并输出完成标记后由RUBY自动切换，你现在只需专注当前步骤。`);
            } else {
                lines.push('本步骤是主流程最后一步，完成后由创作者手动进入总览收尾。');
            }
        } else {
            lines.push(`当前：${cur.id} ${cur.name}——${cur.brief}（工具步骤，不在主流程序列中）。`);
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

async function setStepEntries(book, stepId) {
    const c = ctx();
    const data = await c.loadWorldInfo(book);
    if (!data?.entries) throw new Error(`world book not found: ${book}`);
    const entries = data.entries;

    // 切换即清除"继续聊聊"临时注入（下一阶段切换时清除）
    const holdRemoved = deleteEntriesByKeys(entries, [HOLD_KEY]);

    // 清理废弃步骤（Step6.5 已从流程移除）的遗留条目与草稿
    const legacyKeys = LEGACY_STEP_IDS.flatMap(stepArtifactKeys);
    const legacyRemoved = deleteEntriesByKeys(entries, legacyKeys);

    // 进入目标步骤时清除历史步骤工件（条目+说明+草稿），避免世界书冗杂
    let cleanupRemoved = 0;
    if (stepId && CLEANUP_ON_ENTER[stepId]) {
        const keys = CLEANUP_ON_ENTER[stepId].flatMap(stepArtifactKeys);
        cleanupRemoved = deleteEntriesByKeys(entries, keys);
    }

    // 关闭全部步骤条目（含说明条目）
    for (const s of CARDWRITER_DATA.steps) {
        const key = stepKey(s);
        for (const k of [key, `${key}_说明`]) {
            const e = findEntryIn(entries, k);
            if (e) e.disable = true;
        }
    }
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

            // 步骤说明（可开关）：紧跟指令之后
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

    // 流程路线图：常驻注入，随当前步骤刷新
    await refreshRoadmapEntry(book, entries, stepId);

    await saveBook(book, data);
    if (holdRemoved || legacyRemoved || cleanupRemoved) {
        log(`[cardwriter] cleanup on switch -> ${stepId || 'none'}: hold=${holdRemoved} legacy=${legacyRemoved} stepArtifacts=${cleanupRemoved}`);
    }

    // 验证日志：控制台核对注入状态（constant+enabled+atDepth 即会随每轮注入）
    const verify = [];
    for (const e of Object.values(data.entries)) {
        if (Array.isArray(e?.key) && e.key.some((k) => String(k).startsWith(STEP_PREFIX) || k === RULES_KEY || k === PERSONA_KEY)) {
            if (!e.disable) verify.push(`${e.key[0]}(constant=${e.constant},pos=${e.position},depth=${e.depth},role=${e.role},order=${e.order},${String(e.content || '').length}ch)`);
        }
    }
    log(`[cardwriter] step entries active: ${stepId || 'none'} | injecting: ${verify.join(' | ') || 'nothing'}`);
}

// ---------- 完成标记检测 ----------

// XML 标签 + 锚点字段双校验：标签界定完成产物范围，锚点字段防草稿误判。
// 锚点缺失或标签不存在时返回 ''（不识别），但只有一个锚点词——不过度严格。
const FINISH_MARKERS = {
    Step0: { tag: 'step0_aesthetic_summary', matchKey: '故事还原' },
    Step1: { tag: 'step1_soul_exploration', matchKey: '人生经历' },
    Step2: { tag: 'step2_living_character', matchKey: '角色核心' },
    Step3: { tag: 'character', matchKey: 'character:' },
    Step4: { tag: 'NSFW档案', matchKey: 'nsfw_profile' },
    Step5: { tag: 'step5_npc_design', matchKey: 'NPC' },
    Step6: { tag: 'step6_quickview', matchKey: '关系' },
    Step7: { tag: 'step7_analysis_plan', matchKey: '任务' },
    Step8: { tag: 'step8_analysis_prompts', matchKey: '任务' },
};

// 总览收尾标记：yaml 内含「玩家已完成」
const OVERVIEW_MARKER = /<ruby_overview>[\s\S]*?<\/ruby_overview>/;

function yamlBlocks(text) {
    return [...String(text || '').matchAll(/```yaml[ \t]*\r?\n([\s\S]*?)```/g)]
        .map((m) => m[1])
        .filter(Boolean);
}

/** 提取本步骤的完成产物，返回 '' 表示未完成（或仅是草稿展示） */
export function extractCompletion(stepId, text) {
    const s = String(text || '');

    if (stepId === 'Overview') {
        const m = s.match(OVERVIEW_MARKER);
        if (!m) return '';
        return /玩家已完成/.test(m[0]) ? m[0].trim() : '';
    }

    const marker = FINISH_MARKERS[stepId];
    if (marker) {
        // 兼容旧格式：Step5/Step6 旧版无 XML 包裹，用纯 yaml 块识别
        if ((stepId === 'Step5' || stepId === 'Step6') && !s.includes(`<${marker.tag}>`)) {
            const blocks = yamlBlocks(s);
            if (blocks.length === 0) return '';
            return blocks.map((b) => '```yaml\n' + b + '\n```').join('\n\n');
        }
        const re = new RegExp(`<${marker.tag}>[\\s\\S]*?<\\/${marker.tag}>`);
        const m = s.match(re);
        if (!m) return '';
        // 锚点字段校验：yaml 体内必须含锚点（唯一稳定核心词）
        if (!m[0].includes(marker.matchKey)) {
            log(`[cardwriter] ${stepId} completion missing anchor key "${marker.matchKey}", treating as draft`);
            return '';
        }
        return m[0].trim();
    }
    return '';
}

// ---------- 草稿写入：ruby写卡初稿 ----------

const ORDERED_STEPS = ['Step0', 'Step1', 'Step2', 'Step3', 'Step4', 'Step5', 'Step6', 'Step6.5', 'Step7', 'Step8'];

function draftOrderIndex(stepId) {
    return ORDERED_STEPS.indexOf(stepId);
}

/** 从 yaml 文本提取 character 名（Step3/Step4） */
function extractCharacterName(yamlText) {
    const m = String(yamlText || '').match(/^\s*character:\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    return '';
}

/** 提取 yaml 顶层键（NPC 名等）；冒号后接行内值或直接换行均可 */
const STRUCTURAL_KEYS = new Set(['关系', '别名', '基本', '外貌', '台词示例', '轶事', '具体行为', 'nsfw_profile', '特质', '经历', '体貌', '语料', '底线', '基准', '使用说明', '说明', 'character', 'nickname']);

function extractTopLevelKeys(yamlText) {
    const keys = [];
    for (const line of String(yamlText || '').split('\n')) {
        const m = line.match(/^([^\s#:'"][^:]{0,30}?):(?:[ \t]|$)/);
        if (m) {
            const k = m[1].trim();
            if (!STRUCTURAL_KEYS.has(k)) keys.push(k);
        }
    }
    return [...new Set(keys)];
}

/** Step8 提示词的命名特质：<角色名_分析类型> XML 输出标签 */
function extractPromptNames(yamlText) {
    const names = [];
    for (const m of String(yamlText || '').matchAll(/<([^<>\s]{1,24})_[^<>\s]{1,24}>/g)) {
        names.push(m[1]);
    }
    return [...new Set(names)];
}

/** 主角色条目排序：角色内容按顺序排在角色后（order 100+N），世界/NPC/速览在角色前（order 小） */
function draftEntrySpec(stepId, yamlText) {
    const idx = draftOrderIndex(stepId);
    const seq = idx >= 0 ? idx : 90;
    switch (stepId) {
        case 'Step0':
        case 'Step1':
        case 'Step2':
            return { key: `ruby草稿_${stepId}`, comment: `RUBY写卡草稿·${stepId}`, position: 0, order: 100 + seq, constant: false, keys: '', append: false };
        case 'Step3': {
            const name = extractCharacterName(yamlText) || '主角';
            return { key: `ruby草稿_${stepId}`, comment: `RUBY写卡草稿·${stepId} 主角卡 ${name}`, position: 0, order: 100 + seq, constant: false, keys: name, append: false };
        }
        case 'Step4': {
            const name = extractCharacterName(yamlText) || '主角';
            return { key: `ruby草稿_${stepId}`, comment: `RUBY写卡草稿·${stepId} NSFW档案 ${name}`, position: 0, order: 100 + seq, constant: false, keys: name, append: false };
        }
        case 'Step5': {
            // NPC 设定：角色前；关键词填全部 NPC 名
            const names = extractTopLevelKeys(yamlText);
            return { key: `ruby草稿_${stepId}`, comment: `RUBY写卡草稿·${stepId} NPC设定`, position: 0, order: 50, constant: false, keys: names.join(', '), append: true };
        }
        case 'Step6':
            // 人物速览：角色前，关键词"人物速览" + 人物名
            return { key: 'ruby草稿_人物速览', comment: 'RUBY写卡草稿·Step6 人物速览', position: 0, order: 40, constant: true, keys: '人物速览, ' + extractTopLevelKeys(yamlText).join(', '), append: false };
        case 'Step6.5':
            return { key: `ruby草稿_${stepId}`, comment: 'RUBY写卡草稿·Step6.5 创作交接', position: 0, order: 30, constant: false, keys: '', append: false };
        case 'Step7':
            return { key: `ruby草稿_${stepId}`, comment: 'RUBY写卡草稿·Step7 分析规划', position: 0, order: 100 + seq, constant: false, keys: '', append: false };
        case 'Step8': {
            // 分析提示词：命名特质捕捉，累积进一个关闭条目
            const names = extractPromptNames(yamlText);
            return { key: `ruby草稿_${stepId}`, comment: `RUBY写卡草稿·Step8 分析提示词（关闭条目）`, position: 0, order: 200 + seq, constant: false, keys: names.join(', '), append: true, disable: true };
        }
        default:
            return { key: `ruby草稿_${stepId}`, comment: `RUBY写卡草稿·${stepId}`, position: 0, order: 90, constant: false, keys: '', append: false };
    }
}

async function writeDraft(yamlText, stepId) {
    if (!getSettings().draftToBook) return null;
    const book = await ensureDraftBook();
    const spec = draftEntrySpec(stepId, yamlText);

    const c = ctx();
    const data = await c.loadWorldInfo(book);
    if (!data?.entries) throw new Error(`world book not found: ${book}`);
    const entries = data.entries;
    const entry = await ensureEntryIn(book, entries, spec.key);

    // 关键词合并（草稿键 + 附加键，如角色名/NPC名）
    const extraKeys = String(spec.keys || '').split(',').map((k) => k.trim()).filter(Boolean);
    entry.key = [...new Set([spec.key, ...extraKeys])];
    entry.comment = spec.comment;
    entry.content = spec.append && entry.content
        ? `${entry.content}\n\n${yamlText}`
        : yamlText;
    entry.constant = !!spec.constant;
    entry.disable = !!spec.disable;
    entry.position = spec.position;
    entry.order = spec.order;
    entry.excludeRecursion = true;
    entry.preventRecursion = true;

    await saveBook(book, data);
    state.draftCount++;
    log(`[cardwriter] draft written: ${spec.key} -> ${book} (keys: ${entry.key.join(', ')})`);
    return { ...spec, key: spec.key };
}

// ---------- 步骤切换 ----------

function nextStepOf(stepId) {
    const i = CARDWRITER_DATA.steps.findIndex((s) => s.id === stepId);
    if (i < 0 || i === CARDWRITER_DATA.steps.length - 1) return null;
    const next = CARDWRITER_DATA.steps[i + 1];
    // StepX 是工具步骤，不在自动推进链上
    if (next.tool) return null;
    return next.id;
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

// ---------- 会话管理 ----------

export async function startSession(stepId = 'Step0') {
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
        Object.assign(state, {
            active: true,
            stepId,
            lastStepId: stepId,
            lastHandledMessage: -1,
            lastError: null,
            lastAction: `会话开始 → ${stepId}`,
            draftCount: 0,
            startedAt: Date.now(),
        });
        await writeProgress({ stepId, stepName: getStep(stepId)?.name || '', finished: [], book });
        emitState();
        notify('success', `RUBY写卡会话已开始（${stepId}），规则与人设已注入聊天世界书`);
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
        const c = ctx();
        const data = await c.loadWorldInfo(book);
        if (data?.entries) {
            if (!keepDrafts) {
                // 删除草稿书中 RUBY 创建的全部条目（步骤/说明/常驻/草稿/临时注入/遗留）
                for (const [uid, e] of Object.entries(data.entries)) {
                    const k = Array.isArray(e?.key) ? e.key[0] : '';
                    if (k === RULES_KEY || k === PERSONA_KEY || k === APPENDIX_KEY || k === HOLD_KEY ||
                        k.startsWith(STEP_PREFIX) || k.startsWith('ruby草稿_')) {
                        delete data.entries[uid];
                    }
                }
            } else {
                // 只关掉步骤/规则/人设/路线图条目，草稿保留
                const offKeys = new Set([RULES_KEY, PERSONA_KEY, ROADMAP_KEY]);
                for (const s of CARDWRITER_DATA.steps) {
                    offKeys.add(stepKey(s));
                    offKeys.add(`${stepKey(s)}_说明`);
                }
                for (const e of Object.values(data.entries)) {
                    if (Array.isArray(e?.key) && e.key.some((k) => offKeys.has(k))) e.disable = true;
                }
            }
            await saveBook(book, data);
        }
        Object.assign(state, {
            active: false,
            stepId: null,
            lastStepId: null,
            lastHandledMessage: -1,
            lastAction: keepDrafts ? '会话结束（草稿保留）' : '会话结束（条目清空）',
        });
        clearProgress();
        emitState();
        notify('info', keepDrafts ? 'RUBY写卡会话已结束，草稿保留在聊天世界书' : 'RUBY写卡会话已结束，写卡条目已清空');
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

// ---------- 消息监听 ----------

function lastAiMessage() {
    const c = ctx();
    const chat = c?.chat;
    if (!Array.isArray(chat) || chat.length === 0) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i]?.is_user === false && String(chat[i]?.mes || '').trim()) {
            return { index: i, message: chat[i] };
        }
    }
    return null;
}

// ---------- 对话模式：确认弹窗与"继续聊聊"临时注入 ----------

/** 注入"继续聊聊"临时条目：告知 Ruby 创作者不满意，继续讨论直到满意才输出完整 yaml */
async function injectHoldEntry(book, stepId) {
    const c = ctx();
    const data = await c.loadWorldInfo(book);
    if (!data?.entries) throw new Error(`world book not found: ${book}`);
    const entries = data.entries;
    const step = getStep(stepId);
    const entry = await ensureEntryIn(book, entries, HOLD_KEY);
    Object.assign(entry, {
        content: [
            `【创作者反馈】创作者对当前步骤【${stepId} ${step?.name || ''}】的产出不完全满意。`,
            '要求：',
            '- 不要随意下结论，不要急着输出最终yaml总结',
            '- 继续针对当前步骤与创作者讨论、修改、完善',
            '- 直到创作者明确表示满意后，才能输出完整的yaml总结',
        ].join('\n'),
        comment: 'RUBY写卡·继续聊聊（临时注入）',
        position: POS_AT_DEPTH, depth: 1, order: 550,
        role: ROLE_SYSTEM, constant: true, disable: false,
    });
    await saveBook(book, data);
    log('[cardwriter] hold entry injected (creator wants to keep chatting)');
}

/** 对话模式确认弹窗：切换下一步 / 我还想聊聊。返回 Promise<'switch'|'chat'> */
function showStepConfirm(stepId) {
    return new Promise((resolve) => {
        const step = getStep(stepId);
        const next = nextStepOf(stepId);
        const overlay = document.createElement('div');
        overlay.id = 'ruby_cw_confirm';
        overlay.innerHTML = `
            <div class="cw-confirm-card">
                <div class="cw-confirm-title">✋ ${stepId} ${step?.name || ''} 检测到完成标记</div>
                <div class="cw-confirm-body">
                    Ruby 输出了完整的 yaml 总结。${next ? `确认后将写入草稿并切换到 <b>${next} ${getStep(next)?.name || ''}</b>。` : '确认后将写入草稿。'}
                    想继续纠正/打磨这一步，选"我还想聊聊"。
                </div>
                <div class="cw-confirm-actions">
                    <button class="cw-btn cw-btn-green" data-choice="switch">✅ 确认${next ? `，切换 ${next}` : ''}</button>
                    <button class="cw-btn cw-btn-outline" data-choice="chat">💬 我还想聊聊</button>
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
        overlay.querySelector('[data-choice="switch"]')?.addEventListener('click', () => done('switch'));
        overlay.querySelector('[data-choice="chat"]')?.addEventListener('click', () => done('chat'));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) done('chat');
        });
    });
}

// ---------- 总览收尾：最终清理 ----------

/** 总览完成：只保留 美学/角色/NSFW/分析提示词 草稿，清除其余全部 RUBY 条目 */
async function finalCleanup() {
    const book = await ensureDraftBook();
    const c = ctx();
    const data = await c.loadWorldInfo(book);
    if (!data?.entries) throw new Error(`world book not found: ${book}`);
    const entries = data.entries;

    // 保留的产出草稿：美学设定、角色设定、NSFW设定、NPC设定、人物速览、分析提示词
    const KEEP_DRAFTS = new Set(['ruby草稿_Step0', 'ruby草稿_Step3', 'ruby草稿_Step4', 'ruby草稿_Step5', 'ruby草稿_人物速览', 'ruby草稿_Step8']);
    const removedKeys = new Set();
    for (const [uid, e] of Object.entries(entries)) {
        if (!Array.isArray(e?.key)) continue;
        const k = e.key[0];
        const isRuby =
            k === RULES_KEY || k === PERSONA_KEY || k === APPENDIX_KEY || k === HOLD_KEY ||
            k.startsWith(STEP_PREFIX) || k.startsWith('ruby草稿_');
        if (isRuby && !KEEP_DRAFTS.has(k)) {
            delete entries[uid];
            removedKeys.add(k);
        }
    }
    await saveBook(book, data);
    log(`[cardwriter] final cleanup: removed ${removedKeys.size} entries (${[...removedKeys].join(', ')}), kept: ${[...KEEP_DRAFTS].filter((k) => findEntryIn(entries, k)).join(', ')}`);
    return { removed: removedKeys.size, kept: [...KEEP_DRAFTS].filter((k) => findEntryIn(entries, k)) };
}

async function handleGenerationEnded() {
    if (!state.active || state.busy) return;
    const last = lastAiMessage();
    if (!last) return;
    if (last.index <= state.lastHandledMessage) return; // 防重复（流式期间事件可能多次触发）
    state.lastHandledMessage = last.index;

    const text = String(last.message.mes || '');
    const stepId = state.stepId;
    if (!stepId) return;

    const completion = extractCompletion(stepId, text);
    if (!completion) {
        state.lastAction = `收到回复（${stepId} 未检测到完成标记）`;
        emitState();
        return;
    }

    // 总览收尾：检测到「玩家已完成」yaml → 最终清理并结束会话
    if (stepId === 'Overview') {
        state.busy = true;
        try {
            const result = await finalCleanup();
            Object.assign(state, {
                active: false,
                stepId: null,
                lastStepId: null,
                lastHandledMessage: -1,
                lastAction: `总览完成 → 已清理 ${result.removed} 个冗余条目，保留：${result.kept.join('、')}`,
            });
            clearProgress();
            notify('success', `RUBY写卡：收尾完成！已清理 ${result.removed} 个过程条目，保留美学/角色/NSFW设定与分析提示词`, { timeOut: 8000 });
        } catch (e) {
            state.lastError = e.message;
            warn(`[cardwriter] finalCleanup failed: ${e.message}`);
            notify('error', `RUBY写卡：收尾清理失败（${e.message}）`);
        } finally {
            state.busy = false;
            emitState();
        }
        return;
    }

    // 对话模式：非累积步骤检测到完成标记时，先弹确认（长期纠正 Ruby 的机会；
    // 累积型步骤 Step5/Step8 靠手动切换，天然具备纠正机会，不弹窗）
    const settings = getSettings();
    const APPEND_STEPS = new Set(['Step5', 'Step8']);
    if (settings.mode === 'dialogue' && !APPEND_STEPS.has(stepId)) {
        const choice = await showStepConfirm(stepId);
        if (choice === 'chat') {
            try {
                const book = await ensureDraftBook();
                await injectHoldEntry(book, stepId);
                state.lastAction = `${stepId} 完成标记检测到 → 创作者选择继续聊聊（已注入继续聊聊条目）`;
            } catch (e) {
                state.lastError = e.message;
                warn(`[cardwriter] injectHoldEntry failed: ${e.message}`);
            }
            emitState();
            return;
        }
    }

    state.busy = true;
    try {
        const spec = await writeDraft(completion, stepId);

        // 累积型步骤（Step5 NPC / Step8 提示词）：产物可能分多条回复，只累积不自动推进
        if (spec?.append) {
            state.lastAction = `${stepId} 产物已累积 → ${spec.key}（完成后可手动切换下一步骤）`;
            await writeProgress({ stepId, stepName: getStep(stepId)?.name || '' });
            notify('info', `RUBY写卡：${stepId} 产物已写入《${DRAFT_BOOK}》（${spec.key}）。该步骤可多次产出，完成后请手动切换下一步骤`);
        } else {
            const next = nextStepOf(stepId);
            if (next) {
                const book = await ensureDraftBook();
                await setStepEntries(book, next);
                state.stepId = next;
                state.lastStepId = next;
                state.lastAction = `${stepId} 完成 → 草稿已存 → 切换 ${next}`;
                await writeProgress({ stepId: next, stepName: getStep(next)?.name || '' });
                notify('success', `RUBY写卡：${stepId} 完成，草稿已写入《${DRAFT_BOOK}》，已切换到 ${next}`);
            } else {
                // 链条结束：保留草稿，停止步骤注入
                const book = await ensureDraftBook();
                await setStepEntries(book, null);
                state.stepId = null;
                state.lastAction = `${stepId} 完成 → 草稿已存 → 写卡流程完成（可手动进入总览收尾）`;
                await writeProgress({ stepId: null, done: true });
                notify('success', `RUBY写卡：${stepId} 完成，全部草稿已写入《${DRAFT_BOOK}》。写卡流程完成，可在写卡页手动进入「总览」收尾`, { timeOut: 7000 });
            }
        }
        if (spec) {
            window.dispatchEvent(new CustomEvent('ruby:cardwriter-draft', { detail: { stepId, key: spec.key } }));
        }
    } catch (e) {
        state.lastError = e.message;
        warn(`[cardwriter] handleGenerationEnded failed: ${e.message}`);
        notify('error', `RUBY写卡：处理完成标记失败（${e.message}）`);
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
            // 从聊天元数据恢复进度（此聊天曾开启过写卡会话即恢复；未知步骤视为遗留不恢复）
            const progress = readProgress();
            if (progress?.stepId && getStep(progress.stepId)) {
                state.active = true;
                state.stepId = progress.stepId;
                state.lastStepId = progress.stepId;
                state.lastAction = `从聊天进度恢复（${progress.stepId}）`;
                notify('info', `RUBY写卡：检测到本聊天的写卡进度（${progress.stepId}），已恢复`);
            }
            emitState();
        }, 400);
    });

    c.eventSource.on(c.eventTypes.GENERATION_ENDED, () => {
        setTimeout(() => { handleGenerationEnded().catch((e) => warn(`[cardwriter] ${e.message}`)); }, 800);
    });

    log('[cardwriter] initialized, listening to generation events');
}

export function openDraftBook() {
    try {
        // 与酒馆导入内嵌书同款方式：打开世界书抽屉并选中草稿书（不改变任何激活状态）
        $('#WIDrawerIcon')?.trigger?.('click');
        const sel = $('#world_editor_select');
        if (sel?.length) {
            sel.val(DRAFT_BOOK).trigger('change');
            return true;
        }
        warn('[cardwriter] world editor select not found');
        return false;
    } catch (e) {
        warn(`[cardwriter] open draft book failed: ${e.message}`);
        return false;
    }
}
