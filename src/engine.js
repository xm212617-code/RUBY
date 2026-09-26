import { ctx, log, warn } from './env.js';
import * as config from './config.js';
import * as scheduler from './scheduler.js';
import * as reader from './reader.js';
import * as worldbook from './worldbook.js';
import * as ai from './ai.js';
import * as director from './director.js';
import { BUILTIN_REFERENCES } from './builtin-refs.js';
import { buildMessages } from './jailbreak.js';

const state = {
    armed: false,
    running: false,
    needTick: false,
    layer: 'unavailable',
    identity: null,
    cycleLength: 0,
    baseline: 0,
    triggered: new Set(),
    aiSnapshot: [],
    lastError: null,
    lastRunAt: null,
    lastRunSummary: '',
};

const listeners = new Set();
let initialized = false;
let tickTimer = null;
const TICK_DELAY_MS = 1200;

export function onStateChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function emitState() {
    for (const fn of listeners) {
        try { fn(getEngineState()); } catch { /* ignore listener errors */ }
    }
}

/** 导演模式状态快照（面板/状态命令用）：轮次、位置、计划就绪与覆盖数、上次运行结果 */
function directorStateSnapshot() {
    try {
        const c = ctx();
        if (!c) return { enabled: false };
        const { data, layer } = config.resolveConfig();
        if (layer !== 'character') return { enabled: false };
        const dirCfg = config.getActivePreset(data).director;
        if (!dirCfg?.enabled) return { enabled: false };
        const aiCount = reader.countAiReplies(c.chat);
        const meta = readDirectorMeta();
        const anchored = Number.isFinite(meta?.anchor);
        return {
            enabled: true,
            cycleLength: dirCfg.cycleLength,
            minSpacing: dirCfg.minSpacing,
            round: anchored ? director.directorRound(aiCount, meta.anchor, dirCfg.cycleLength) : 0,
            position: anchored ? director.directorPosition(aiCount, meta.anchor, dirCfg.cycleLength) : 0,
            planReady: !!(meta?.plan && meta.plan.round === (anchored ? director.directorRound(aiCount, meta.anchor, dirCfg.cycleLength) : -1)),
            planCount: meta?.plan?.assignments?.length || 0,
            planAssignments: (meta?.plan?.assignments || []).map((a) => ({ position: a.position, taskId: a.taskId })),
            wokenCount: meta?.woken?.length || 0,
            lastRunOk: meta?.lastDirectorRun ? !!meta.lastDirectorRun.ok : null,
            lastRunReason: meta?.lastDirectorRun?.reason || '',
        };
    } catch {
        return { enabled: false };
    }
}

export function getEngineState() {
    const c = ctx();
    const aiCount = c ? reader.countAiReplies(c.chat) : 0;
    return {
        armed: state.armed,
        running: state.running,
        layer: state.layer,
        cycleLength: state.cycleLength,
        aiCount,
        position: scheduler.positionFor(aiCount, state.cycleLength),
        charName: state.identity?.name || '',
        hasCharacter: !!state.identity,
        lastError: state.lastError,
        lastRunAt: state.lastRunAt,
        lastRunSummary: state.lastRunSummary,
        director: directorStateSnapshot(),
    };
}

function notify(kind, message, options = {}) {
    if (!config.getUi().notify) return;
    const fn = window.toastr?.[kind];
    if (typeof fn === 'function') fn(message, '', { timeOut: 4000, ...options });
}

export function initEngine() {
    if (initialized) return;
    initialized = true;

    const c = ctx();
    if (!c?.eventSource || !c?.eventTypes) {
        warn('event system unavailable, engine not started');
        return;
    }

    c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => {
        setTimeout(reinit, 300);
    });
    c.eventSource.on(c.eventTypes.GENERATION_ENDED, () => {
        scheduleTick();
    });
    c.eventSource.on(c.eventTypes.MESSAGE_RECEIVED, (_messageId, type) => {
        if (type === 'first_message') scheduleTick();
    });
    c.eventSource.on(c.eventTypes.MESSAGE_DELETED, () => {
        setTimeout(() => {
            const cc = ctx();
            if (!cc) return;
            handleMessagesDeleted(cc);
        }, 300);
    });

    setTimeout(reinit, 1500);
    log('engine initialized, listening to chat events');
}

export function reinit() {
    const c = ctx();
    if (!c) return;
    state.aiSnapshot = (c.chat || []).filter(reader.isAiReplyMsg);
    state.triggered.clear();
    state.lastError = null;

    state.identity = config.getCharacterIdentity();
    if (!state.identity) {
        state.armed = false;
        state.layer = 'unavailable';
        state.cycleLength = 0;
        log('no active character (or group chat), engine standby');
        emitState();
        return;
    }

    const { data, layer } = config.resolveConfig();
    state.layer = layer;
    if (layer !== 'character') {
        state.armed = false;
        state.cycleLength = 0;
        log(`engine standby: config not bound to a character card (layer=${layer}); bind via panel to arm`);
        emitState();
        return;
    }
    const preset = config.getActivePreset(data);
    const dirCfg = preset.director;
    const dirActive = !!(dirCfg?.enabled && (preset.tasks || []).some((t) => t.enabled));
    const len = scheduler.cycleLength(preset.startupTask, preset.tasks);

    // 导演模式停用时清除遗留的导演元数据（重新启用会重新锚定，符合"回复1~2后首跑"）
    if (dirCfg?.enabled !== true) {
        const ns = c.chatMetadata?.extensions?.RubyAnalyzer;
        if (ns?.director) {
            delete ns.director;
            saveDirectorMeta();
        }
    }

    if (!dirActive && len <= 0) {
        state.armed = false;
        state.cycleLength = 0;
        log(`engine standby: no enabled tasks for "${state.identity.name}" (layer=${layer})`);
        emitState();
        return;
    }

    state.cycleLength = dirActive ? dirCfg.cycleLength : len;
    state.armed = true;
    state.baseline = reader.countAiReplies(c.chat);
    log(`engine armed | character=${state.identity.name} | layer=${layer} | preset=${preset.name} | ${dirActive ? `director cycle=${dirCfg.cycleLength} minSpacing=${dirCfg.minSpacing} retry=${dirCfg.retryLimit}` : `cycle=${len}`} | AI replies=${state.baseline} | position=${scheduler.positionFor(state.baseline, state.cycleLength)}/${state.cycleLength}`);
    emitState();
}

