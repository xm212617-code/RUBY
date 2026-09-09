// RUBY 写卡模式：监听原生对话通道，按步骤自动管理世界书条目注入与草稿写入。
// 完全不干预生成——创作者用自己的预设/API 对话，RUBY 只监听并操作世界书。
import { ctx, st, q, log, warn } from './env.js';
import * as config from './config.js';
import { CARDWRITER_DATA } from './cardwriter-data.js';
import * as worldbook from './worldbook.js';

const DRAFT_BOOK = CARDWRITER_DATA.draftBook;
const DEEP_ROLE = 'system';
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

export function isEnabled() {
    return !!config.getUi()?.[uiKey()]?.enabled;
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

// ---------- 世界书条目操作（走酒馆原生通道） ----------

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

/** 在聊天附加世界书中查找/创建条目，返回 uid */
async function ensureEntry(book, key, comment) {
    const found = await worldbook.findEntryPublic(book, key);
    if (found) return found.uid;
    const uidRaw = await st(`/createentry file=${q(book)} key=${q(key)} ""`);
    const uid = parseInt(uidRaw, 10);
    if (isNaN(uid)) throw new Error(`create entry failed: ${key}`);
    await st(`/setentryfield file=${q(book)} uid=${uid} field=comment ${q(comment || key)}`);
    log(`[cardwriter] entry created: ${key}`);
    return uid;
}

async function setEntryContent(book, uid, content) {
    const varName = `_ruby_cw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await st(`/setvar key=${varName} ${q(String(content || '').trim())}`);
    await st(`/getvar ${varName} | /setentryfield file=${q(book)} uid=${uid} field=content`);
}

async function setEntryEnabled(book, uid, enabled) {
    await st(`/setentryfield file=${q(book)} uid=${uid} field=disable ${enabled ? 0 : 1}`);
}

async function setupBaseEntries(book) {
    // 规则 + 人设 + 附录：d0/999 深度常驻强调
    const rules = await ensureEntry(book, RULES_KEY, 'RUBY写卡·步骤规则（常驻）');
    await setEntryContent(book, rules, CARDWRITER_DATA.rules);
    await st(`/setentryfield file=${q(book)} uid=${rules} field=position 4`);
    await st(`/setentryfield file=${q(book)} uid=${rules} field=depth ${DEEP_DEPTH}`);
    await st(`/setentryfield file=${q(book)} uid=${rules} field=order ${DEEP_ORDER}`);
    await st(`/setentryfield file=${q(book)} uid=${rules} field=role ${DEEP_ROLE}`);
    await st(`/setentryfield file=${q(book)} uid=${rules} field=constant 1`);
    await st(`/setentryfield file=${q(book)} uid=${rules} field=disable 0`);

    const persona = await ensureEntry(book, PERSONA_KEY, 'RUBY写卡·人设（常驻）');
    await setEntryContent(book, persona, CARDWRITER_DATA.persona);
    await st(`/setentryfield file=${q(book)} uid=${persona} field=position 4`);
    await st(`/setentryfield file=${q(book)} uid=${persona} field=depth ${DEEP_DEPTH}`);
    await st(`/setentryfield file=${q(book)} uid=${persona} field=order ${DEEP_ORDER - 1}`);
    await st(`/setentryfield file=${q(book)} uid=${persona} field=role ${DEEP_ROLE}`);
    await st(`/setentryfield file=${q(book)} uid=${persona} field=constant 1`);
    await st(`/setentryfield file=${q(book)} uid=${persona} field=disable 0`);

    // 附录默认关闭（可手动开）
    const appendix = await ensureEntry(book, APPENDIX_KEY, 'RUBY写卡·分析器原理附录（按需）');
    await setEntryContent(book, appendix, CARDWRITER_DATA.appendix);
    await st(`/setentryfield file=${q(book)} uid=${appendix} field=position 4`);
    await st(`/setentryfield file=${q(book)} uid=${appendix} field=depth 1`);
    await st(`/setentryfield file=${q(book)} uid=${appendix} field=order 100`);
    await st(`/setentryfield file=${q(book)} uid=${appendix} field=constant 1`);
    await st(`/setentryfield file=${q(book)} uid=${appendix} field=disable 1`);
    log('[cardwriter] base entries ready (rules/persona @ depth0 order999, appendix disabled)');
}

async function setStepEntries(book, stepId) {
    // 关闭全部步骤条目（含说明条目）
    for (const s of CARDWRITER_DATA.steps) {
        const key = stepKey(s);
        for (const k of [key, `${key}_说明`]) {
            const found = await worldbook.findEntryPublic(book, k);
            if (found) await setEntryEnabled(book, found.uid, false);
        }
    }
    if (!stepId) return;
    const step = getStep(stepId);
    if (!step) return;

    const key = stepKey(step);
    const uid = await ensureEntry(book, key, `RUBY写卡·${step.id} ${step.name}`);
    await setEntryContent(book, uid, step.instruction);
    await st(`/setentryfield file=${q(book)} uid=${uid} field=position 4`);
    await st(`/setentryfield file=${q(book)} uid=${uid} field=depth 1`);
    await st(`/setentryfield file=${q(book)} uid=${uid} field=order 600`);
    await st(`/setentryfield file=${q(book)} uid=${uid} field=role ${DEEP_ROLE}`);
    await st(`/setentryfield file=${q(book)} uid=${uid} field=constant 1`);
    await setEntryEnabled(book, uid, true);

    // 步骤说明（可开关）：紧跟指令之后
    if (getSettings().showGuide && step.guide) {
        const gKey = `${key}_说明`;
        const gUid = await ensureEntry(book, gKey, `RUBY写卡·${step.id} 说明（气泡同步）`);
        await setEntryContent(book, gUid, step.guide);
        await st(`/setentryfield file=${q(book)} uid=${gUid} field=position 4`);
        await st(`/setentryfield file=${q(book)} uid=${gUid} field=depth 1`);
        await st(`/setentryfield file=${q(book)} uid=${gUid} field=order ${GUIDE_ORDER}`);
        await st(`/setentryfield file=${q(book)} uid=${gUid} field=role ${DEEP_ROLE}`);
        await st(`/setentryfield file=${q(book)} uid=${gUid} field=constant 1`);
        await setEntryEnabled(book, gUid, true);
    }
    log(`[cardwriter] step entries active: ${step.id} ${step.name}`);
}

// ---------- 完成标记检测 ----------

const FINISH_MARKERS = {
    Step0: /<step0_aesthetic_summary>[\s\S]*?```yaml[\s\S]*?```[\s\S]*?<\/step0_aesthetic_summary>/,
    Step1: /<step1_soul_exploration>[\s\S]*?```yaml[\s\S]*?```[\s\S]*?<\/step1_soul_exploration>/,
    Step2: /<step2_living_character>[\s\S]*?```yaml[\s\S]*?```[\s\S]*?<\/step2_living_character>/,
    Step3: /<character>\s*```yaml[\s\S]*?```[\s\S]*?<\/character>/,
    Step4: /<NSFW档案>\s*```yaml[\s\S]*?```[\s\S]*?<\/NSFW档案>/,
};

// 无 XML 包裹、以 ```yaml 代码块为完成标记的步骤
const PLAIN_YAML_STEPS = new Set(['Step5', 'Step6', 'Step6.5']);

/** 提取本步骤的完成产物，返回 '' 表示未完成 */
export function extractCompletion(stepId, text) {
    const s = String(text || '');
    const re = FINISH_MARKERS[stepId];
    if (re) {
        const m = s.match(re);
        return m ? m[0].trim() : '';
    }
    if (PLAIN_YAML_STEPS.has(stepId)) {
        const blocks = [...s.matchAll(/```yaml[ \t]*\r?\n([\s\S]*?)```/g)].map((m) => m[1].trim()).filter(Boolean);
        if (blocks.length === 0) return '';
        return blocks.map((b) => '```yaml\n' + b + '\n```').join('\n\n');
    }
    if (stepId === 'Step8') {
        // 分析提示词特征：任务声明 + 双阶段结构/XML输出标签
        const hasTask = /任务\s*[:：]/.test(s);
        const hasTrait = /(输出边界声明|第一阶段_思考链|<[^<>\s]{1,24}_[^<>\s]{1,24}>)/.test(s);
        return (hasTask && hasTrait) ? s.trim() : '';
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

    let content = yamlText;
    let extraKeys = spec.keys || '';
    if (spec.append) {
        // 累积型条目（NPC/提示词）：合并已有内容与关键词
        const found = await worldbook.findEntryPublic(book, spec.key);
        if (found?.entry?.content) {
            content = `${found.entry.content}\n\n${yamlText}`;
            const prevKeys = worldbook.extractEntryKeywords(found.entry).join(', ');
            if (prevKeys) extraKeys = [...new Set([...prevKeys.split(', ').map((k) => k.trim()).filter(Boolean), ...extraKeys.split(', ').map((k) => k.trim()).filter(Boolean)])].join(', ');
        }
    }

    await worldbook.writeOutputEntry(book, {
        key: spec.key,
        comment: spec.comment,
        extraKeys,
        content,
        constant: !!spec.constant,
        disable: !!spec.disable,
        noRecursion: true,
        position: spec.position,
        order: spec.order,
    });
    await worldbook.persistBook(book);
    state.draftCount++;
    log(`[cardwriter] draft written: ${spec.key} -> ${book}`);
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
        if (!keepDrafts) {
            // 删除草稿书中 RUBY 创建的条目（步骤/说明/常驻/草稿）
            const book = await ensureDraftBook();
            const deleteKeys = [];
            for (const s of CARDWRITER_DATA.steps) {
                deleteKeys.push(stepKey(s), `${stepKey(s)}_说明`, `ruby草稿_${s.id}`);
            }
            deleteKeys.push('ruby草稿_人物速览', RULES_KEY, PERSONA_KEY, APPENDIX_KEY);
            for (const key of [...new Set(deleteKeys)]) {
                const found = await worldbook.findEntryPublic(book, key);
                if (found) await st(`/deleteentry file=${q(book)} uid=${found.uid}`);
            }
            await worldbook.persistBook(book);
        } else {
            // 只关掉步骤/规则条目，草稿保留
            const book = await ensureDraftBook();
            await setStepEntries(book, null);
            for (const key of [RULES_KEY, PERSONA_KEY]) {
                const found = await worldbook.findEntryPublic(book, key);
                if (found) await setEntryEnabled(book, found.uid, false);
            }
            await worldbook.persistBook(book);
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

async function handleGenerationEnded() {
    if (!state.active || state.busy) return;
    const last = lastAiMessage();
    if (!last) return;
    if (last.index <= state.lastHandledMessage) return; // 防重复（流式期间事件可能多次触发）
    state.lastHandledMessage = last.index;

    const text = String(last.message.mes || '');
    const stepId = state.stepId;
    if (!stepId) return;

    // 步骤被手动切换后（lastStepId 与 stepId 不同步由 switchStep 维护，这里只处理当前）
    const completion = extractCompletion(stepId, text);
    if (!completion) {
        state.lastAction = `收到回复（${stepId} 未检测到完成标记）`;
        emitState();
        return;
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
                state.lastAction = `${stepId} 完成 → 草稿已存 → 写卡流程完成`;
                await writeProgress({ stepId: null, done: true });
                notify('success', `RUBY写卡：${stepId} 完成，全部草稿已写入《${DRAFT_BOOK}》，写卡流程完成`);
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
            // 从聊天元数据恢复进度
            const progress = readProgress();
            if (progress?.stepId && isEnabled()) {
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