/**
 * 消息删除后的重同步：删除使后续 AI 楼层序数整体前移，
 * 各任务书签（楼层序数）与已触发幂等键必须跟着回退，否则：
 * - 书签之后的未读楼层会跨过书签被永久跳过，删除过多时书签越界、任务永久卡死；
 * - 删除后重新生成的楼层内容位于旧书签之前且幂等键仍在，永远进不了分析素材。
 * 被删楼层通过删除前的 AI 消息对象快照按身份比对识别（swipe 为原地修改，不会误判）。
 */
function handleMessagesDeleted(cc) {
    const aiCount = reader.countAiReplies(cc.chat);
    const snapshot = state.aiSnapshot;
    const present = new Set(cc.chat.filter((m) => m && typeof m === 'object'));
    const deletedOrdinals = [];
    snapshot.forEach((m, i) => {
        if (!present.has(m)) deletedOrdinals.push(i + 1);
    });
    if (deletedOrdinals.length > snapshot.length) {
        warn('deletion diff inconsistent, skip resync');
        state.aiSnapshot = (cc.chat || []).filter(reader.isAiReplyMsg);
        return;
    }
    state.aiSnapshot = (cc.chat || []).filter(reader.isAiReplyMsg);

    if (aiCount < state.baseline) {
        state.baseline = aiCount;
        log(`baseline resynced down to ${aiCount} after message deletion`);
    }
    if (deletedOrdinals.length === 0) return;

    const len = state.cycleLength > 0 ? state.cycleLength : 1;
    const fromRound = Math.ceil(deletedOrdinals[0] / len);
    let clearedKeys = 0;
    for (const key of [...state.triggered]) {
        const round = parseInt(key.split('_')[0], 10);
        if (Number.isFinite(round) && round >= fromRound) {
            state.triggered.delete(key);
            clearedKeys++;
        }
    }
    const changed = reader.resyncBookmarksAfterDeletion(deletedOrdinals, aiCount);
    log(`deletion resync: ${deletedOrdinals.length} AI floor(s) removed (first at ordinal ${deletedOrdinals[0]}), triggered keys cleared from round ${fromRound} (${clearedKeys}), bookmarks: ${changed.length > 0 ? changed.join(', ') : 'unchanged'}`);
}

function scheduleTick() {
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = setTimeout(tick, TICK_DELAY_MS);
}

// ---------- 导演模式：聊天元数据状态（锚点/计划/历史/已触发） ----------

function readDirectorMeta() {
    const c = ctx();
    const ns = c?.chatMetadata?.extensions?.RubyAnalyzer;
    const d = ns?.director;
    return (d && typeof d === 'object') ? d : null;
}

function saveDirectorMeta() {
    const c = ctx();
    if (typeof c?.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
}

/** 取导演元数据；无锚点时以当前AI回复数锚定——启用后的下一条AI回复即周期位置1（回复1~2后首跑） */
function ensureDirectorMeta(aiCount) {
    const c = ctx();
    const ns = c?.chatMetadata?.extensions;
    if (!ns) return null;
    ns.RubyAnalyzer ||= {};
    let d = ns.RubyAnalyzer.director;
    if (!d || typeof d !== 'object' || !Number.isFinite(d.anchor)) {
        d = ns.RubyAnalyzer.director = { anchor: aiCount, plan: null, history: [], woken: [] };
        log(`director anchored at AI reply ${aiCount}: first run right after the next reply`);
        saveDirectorMeta();
    }
    d.history ||= [];
    d.woken ||= [];
    return d;
}

/** 久未触发统计：当前计划（排期前）与近5周期历史中未出现的任务，按未触发周期数降序 */
function computeOverdue(dmeta, taskList, round) {
    const lastSeen = new Map();
    const record = (r, assignments) => {
        for (const a of assignments || []) {
            const prev = lastSeen.get(a.taskId);
            if (prev === undefined || r > prev) lastSeen.set(a.taskId, r);
        }
    };
    if (dmeta?.plan?.assignments) record(dmeta.plan.round, dmeta.plan.assignments);
    for (const h of dmeta?.history || []) record(h.round, h.assignments);
    return taskList
        .map((t) => ({ id: t.id, name: t.name, cyclesAgo: lastSeen.has(t.id) ? round - lastSeen.get(t.id) : round }))
        .filter((t) => t.cyclesAgo >= 1)
        .sort((a, b) => b.cyclesAgo - a.cyclesAgo)
        .slice(0, 6);
}

/** 总结替代（普通任务与导演共用）：书签→总结边界之间的楼层换为总结文本，边界之后保持原文。
 *  只改 inc.text（分析素材），关键词扫描、楼层计数与书签均不受影响 */
function applySummaryReplacement(c, inc, providerSummary, customTags = []) {
    if (!providerSummary) return;
    const boundaryOrdinal = reader.ordinalForIndex(c.chat, providerSummary.boundary);
    if (boundaryOrdinal >= inc.startFloor) {
        const summarizedUpTo = Math.min(boundaryOrdinal, inc.endFloor);
        const sections = [];
        sections.push(`【${providerSummary.label}（第${inc.startFloor}至${summarizedUpTo}楼已总结内容的浓缩替代，作为分析素材）】\n${providerSummary.text}`);
        if (boundaryOrdinal < inc.endFloor) {
            const rawPart = reader.readFloorsRange(boundaryOrdinal + 1, inc.endFloor, customTags);
            if (rawPart.text) {
                sections.push(`【本次正文（增量，第${boundaryOrdinal + 1}楼至第${inc.endFloor}楼，共${rawPart.count}楼）】\n${rawPart.text}`);
            }
        } else {
            sections.push(`（第${inc.endFloor}楼及之前的正文已全部由上方${providerSummary.label}替代，本次无未总结新正文）`);
        }
        inc.text = sections.join('\n\n');
        inc.summaryApplied = true;
        log(`${providerSummary.label} applied: floors ${inc.startFloor}-${summarizedUpTo} replaced by summary (boundary mesId=${providerSummary.boundary}, ${providerSummary.text.length} chars)`);
    } else {
        log(`summary boundary (ordinal ${boundaryOrdinal}) before read window start ${inc.startFloor}, no replacement`);
    }
}

async function tick() {
    if (!state.armed) return;
    if (state.running) {
        state.needTick = true;
        return;
    }
    const c = ctx();
    if (!c) return;

    const aiCount = reader.countAiReplies(c.chat);
    state.aiSnapshot = (c.chat || []).filter(reader.isAiReplyMsg);
    if (aiCount <= state.baseline) return;

    const { data, layer } = config.resolveConfig();
    if (layer !== 'character') {
        state.armed = false;
        state.cycleLength = 0;
        emitState();
        return;
    }
    const preset = config.getActivePreset(data);
    const dirCfg = preset.director;
    const dirActive = !!(dirCfg?.enabled && (preset.tasks || []).some((t) => t.enabled));

    // —— 导演模式：位置1跑导演，其余位置按计划查表唤醒（静态位置配置被接管）——
    if (dirActive) {
        const L = dirCfg.cycleLength;
        const dmeta = ensureDirectorMeta(aiCount);
        if (!dmeta) return;
        const pos = director.directorPosition(aiCount, dmeta.anchor, L);
        const round = director.directorRound(aiCount, dmeta.anchor, L);
        if (pos <= 0) return;
        state.baseline = aiCount;
        state.cycleLength = L;

        const batch = [];
        if (pos === 1) {
            const idemKey = `${round}_1_director`;
            if (!state.triggered.has(idemKey)) {
                state.triggered.add(idemKey);
                batch.push({ type: 'director', config: dirCfg, displayName: dirCfg.displayName || '导演模式', triggeredAt: 1, sourceFloor: aiCount, source: 'auto' });
            }
        } else {
            const plan = dmeta.plan;
            if (!plan || plan.round !== round) {
                // 重试耗尽仍失败/计划缺失：本周期空转等下周期（书签未动不丢数据），只警告一次
                if (dmeta.planWarnedRound !== round) {
                    dmeta.planWarnedRound = round;
                    saveDirectorMeta();
                    warn(`director plan missing for round ${round} (position ${pos}) — cycle idles until next director run`);
                }
            } else {
                for (const a of plan.assignments.filter((x) => x.position === pos)) {
                    const task = preset.tasks.find((t) => t.id === a.taskId && t.enabled);
                    if (!task) continue;
                    const type = `task_${task.id}`;
                    const idemKey = `${round}_${pos}_${type}`;
                    if (state.triggered.has(idemKey)) {
                        log(`idempotent skip: ${task.displayName} (round ${round} position ${pos})`);
                        continue;
                    }
                    state.triggered.add(idemKey);
                    batch.push({ type, config: task, displayName: task.displayName || `任务#${task.id}`, triggeredAt: pos, sourceFloor: aiCount, source: 'director' });
                    dmeta.woken.push({ position: pos, taskId: task.id });
                    saveDirectorMeta();
                }
            }
        }
        emitState();
        if (batch.length === 0) return;
        log(`director trigger at AI reply ${aiCount} (round ${round} position ${pos}): ${batch.map((t) => t.displayName).join(', ')}`);
        await runPipeline(batch);
        if (state.needTick) {
            state.needTick = false;
            scheduleTick();
        }
        return;
    }

    // —— 静态周期调度（原逻辑）——
    const startupTask = preset.startupTask;
    const tasks = preset.tasks;
    const len = scheduler.cycleLength(startupTask, tasks);
    if (len !== state.cycleLength) {
        state.cycleLength = len;
        log(`cycle length updated to ${len} (config changed)`);
    }
    if (len <= 0) {
        state.armed = false;
        emitState();
        return;
    }
    const from = state.baseline + 1;

    const batch = [];
    for (let cnt = from; cnt <= aiCount; cnt++) {
        const position = scheduler.positionFor(cnt, len);
        const tasksAtPos = scheduler.collectTasksAtPosition(startupTask, tasks, position, state.identity);
        for (const t of tasksAtPos) {
            const cycleRound = Math.ceil(cnt / len);
            const idemKey = `${cycleRound}_${position}_${t.type}`;
            if (state.triggered.has(idemKey)) {
                log(`idempotent skip: ${t.displayName} (round ${cycleRound} position ${position})`);
                continue;
            }
            state.triggered.add(idemKey);
            batch.push({ ...t, sourceFloor: cnt, source: 'auto' });
        }
    }
    state.baseline = aiCount;

    if (batch.length === 0) {
        log(`floor ${aiCount}: no task due (position ${scheduler.positionFor(aiCount, len)}/${len})`);
        return;
    }

    log(`auto trigger at AI reply ${aiCount}: ${batch.map((t) => t.displayName).join(', ')}`);
    await runPipeline(batch);

    if (state.needTick) {
        state.needTick = false;
        scheduleTick();
    }
}

export async function forceRun(kind, taskId) {
    const c = ctx();
    if (!c) throw new Error('SillyTavern context unavailable');
    if (state.running) throw new Error('已有分析任务正在执行中，请稍候');

    state.identity = config.getCharacterIdentity();
    if (!state.identity) throw new Error('请先打开一个角色对话');

    const { data, layer } = config.resolveConfig();
    if (layer !== 'character') throw new Error('当前配置未绑定角色卡：请先在面板中绑定到当前角色卡');
    const preset = config.getActivePreset(data);
    const aiCount = reader.countAiReplies(c.chat);
    const len = scheduler.cycleLength(preset.startupTask, preset.tasks) || 1;

    let batch = [];
    if (kind === 'startup') {
        if (!preset.startupTask?.enabled) throw new Error('开局任务未启用');
        batch = [{
            type: 'startup',
            config: preset.startupTask,
            displayName: preset.startupTask.displayName || '开局分析',
            triggeredAt: scheduler.positionFor(aiCount, len),
            sourceFloor: aiCount,
            source: 'force',
        }];
    } else if (kind === 'task') {
        const task = preset.tasks.find((t) => t.id === taskId && t.enabled);
        if (!task) throw new Error(`未找到启用的任务 #${taskId}`);
        batch = [{
            type: `task_${task.id}`,
            config: task,
            displayName: task.displayName || `任务#${task.id}`,
            triggeredAt: scheduler.positionFor(aiCount, len),
            sourceFloor: aiCount,
            source: 'force',
        }];
    } else if (kind === 'all') {
        batch = scheduler.allEnabledTasks(preset.startupTask, preset.tasks, state.identity)
            .map((t) => ({ ...t, triggeredAt: scheduler.positionFor(aiCount, len), sourceFloor: aiCount, source: 'force' }));
        if (batch.length === 0) throw new Error('没有已启用的任务');
    } else if (kind === 'director') {
        const dirCfg = preset.director;
        if (!dirCfg?.enabled) throw new Error('导演模式未启用：请先在导演面板启用导演周期');
        if (!(preset.tasks || []).some((t) => t.enabled)) throw new Error('没有已启用的任务，导演无可调度');
        batch = [{ type: 'director', config: dirCfg, displayName: dirCfg.displayName || '导演模式', triggeredAt: 1, sourceFloor: aiCount, source: 'force' }];
    } else {
        throw new Error(`unknown forceRun kind: ${kind}`);
    }

    await runPipeline(batch);
    return `${batch.map((t) => t.displayName).join(', ')} 执行完毕`;
}

/**
 * 导演任务执行：组装高度结构化提示词（任务清单/排期规则/调度参考/正文/参考条目/输出格式），
 * 调用导演API，严格解析调度表——仅格式错乱/内容不完整按创作者设定的次数自动重试；
 * 成功后计划写入聊天元数据（tick 查表唤醒）+ 聊天世界书计划条目（保持关闭），并轮转近5周期历史。
 */
async function runDirectorTask(d, ctxObj) {
    const { cfgData, preset, charBook, chatBook, referencePool, referenceValues, providerSummary, customTags, apiCfg, genParams, chatIdAtStart, characterIdAtStart } = ctxObj;
    const c = ctx();
    const dirCfg = d.config;
    const L = dirCfg.cycleLength;
    const dmeta = ensureDirectorMeta(c ? reader.countAiReplies(c.chat) : 0);
    if (!dmeta) throw new Error('聊天元数据不可用');

    // 增量正文（导演独立书签）；手动执行时书签已推进会导致空读，重置重读
    let inc = reader.incrementalRead('director', customTags, { noWindowLimit: !!providerSummary });
    if (inc.count === 0 || !inc.text) {
        if (d.source === 'force') {
            reader.resetBookmark('director');
            inc = reader.incrementalRead('director', customTags, { noWindowLimit: !!providerSummary });
            log(`director force run: bookmark reset, re-reading ${inc.count} floors`);
        } else {
            log('director: no new floors since last run (bookmark at current), scheduling with empty context');
        }
    }
    applySummaryReplacement(c, inc, providerSummary, customTags);
    const contextText = reader.capText(inc.text).text;

    // 任务清单：id+名称必发；简介手写优先，否则从提示词条目自动提取约200字切面
    const enabledTasks = (preset.tasks || []).filter((t) => t.enabled);
    const taskList = [];
    for (const t of enabledTasks) {
        let brief = String(t.directorSummary || '').trim();
        if (!brief && t.promptKey) {
            try {
                const content = await worldbook.readEntry(charBook, chatBook, t.promptKey, true);
                brief = director.extractTaskBrief(content);
            } catch { /* 简介提取失败不阻断 */ }
        }
        taskList.push({ id: t.id, name: t.displayName || `任务#${t.id}`, priority: t.directorPriority || 0, brief });
    }

    // 导演勾选的参考条目（创作者认为对导演重要的世界书内容）
    const refSections = [];
    for (const varName of dirCfg.useReferences || []) {
        const content = referenceValues[varName];
        if (content && content !== '（未设定）') {
            const refConfig = referencePool.find((r) => r.varName === varName);
            refSections.push(`【${refConfig?.label || refConfig?.entryKey || varName}】\n${content}`);
        }
    }

    const round = director.directorRound(inc.endFloor || dmeta.anchor + 1, dmeta.anchor, L);
    const prevPlan = dmeta.plan;
    const nameOf = (taskId) => taskList.find((t) => t.id === taskId)?.name || `任务#${taskId}`;
    const lastCycle = (prevPlan && prevPlan.round === round - 1 ? prevPlan.assignments : [])
        .map((a) => ({ position: a.position, taskId: a.taskId, name: nameOf(a.taskId) }));
    const woken = (dmeta.woken || []).map((a) => ({ position: a.position, taskId: a.taskId, name: nameOf(a.taskId) }));
    const overdue = computeOverdue(dmeta, taskList, round);

    const prompt = director.buildDirectorPrompt({
        tasks: taskList,
        cycleLength: L,
        minSpacing: dirCfg.minSpacing,
        round,
        lastCycle,
        woken,
        overdue,
        contextText,
        refSections,
    });
    const messages = buildMessages('导演模式', prompt, cfgData);

    // 导演就是分析任务：apiCfg/genParams/messages 与任务循环完全一致，无任何独立通道
    notify('info', '🎬 导演排期中...', { timeOut: 4000 });
    const maxAttempts = 1 + Math.max(0, Math.round(dirCfg.retryLimit || 0));
    let parsed = null;
    let lastReason = '';
    let attempts = 0;
    while (attempts < maxAttempts) {
        attempts++;
        const result = await ai.callModel({
            apiCfg,
            genParams,
            messages,
            taskLabel: `导演模式${attempts > 1 ? `(重试${attempts - 1})` : ''}`,
        });
        parsed = director.parseDirectorSchedule(result, taskList);
        if (!parsed.retryable) break;
        lastReason = parsed.reason;
        warn(`director schedule parse failed (attempt ${attempts}/${maxAttempts}): ${lastReason}`);
    }
    if (!parsed || parsed.retryable) {
        state.lastError = `导演模式失败：${lastReason}`;
        dmeta.lastDirectorRun = { round, at: Date.now(), ok: false, reason: lastReason };
        saveDirectorMeta();
        emitState();
        notify('error', `🔴 导演模式失败：${lastReason}（已重试 ${attempts - 1} 次）。本周期无调度计划，可在导演面板手动重新执行`, { timeOut: 10000 });
        return;
    }

    // 中途切换聊天/角色则丢弃结果
    if (c.getCurrentChatId?.() !== chatIdAtStart || c.characterId !== characterIdAtStart) {
        warn('director: chat changed during generation, plan discarded');
        return;
    }

    const validated = director.validateSchedule(parsed.assignments, { cycleLength: L, minSpacing: dirCfg.minSpacing, taskList });
    for (const w of validated.warnings) warn(`director schedule: ${w}`);

    // 历史轮转：上一周期计划进历史（最多5条），新计划覆盖，本周期已触发清零
    if (prevPlan && Number.isFinite(prevPlan.round) && prevPlan.round !== round) {
        dmeta.history.unshift({ round: prevPlan.round, assignments: prevPlan.assignments });
        dmeta.history = dmeta.history.slice(0, 5);
    }
    dmeta.plan = { round, assignments: validated.assignments, createdAt: Date.now() };
    dmeta.woken = [];
    dmeta.lastDirectorRun = { round, at: Date.now(), ok: true };
    saveDirectorMeta();
    reader.saveBookmark('director', inc.endFloor);

    // 计划条目写入聊天世界书（保持关闭，仅引擎读取/排查用）
    if (chatBook && dirCfg.planKey) {
        try {
            const content = [
                `【RUBY导演计划·周期${round}】（自动生成，请保持条目关闭，仅供导演引擎读取）`,
                '位置1: 导演（本计划生成点）',
                ...validated.assignments.map((a) => `位置${a.position}: task${a.taskId} ${nameOf(a.taskId)}`),
            ].join('\n');
            await worldbook.writeOutputEntry(chatBook, { key: dirCfg.planKey, content, disable: true });
            await worldbook.persistBook(chatBook);
        } catch (e) {
            warn(`director plan entry write failed: ${e?.message || e}`);
        }
    }

    state.lastRunAt = Date.now();
    state.lastRunSummary = validated.assignments.length > 0
        ? `导演计划：${validated.assignments.length}个任务（周期${round}）`
        : `导演计划：本周期不排任务（周期${round}）`;
    notify('success', `🎬 导演计划已生成（周期${round}）：${validated.assignments.map((a) => `位置${a.position}→task${a.taskId}`).join('，') || '本周期无任务'}`, { timeOut: 8000 });
    log(`director plan ready: ${JSON.stringify(validated.assignments)}`);
    emitState();
}

export async function runPipeline(taskBatch) {
    if (!taskBatch || taskBatch.length === 0) return;

    const c = ctx();
    const chatIdAtStart = c.getCurrentChatId?.();
    const characterIdAtStart = c.characterId;

    const { data: cfgData } = config.resolveConfig();
    const preset = config.getActivePreset(cfgData);
    const startupTask = preset.startupTask;
    const tasks = preset.tasks;
    const referencePool = preset.referencePool;
    // 生成参数默认不启用：未开启时传空对象，主API沿用酒馆预设采样、自定义端点沿用服务商默认
    const genParams = cfgData.gen?.enabled === true ? cfgData.gen : {};
    const customTags = cfgData.customContentTags || [];
    const charName = cfgData.charName || c.name2 || c.characters?.[c.characterId]?.name || '角色';
    const apiCfg = config.getApiConfig();

    state.running = true;
    emitState();

    let completedCount = 0;
    let failedCount = 0;

    try {
        const charBook = await worldbook.getCharBookName();
        const chatBook = await worldbook.getChatBookName();
        if (!charBook) {
            warn('character world book not found');
            notify('warning', 'RUBY：未找到角色世界书，无法执行分析');
            return;
        }
        log(`pipeline start | char book=${charBook} | chat book=${chatBook || '无'} | tasks=${taskBatch.length}`);

        const referenceValues = {};
        for (const ref of referencePool) {
            if (!ref.entryKey || !ref.varName) continue;
            const content = await worldbook.readEntry(charBook, chatBook, ref.entryKey, true);
            referenceValues[ref.varName] = content;
            if (content) log(`reference loaded: ${ref.varName}`);
        }

        // 内置参考（约束库）：世界书同名条目优先——创作者自行创建同关键词条目即自动接管（无论是否加入参考池），读不到才用内置内容
        for (const b of BUILTIN_REFERENCES) {
            if (referenceValues[b.varName] !== undefined) continue;
            const fromWorld = await worldbook.readEntry(charBook, chatBook, b.entryKey, true);
            referenceValues[b.varName] = fromWorld || b.content;
            log(`builtin reference '${b.entryKey}': ${fromWorld ? 'using worldbook entry (user overrides builtin)' : 'using builtin content'}`);
        }

        const outputValues = {};
        if (startupTask?.outputKey) {
            outputValues.startupOutput = await worldbook.readEntry(charBook, chatBook, startupTask.outputKey, true);
        }
        for (const task of tasks) {
            if (task.outputKey) {
                const varName = task.outputVarName || `task_${task.id}_Output`;
                outputValues[varName] = await worldbook.readEntry(charBook, chatBook, task.outputKey, true);
            }
        }

        // 总结接口（小白x / SP·数据库）：已总结楼层用总结替代正文。
        // 只改变"分析素材内容"，楼层/周期/书签计算全部维持原样（countAiReplies 与书签推进不受影响）。
        const provider = cfgData.summaryProvider || '';
        let providerSummary = null; // { boundary(消息索引), text, label }
        if (provider === 'littlewhitebox') {
            const lwb = reader.getLittleWhiteBoxSummary();
            if (lwb) {
                providerSummary = {
                    boundary: lwb.boundary,
                    text: reader.renderLittleWhiteBoxSummary(lwb),
                    label: '小白x剧情总结',
                };
            } else {
                warn('LittleWhiteBox summary unavailable (not installed or no data), falling back to raw text');
            }
        } else if (provider === 'shujuku') {
            try {
                const shu = await reader.getShujukuSummary([charBook, chatBook]);
                if (shu) {
                    providerSummary = { boundary: shu.boundary, text: shu.text, label: 'SP·数据库剧情总结' };
                } else {
                    warn('shujuku summary unavailable (no processed floors or readable entries), falling back to raw text');
                }
            } catch (e) {
                warn(`shujuku summary read failed: ${e?.message || e}`);
            }
        } else if (provider === 'yuzuki') {
            try {
                const yz = reader.getYuzukiSummary(cfgData.yuzukiIncludePlot !== false);
                if (yz) {
                    providerSummary = { boundary: yz.boundary, text: yz.text, label: '柚月记忆表·剧情总结' };
                } else {
                    warn('yuzuki-Memory summary unavailable (not installed or no summary records), falling back to raw text');
                }
            } catch (e) {
                warn(`yuzuki-Memory summary read failed: ${e?.message || e}`);
            }
        } else if (provider === 'baibaibook') {
            try {
                const bbb = reader.getBaibaibookSummary();
                if (bbb) {
                    providerSummary = { boundary: bbb.boundary, text: bbb.text, label: '柏宝书·记忆快照' };
                } else {
                    warn('baibaibook summary unavailable (not installed or no snapshot), falling back to raw text');
                }
            } catch (e) {
                warn(`baibaibook summary read failed: ${e?.message || e}`);
            }
        }

        // —— 导演任务：单独执行器，不进普通任务循环 ——
        if (taskBatch.length === 1 && taskBatch[0].type === 'director') {
            await runDirectorTask(taskBatch[0], {
                cfgData, preset, charBook, chatBook, referencePool, referenceValues,
                providerSummary, customTags, apiCfg, genParams, chatIdAtStart, characterIdAtStart,
            });
            return; // finally 复位 running
        }

        for (let taskIndex = 0; taskIndex < taskBatch.length; taskIndex++) {
            const current = taskBatch[taskIndex];
            const taskConfig = current.config;
            const taskKey = current.type;
            const taskDisplayName = current.displayName;

            try {
                if (c.getCurrentChatId?.() !== chatIdAtStart || c.characterId !== characterIdAtStart) {
                    warn('chat or character changed during pipeline, aborting remaining tasks');
                    return;
                }

                log(`task ${taskIndex + 1}/${taskBatch.length}: ${taskDisplayName} (${current.source})`);

                let inc = reader.incrementalRead(taskKey, customTags, { noWindowLimit: !!providerSummary });
                log(`incremental read: floors ${inc.startFloor}-${inc.endFloor} (${inc.count} floors, ${(inc.text || '').length} chars)`);

                if (inc.count === 0 || !inc.text) {
                    if (current.source === 'force') {
                        reader.resetBookmark(taskKey);
                        inc = reader.incrementalRead(taskKey, customTags, { noWindowLimit: !!providerSummary });
                        log(`force run: bookmark reset, re-reading ${inc.count} floors`);
                        if (inc.count === 0 || !inc.text) {
                            warn(`skip ${taskDisplayName}: no readable text in chat`);
                            continue;
                        }
                    } else {
                        log(`skip ${taskDisplayName}: no new floors (bookmark at ${inc.endFloor})`);
                        continue;
                    }
                }

                // 关键词扫描作用于替换/截断前的完整增量原文：与总结机制解耦
                // （扫原始楼层而非总结浓缩文本，避免已总结楼层里的关键词被永久漏扫），
                // 同时防止截断机制吞掉最新楼层里的触发关键词。
                // 导演模式排中的任务不扫描——导演排了就跑，调度权完全在导演
                const keywordScan = (current.source === 'force' || current.source === 'director')
                    ? { run: true, keywords: [], matched: [] }
                    : scheduler.shouldRunByKeywordScan(taskConfig, inc.text);
                if (!keywordScan.run) {
                    log(`skip ${taskDisplayName}: keywords not matched in floors ${inc.startFloor}-${inc.endFloor} (${keywordScan.keywords.join(', ')}), bookmark held for rescan`);
                    continue;
                }
                if (taskConfig?.keywordScanEnabled && keywordScan.matched.length > 0) {
                    log(`keyword scan hit: ${keywordScan.matched.join(', ')}`);
                }

                applySummaryReplacement(c, inc, providerSummary, customTags);

                // 20万字符上限：只截断对话正文（保留靠前部分、抛弃后续剩余正文）。
                // 参考条目池与历史分析输出在下方组装阶段追加，从不参与此上限，绝不因截断丢失。
                const capped = reader.capText(inc.text);
                if (capped.truncated > 0) {
                    warn(`body exceeds ${reader.MAX_INPUT_CHARS} chars: ${inc.text.length} chars, discarding last ${capped.truncated} chars of chat text (references unaffected)`);
                    inc.text = capped.text;
                    inc.truncatedChars = capped.truncated;
                    notify('warning', `RUBY：${taskDisplayName} 正文超过20万字符上限，末尾 ${capped.truncated} 字符已截断抛弃`);
                }

                const promptKey = taskConfig.promptKey;
                if (!promptKey) {
                    warn(`task ${taskDisplayName}: no prompt entry configured`);
                    failedCount++;
                    continue;
                }
                let promptTemplate = await worldbook.readEntry(charBook, chatBook, promptKey, false);
                if (!promptTemplate) {
                    warn(`prompt entry not found: ${promptKey}`);
                    notify('error', `RUBY：未找到提示词条目 ${promptKey}`);
                    failedCount++;
                    continue;
                }

                const variables = {
                    CHAR_NAME: charName,
                    recentMessages: inc.text,
                };
                const useRefs = Array.isArray(taskConfig.useReferences) ? taskConfig.useReferences : [];
                for (const varName of useRefs) {
                    if (referenceValues[varName] !== undefined) variables[varName] = referenceValues[varName];
                }
                const useOutputs = Array.isArray(taskConfig.useOutputs) ? taskConfig.useOutputs : [];
                for (const varName of useOutputs) {
                    if (outputValues[varName] !== undefined) variables[varName] = outputValues[varName];
                }

                const hasRecentMessagesPlaceholder = promptTemplate.includes('{{recentMessages}}');
                const bodySections = [];
                const refSections = [];

                if (!hasRecentMessagesPlaceholder && inc.text) {
                    const truncNote = inc.truncatedChars
                        ? `\n\n（⚠️ 本次正文超过20万字符上限，末尾约 ${inc.truncatedChars} 字符已被截断抛弃，仅上方保留部分为有效分析素材）`
                        : '';
                    if (inc.summaryApplied) {
                        // 总结接口已生成带分节标题的素材（小白x总结 + 未总结新正文），直接使用
                        bodySections.push(`${inc.text}${truncNote}\n\n（硬性约束：分析输出必须取材于上方小白x总结与正文的实际剧情；后文任务指令中的"示范/示例"仅用于说明格式与颗粒度，禁止把示例中的具体部位、项目、情节、数值当作分析结果输出）`);
                    } else {
                        bodySections.push(`【本次正文（增量，第${inc.startFloor}楼至第${inc.endFloor}楼，共${inc.count}楼${inc.truncatedChars ? '，已截断' : ''}）】\n${inc.text}${truncNote}\n\n（硬性约束：分析输出必须取材于上方正文的实际剧情；后文任务指令中的"示范/示例"仅用于说明格式与颗粒度，禁止把示例中的具体部位、项目、情节、数值当作分析结果输出）`);
                    }
                }

                for (const varName of useRefs) {
                    const content = variables[varName];
                    if (content && content !== '（未设定）') {
                        const refConfig = referencePool.find((r) => r.varName === varName);
                        const builtinDef = BUILTIN_REFERENCES.find((b) => b.varName === varName);
                        const displayLabel = refConfig?.label || refConfig?.entryKey || builtinDef?.label || varName;
                        refSections.push(`【${displayLabel}】\n${content}`);
                    }
                }

                for (const varName of useOutputs) {
                    const content = variables[varName];
                    if (content && content !== '（未设定）') {
                        let displayLabel = varName;
                        if (varName === 'startupOutput') {
                            displayLabel = startupTask.displayName || '开局分析结果';
                        } else {
                            const taskMatch = varName.match(/^task_(\d+)_Output$/);
                            if (taskMatch) {
                                const taskDef = tasks.find((t) => t.id === parseInt(taskMatch[1], 10));
                                displayLabel = taskDef?.displayName || `任务#${taskMatch[1]}结果`;
                            }
                        }
                        refSections.push(`【${displayLabel}】\n${content}`);
                    }
                }

                const assembledParts = [];
                if (bodySections.length > 0) assembledParts.push(bodySections.join('\n\n'));
                if (refSections.length > 0) {
                    assembledParts.push(`【历史分析参考（需根据上方正文更新，勿照搬）】\n${refSections.join('\n\n')}`);
                }
                if (assembledParts.length > 0) {
                    promptTemplate = `${assembledParts.join('\n\n')}\n\n[任务指令]\n${promptTemplate}`;
                    log(`prompt assembled: body(${inc.count} floors, ${(inc.text || '').length} chars) + refs(${refSections.length})`);
                }

                for (const [key, value] of Object.entries(variables)) {
                    const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
                    promptTemplate = promptTemplate.replace(regex, value || '（未设定）');
                }

                notify('info', `🔄 ${taskDisplayName} 分析中... (${taskIndex + 1}/${taskBatch.length})`, { timeOut: 3000 });
                const messages = buildMessages(taskDisplayName, promptTemplate, cfgData);
                const result = await ai.callModel({ apiCfg, genParams, messages, taskLabel: taskDisplayName });

                if (!result || result.trim().length < 2) {
                    warn(`${taskDisplayName}: result empty or too short`);
                    notify('error', `${taskDisplayName}分析失败：内容过短`);
                    failedCount++;
                    continue;
                }
                log(`generation done: ${result.length} chars`);

                if (c.getCurrentChatId?.() !== chatIdAtStart || c.characterId !== characterIdAtStart) {
                    warn(`${taskDisplayName}: chat changed during generation, result discarded`);
                    return;
                }

                const outputKey = taskConfig.outputKey;
                const outputVarName = taskConfig.outputVarName || (taskKey === 'startup' ? 'startupOutput' : `task_${taskConfig.id}_Output`);

                if (!outputKey) {
                    log(`${taskDisplayName}: no output entry configured, result kept in memory only`);
                    outputValues[outputVarName] = result.trim();
                    reader.saveBookmark(taskKey, inc.endFloor);
                    completedCount++;
                    continue;
                }

                if (!chatBook) {
                    warn('chat world book not found');
                    failedCount++;
                    continue;
                }

                await worldbook.writeOutputEntry(chatBook, {
                    key: outputKey,
                    extraKeys: taskConfig.extraKeys,
                    content: result,
                    constant: !!taskConfig.outputConstant,
                    disable: !!taskConfig.outputDisable,
                    noRecursion: !!taskConfig.noRecursion,
                    position: taskConfig.position ?? 0,
                    depth: taskConfig.depth ?? 4,
                    order: taskConfig.order ?? 100,
                    selective: !!taskConfig.selective,
                    selectiveKeys: taskConfig.selectiveKeys,
                });

                await worldbook.disableCharEntry(charBook, outputKey);
                outputValues[outputVarName] = result.trim();
                reader.saveBookmark(taskKey, inc.endFloor);
                completedCount++;
                log(`✅ ${taskDisplayName} done (bookmark at floor ${inc.endFloor})`);

            } catch (taskErr) {
                warn(`task ${taskDisplayName} failed: ${taskErr.message}`);
                notify('error', `${taskDisplayName} 失败: ${taskErr.message}`, { timeOut: 6000 });
                failedCount++;
            }
        }

        if (completedCount > 0 && chatBook) {
            await worldbook.persistBook(chatBook);
        }

        state.lastRunAt = Date.now();
        state.lastRunSummary = `${completedCount}/${taskBatch.length} 成功${failedCount > 0 ? `，${failedCount} 失败` : ''}`;

        if (taskBatch.length > 1) {
            if (failedCount === 0) notify('success', `✅ 全部 ${completedCount} 个任务完成`);
            else notify('warning', `⚠️ ${completedCount} 个成功, ${failedCount} 个失败`);
        } else if (completedCount > 0) {
            notify('success', `✅ ${taskBatch[0]?.displayName || '任务'} 完成`);
        }
        log(`pipeline finished: ${state.lastRunSummary}`);
    } catch (err) {
        state.lastError = err?.message || String(err);
        warn(`pipeline error: ${state.lastError}`, err?.stack);
        notify('error', `RUBY分析失败: ${state.lastError}`, { timeOut: 8000 });
    } finally {
        state.running = false;
        emitState();
    }
}
