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
        const plan = (meta?.plan && Number.isFinite(meta.plan.runFloor)) ? meta.plan : null;
        const dirApiCfg = config.getDirectorApiConfig();
        return {
            enabled: true,
            cycleLength: dirCfg.cycleLength,
            aggressive: !!dirCfg.aggressive,
            minSpacing: dirCfg.minSpacing,
            apiOverride: dirApiCfg.enabled ? { model: dirApiCfg.model || '', urlSet: !!dirApiCfg.url, keySet: !!dirApiCfg.key } : null,
            anchor: anchored ? meta.anchor : 0,
            runSeq: (meta?.history?.length || 0) + 1,
            offset: anchored ? aiCount - meta.anchor : 0,
            planReady: !!plan,
            planCount: plan?.assignments?.length || 0,
            planAssignments: (plan?.assignments || []).map((a) => ({ floor: a.floor, taskId: a.taskId })),
            nextDirectorFloor: meta?.nextDirectorFloor || 0,
            wokenCount: meta?.woken?.length || 0,
            manualRuns: meta?.manualRuns || 0,
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
        // 换聊天后补同步最后一层的格式锚点（幂等；含开场白首层）
        setTimeout(() => syncFormatMark(), 400);
    });
    c.eventSource.on(c.eventTypes.GENERATION_ENDED, () => {
        scheduleTick();
        // 新正文到达：把格式保护锚点注入该层的显示层
        syncFormatMark();
    });
    c.eventSource.on(c.eventTypes.MESSAGE_RECEIVED, (_messageId, type) => {
        if (type === 'first_message') {
            scheduleTick();
            syncFormatMark();
        }
    });
    c.eventSource.on(c.eventTypes.MESSAGE_UPDATED, (messageId) => {
        // 消息被编辑：显示层副本与正文重新对齐
        syncFormatMark(Number(messageId));
    });
    c.eventSource.on(c.eventTypes.MESSAGE_SWIPED, (mesId) => {
        syncFormatMark(Number(mesId));
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

// ---------- 格式保护锚点注入 ----------
// 注入目标：消息正文（mes）本身——锚点标签每个独占一行，三个消费方各取所需：
// - 显示：卡片的 markdownOnly 显示正则把 <标签> 替换为状态栏 HTML（正则机制按惯例在正文上生效）；
// - 提示词：卡片的 promptOnly 剥离正则（卡内 regex_scripts: promptOnly=true、replace 为空）把标签
//   从发送给 AI 的提示词中剥掉——即"标签在正文中，但不发送给 AI"的正则机制；
// - RUBY 阅读：reader.extractContent 自动剥离本插件注入的标签，分析管线不受污染。
// v3 锚点字段：{ tag, position: 'head'|'tail', relAnchor?, relSide? }
// - tag 支持 {{var:NAME}} 动态值：写入时从聊天变量替换（读不到 → 空串）
// - relAnchor：逗号分隔的锚标签名候选；正文中按行查找 <锚标签>/</锚标签>（取首个命中行），
//   命中 → 该锚点插到那一行的 relSide（before/after）；全部未命中 → 回退 position（head=正文最上、tail=正文最下）
function readChatVars() {
    try {
        const c = ctx();
        // /setvar 写入的变量存在 chat_metadata.variables 里——getVariables() 无参直接读这个对象，
        // 不需要也不支持 {type} 参数
        const v = typeof c.getVariables === 'function' ? c.getVariables() : null;
        return v && typeof v === 'object' ? v : {};
    } catch {
        return {};
    }
}

function resolveMarkVars(tag, vars) {
    return String(tag || '').replace(/\{\{var:([^}]+)\}\}/g, (_, name) => {
        const v = vars ? vars[String(name).trim()] : undefined;
        return v === undefined || v === null ? '' : String(v);
    });
}

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 在正文行数组中找锚标签所在行（候选逗号分隔，取首个命中行；未命中返回 -1） */
function findAnchorLine(lines, relAnchor) {
    const candidates = String(relAnchor || '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const cand of candidates) {
        const re = new RegExp(`<\\/?${escapeRegExp(cand)}[\\s>/]`, 'i');
        for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) return i;
        }
    }
    return -1;
}

/** 按配置把锚点写入正文行数组（相对定位优先，未命中回退 head/tail；返回 { mes, tags }） */
function applyFormatMarks(mes, marks, vars) {
    const list = Array.isArray(marks) ? marks : [];
    const resolved = list
        .map((m) => ({ ...m, value: `<${resolveMarkVars(m.tag, vars)}>` }))
        .filter((m) => m.value !== '<>');
    const tags = resolved.map((m) => m.value);
    if (resolved.length === 0) return { mes, tags };

    let lines = mes.split('\n');
    const inserts = [];
    const fallbackHead = [];
    const fallbackTail = [];
    for (const m of resolved) {
        if (m.relAnchor) {
            const idx = findAnchorLine(lines, m.relAnchor);
            if (idx >= 0) {
                inserts.push({ at: m.relSide === 'after' ? idx + 1 : idx, value: m.value });
                continue;
            }
        }
        (m.position === 'tail' ? fallbackTail : fallbackHead).push(m.value);
    }
    // 行号从大到小插入，避免位移
    inserts.sort((a, b) => b.at - a.at);
    for (const ins of inserts) lines.splice(ins.at, 0, ins.value);
    let out = lines.join('\n');
    if (fallbackHead.length) out = `${fallbackHead.join('\n')}\n${out}`;
    if (fallbackTail.length) out = `${out}\n${fallbackTail.join('\n')}`;
    return { mes: out, tags };
}

function rerenderMarked(c, idx, m) {
    try {
        if (typeof c.updateMessageBlock === 'function') c.updateMessageBlock(idx, m);
    } catch (e) {
        warn(`format mark rerender failed: ${e?.message || e}`);
    }
}

function saveChatSafe(c) {
    if (typeof c.saveChat === 'function') {
        try { c.saveChat(); } catch { /* 保存失败不影响本次会话显示；下一次事件重新同步 */ }
    }
}

/** 剥除锚点后的边界清理：锚点撤除留下的行首/行尾空行收敛，中部多余连续空行收敛为段落空行 */
function tidyAfterStrip(mes) {
    return mes
        .replace(/^[ \t]*(?:\r?\n)+/, '')   // 头部锚点撤除后残留的空行
        .replace(/(?:\r?\n)+[ \t]*$/, '')   // 尾部锚点撤除后残留的空行
        .replace(/\n{3,}/g, '\n\n');        // 中部撤除后的多余连续空行收敛（保留段落间单个空行）
}

/**
 * 同步格式锚点到指定消息（无 id 时取最后一层）的正文。幂等：
 * 先剥掉本插件此前注入的旧标签（记录的是动态解析后的完整标签文本，phase 变化也能剥干净）与
 * 正文中已存在的当前标签（旧卡 LLM 自行输出的场景，无论独立成行还是与正文粘连），边界空行收敛后
 * 按当前配置统一重包——相对定位锚点插到锚行前/后，其余按 head/tail 组包裹，每个锚点恰好出现一次、
 * 各自独占一行。格式清空时把此前注入的标签全部撤除，正文回落原样。
 */
export function syncFormatMark(messageId) {
    const c = ctx();
    if (!c || !Array.isArray(c.chat) || c.chat.length === 0) return;
    const chat = c.chat;
    const idx = (Number.isFinite(messageId) && messageId >= 0 && messageId < chat.length) ? messageId : chat.length - 1;
    const m = chat[idx];
    if (!m || m.is_user || m.is_system) return;
    if (!String(m.mes || '').trim()) return;

    const { data } = config.resolveConfig();
    const marks = Array.isArray(data.formatMarks) ? data.formatMarks : [];
    const vars = readChatVars();
    const resolvedTags = marks
        .map((x) => resolveMarkVars(x.tag, vars))
        .filter(Boolean);

    m.extra ||= {};
    // 清理 v2.7.0 旧版（display_text 方案）残留：标记为 true 且 display_text 存在 = 本插件注入过
    if (m.extra.rubyFormatMarked === true && m.extra.display_text !== undefined) {
        delete m.extra.display_text;
    }

    // 此前注入的标签（动态值可能已变化：记录的是上次解析结果）先撤干净，再撤当前解析值
    const applied = Array.isArray(m.extra.rubyFormatMarked) ? m.extra.rubyFormatMarked : [];
    const stripSet = [...new Set([...applied, ...resolvedTags])].filter(Boolean);
    let mes = String(m.mes || '');
    for (const t of stripSet) {
        mes = mes.split(`<${t}>`).join('');
        // 旧缺陷迁移清理：v3.0.2 之前漏包尖括号时写入的裸行（整行即标签文字），逐条自愈
        const bareRe = new RegExp(`^[ \\t]*${escapeRegExp(t)}[ \\t]*$`, 'gm');
        mes = mes.replace(bareRe, '');
    }
    mes = tidyAfterStrip(mes);

    if (marks.length === 0 || resolvedTags.length === 0) {
        if (mes !== m.mes || applied.length > 0) {
            m.mes = mes;
            delete m.extra.rubyFormatMarked;
            rerenderMarked(c, idx, m);
            saveChatSafe(c);
        }
        return;
    }

    const { mes: wrapped, tags } = applyFormatMarks(mes, marks, vars);
    if (wrapped === m.mes) {
        if (JSON.stringify(m.extra.rubyFormatMarked) !== JSON.stringify(tags)) m.extra.rubyFormatMarked = tags;
        return;
    }
    m.mes = wrapped;
    m.extra.rubyFormatMarked = tags;
    rerenderMarked(c, idx, m);
    saveChatSafe(c);
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
    // 仅手动任务（manualOnly）不参与导演激活判定——全部任务手动化时导演自动休眠
    const dirActive = !!(dirCfg?.enabled && (preset.tasks || []).some((t) => t.enabled && !t.manualOnly));
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
    sanitizeLegacyOutputFilters(preset);
}

/**
 * 自动清理历史缺陷残留：早前版本会给绿灯输出条目错误写入 "nsfw" 过滤关键词（keysecondary）。
 * 仅在聊天书已绑定时执行（不主动创建书）；任务面板勾选「使用可选过滤关键词」并填入内容的任务不受影响。
 */
async function sanitizeLegacyOutputFilters(preset) {
    if (state.running) return;
    try {
        const chatBook = await worldbook.getExistingChatBookName();
        if (!chatBook) return;
        const tasks = [preset?.startupTask, ...(preset?.tasks || [])].filter(Boolean);
        const cleaned = await worldbook.sanitizeOutputFilters(chatBook, tasks);
        if (cleaned > 0) {
            notify('info', `🧹 已自动清理 ${cleaned} 个分析输出条目上错误残留的过滤关键词`, { timeOut: 6000 });
        }
    } catch (e) {
        warn(`output filter sanitize failed: ${e?.message || e}`);
    }
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

    // 导演模式（v2 绝对楼层调度）：删除使楼层前移，计划/下次导演/锚点同步前移，
    // 清空导演幂等键与已触发记录（前移后的计划楼层可能落在已跑区间，重触发一次可接受）
    const dirMeta = cc.chatMetadata?.extensions?.RubyAnalyzer?.director;
    if (dirMeta?.v === 2) {
        // 位移规则：只有"真正改变后续楼层编号"的删除才前移——被删楼层必须小于目标楼层
        // 且小于删除后的总楼数。重新生成本楼层（ST 的 regenerate 会先删尾楼再重建，见
        // ST Generate(): chat.length -= 1 + MESSAGE_DELETED）属于尾楼删除：删除后立刻重建
        // 同序数楼层，后续编号不变——若也前移，每次重新生成都会让下次导演/计划楼层
        // 靠近1楼，累积导致周期异常快推进。swipe 为原地改写，不触发删除事件。
        // 位移规则见 director.floorShift：重新生成（删尾楼重建）不前移，防止周期异常快推进
        const shiftFor = (floor) => director.floorShift(deletedOrdinals, floor, aiCount);
        if (dirMeta.plan?.runFloor !== undefined) {
            for (const a of dirMeta.plan.assignments || []) a.floor -= shiftFor(a.floor);
            dirMeta.plan.runFloor -= shiftFor(dirMeta.plan.runFloor);
        }
        if (Number.isFinite(dirMeta.nextDirectorFloor)) dirMeta.nextDirectorFloor -= shiftFor(dirMeta.nextDirectorFloor);
        if (Number.isFinite(dirMeta.anchor)) dirMeta.anchor -= shiftFor(dirMeta.anchor);
        for (const key of [...state.triggered]) {
            if (String(key).startsWith('dir_')) state.triggered.delete(key);
        }
        dirMeta.woken = [];
        saveDirectorMeta();
        log(`director resync: plan/next-director floors shifted for ${deletedOrdinals.length} deletion(s), dir idempotent keys cleared`);
    }

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

/**
 * 取导演元数据（v2：绝对楼层调度）。
 * - anchor: 上次导演运行（或启用锚定）时的AI楼层数
 * - nextDirectorFloor: 下次导演运行的绝对楼层（普通模式=runFloor+周期长度；激进模式=导演自决）
 * - plan: { runFloor, assignments:[{floor,taskId}] }（位置换算为绝对楼层：runFloor+位置-1）
 * - history: 近5周期 {runFloor, taskIds, planned, woken, manual}（迭代学习统计）
 * - manualRuns: 本周期玩家手动执行的分析次数
 * 无锚点时以当前AI回复数锚定——启用后的下一条AI回复即导演首跑（回复1~2后开始）。
 * 旧格式（v1 周期位置制）自动重置，导演重跑一次即可。
 */
function ensureDirectorMeta(aiCount) {
    const c = ctx();
    const ns = c?.chatMetadata?.extensions;
    if (!ns) return null;
    ns.RubyAnalyzer ||= {};
    let d = ns.RubyAnalyzer.director;
    if (!d || typeof d !== 'object' || d.v !== 2 || !Number.isFinite(d.anchor)) {
        d = ns.RubyAnalyzer.director = {
            v: 2,
            anchor: aiCount,
            nextDirectorFloor: aiCount + 1,
            plan: null,
            history: [],
            woken: [],
            manualRuns: 0,
        };
        log(`director anchored at AI reply ${aiCount}: first run right after the next reply (floor ${aiCount + 1})`);
        saveDirectorMeta();
    }
    d.history ||= [];
    d.woken ||= [];
    d.manualRuns ||= 0;
    // 计划对象防畸变：plan 存在但 assignments 缺失/非数组（旧版本残留、写入中断、外部工具改写元数据）时兜底为空数组
    if (d.plan && !Array.isArray(d.plan.assignments)) d.plan.assignments = [];
    if (!Number.isFinite(d.nextDirectorFloor)) d.nextDirectorFloor = aiCount + 1;
    // 旧计划条目回填 position/woken（v2.9 前的计划只有 floor/taskId）：
    // woken 默认=楼层已过（重载后不重复触发）；未到楼层保持 false，由唤醒条件接管
    if (d.plan?.runFloor !== undefined && Array.isArray(d.plan.assignments)) {
        for (const a of d.plan.assignments) {
            if (!Number.isFinite(a.position) && Number.isFinite(a.floor)) a.position = a.floor - d.plan.runFloor + 1;
            if (a.woken === undefined) a.woken = Number.isFinite(a.floor) ? a.floor <= aiCount : false;
        }
    }
    return d;
}

/** 久未触发统计（按"执导次数"计）：当前生效计划=上一次执导，历史依次回溯 */
function computeOverdue(dmeta, taskList, runSeq) {
    const lastSeenSeq = new Map();
    const see = (taskId, seq) => {
        const prev = lastSeenSeq.get(taskId);
        if (prev === undefined || seq > prev) lastSeenSeq.set(taskId, seq);
    };
    if (dmeta?.plan?.assignments) {
        for (const a of dmeta.plan.assignments) see(a.taskId, runSeq - 1);
    }
    (dmeta?.history || []).forEach((h, idx) => {
        for (const taskId of h.taskIds || []) see(taskId, runSeq - 2 - idx);
    });
    return taskList
        .map((t) => ({ id: t.id, name: t.name, cyclesAgo: lastSeenSeq.has(t.id) ? runSeq - lastSeenSeq.get(t.id) : runSeq }))
        .filter((t) => t.cyclesAgo >= 1)
        .sort((a, b) => b.cyclesAgo - a.cyclesAgo)
        .slice(0, 6);
}

/**
 * 清除当前导演计划（排障用）：作废计划与本周期唤醒记录，下次导演位提到下一楼。
 * 配合 forceRun('director') 即"清除并立即重排"——旧计划的待触发任务全部作废，
 * 导演按当前正文从干净状态重新规划。
 */
export function clearDirectorPlan() {
    const c = ctx();
    if (!c) throw new Error('SillyTavern context unavailable');
    const aiCount = reader.countAiReplies(c.chat);
    const dmeta = ensureDirectorMeta(aiCount);
    if (!dmeta) throw new Error('聊天元数据不可用');
    dmeta.plan = null;
    dmeta.woken = [];
    dmeta.manualRuns = 0;
    dmeta.nextDirectorFloor = aiCount + 1;
    saveDirectorMeta();
    emitState();
    log(`director plan cleared (troubleshooting): next director floor -> ${dmeta.nextDirectorFloor}`);
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
    // 仅手动任务（manualOnly）不参与导演激活判定——全部任务手动化时导演自动休眠
    const dirActive = !!(dirCfg?.enabled && (preset.tasks || []).some((t) => t.enabled && !t.manualOnly));

    // —— 导演模式：绝对楼层调度——导演在 nextDirectorFloor 运行，任务按计划楼层唤醒（静态位置被接管）——
    if (dirActive) {
        const dmeta = ensureDirectorMeta(aiCount);
        if (!dmeta) return;
        // 逐楼补跑：从上次处理楼层+1 到当前逐楼检查——连发回复/分析执行期间到达的楼层不再漏检
        const from = state.baseline + 1;
        state.baseline = aiCount;
        state.cycleLength = dirCfg.cycleLength;

        const batch = [];
        let directorQueued = false;
        for (let cnt = from; cnt <= aiCount; cnt++) {
            if (cnt >= dmeta.nextDirectorFloor) {
                // 导演位：≥ 判定（原 === 无补跑，被跳过的楼层会让导演永久停摆）——
                // 被漏过的导演位/失败后的重试楼层都能在下一楼自愈，一次 tick 只排一次导演
                if (directorQueued) continue;
                const idemKey = `dir_${cnt}_director`;
                if (!state.triggered.has(idemKey)) {
                    state.triggered.add(idemKey);
                    batch.push({ type: 'director', config: dirCfg, displayName: dirCfg.displayName || '导演模式', triggeredAt: 1, sourceFloor: cnt, source: 'auto' });
                    directorQueued = true;
                }
            } else if (dmeta.plan && Array.isArray(dmeta.plan.assignments)) {
                // 到期即跑（不卡死）：计划条目按 position/floor 唤醒，错过计划楼层的
                // （锚点错位/换楼/漏检）自动顺延到下一个处理楼层执行，永不过期作废
                const due = dmeta.plan.assignments
                    .filter((a) => !a.woken && cnt >= a.floor)
                    .sort((x, y) => (x.floor - y.floor) || (x.position - y.position));
                for (const a of due) {
                    const task = preset.tasks.find((t) => t.id === a.taskId && t.enabled && !t.manualOnly);
                    if (!task) { a.woken = true; continue; }
                    const type = `task_${task.id}`;
                    const idemKey = `dir_${a.floor}_${type}`;
                    if (state.triggered.has(idemKey)) {
                        a.woken = true;
                        continue;
                    }
                    state.triggered.add(idemKey);
                    a.woken = true;
                    batch.push({ type, config: task, displayName: task.displayName || `任务#${task.id}`, triggeredAt: a.position ?? (cnt - dmeta.plan.runFloor + 1), sourceFloor: cnt, source: 'director' });
                    dmeta.woken.push({ floor: cnt, taskId: task.id });
                    saveDirectorMeta();
                }
            }
        }
        emitState();
        if (batch.length === 0) return;
        log(`director trigger at AI reply ${aiCount}: ${batch.map((t) => t.displayName).join(', ')}`);
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

/**
 * 任务解析：id 数字 / displayName / promptKey / outputKey / 捕捉关键词 → 任务对象。
 * 供手动执行（/ruby run、HTML 按钮前端）使用——前端只知道条目关键词也能精确落点。
 */
export function resolveTask(spec, preset) {
    const s = String(spec ?? '').trim();
    if (!s) return null;
    const tasks = preset?.tasks || [];
    if (/^\d+$/.test(s)) {
        const num = parseInt(s, 10);
        return tasks.find((t) => t.id === num) || null;
    }
    return tasks.find((t) => t.displayName === s)
        || tasks.find((t) => t.promptKey === s)
        || tasks.find((t) => t.outputKey === s)
        || tasks.find((t) => (t.keywordScanKeywords || []).includes(s))
        || tasks.find((t) => String(t.displayName || '').includes(s))
        || null;
}

/**
 * 手动执行分析。
 * options.pureManual=true 时走"纯手动流"（source: 'manual'）：独立书签、不计入导演迭代统计，
 * 与周期/导演两条自动逻辑完全互不干扰；默认（false）保持原有补充模式（source: 'force'，与自动流共享书签）。
 */
export async function forceRun(kind, taskId, options = {}) {
    const c = ctx();
    if (!c) throw new Error('SillyTavern context unavailable');
    if (state.running) throw new Error('已有分析任务正在执行中，请稍候');
    const source = options?.pureManual ? 'manual' : 'force';

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
            source,
        }];
    } else if (kind === 'task' || kind === 'tasks') {
        // spec 支持逗号分隔多任务与名字解析：1,3 / 沛霖内心,沛霖生理 / promptKey / 捕捉关键词
        const specs = (Array.isArray(taskId) ? taskId : String(taskId ?? '').split(','))
            .map((s) => String(s).trim()).filter(Boolean);
        const resolved = [];
        const missing = [];
        for (const spec of specs) {
            const task = resolveTask(spec, preset);
            if (task && task.enabled) resolved.push(task);
            else missing.push(spec);
        }
        if (missing.length) {
            warn(`force run: tasks not found or disabled: ${missing.join(', ')}`);
        }
        if (resolved.length === 0) {
            throw new Error(`未找到启用的任务：${specs.join(', ')}（可用：${preset.tasks.filter((t) => t.enabled).map((t) => `#${t.id} ${t.displayName}`).join('、') || '无'}）`);
        }
        batch = resolved.map((task) => ({
            type: `task_${task.id}`,
            config: task,
            displayName: task.displayName || `任务#${task.id}`,
            triggeredAt: scheduler.positionFor(aiCount, len),
            sourceFloor: aiCount,
            source,
        }));
    } else if (kind === 'all') {
        batch = scheduler.allEnabledTasks(preset.startupTask, preset.tasks, state.identity)
            .map((t) => ({ ...t, triggeredAt: scheduler.positionFor(aiCount, len), sourceFloor: aiCount, source }));
        if (batch.length === 0) throw new Error('没有已启用的任务');
    } else if (kind === 'director') {
        const dirCfg = preset.director;
        if (!dirCfg?.enabled) throw new Error('导演模式未启用：请先在导演面板启用导演周期');
        if (!(preset.tasks || []).some((t) => t.enabled)) throw new Error('没有已启用的任务，导演无可调度');
        batch = [{ type: 'director', config: dirCfg, displayName: dirCfg.displayName || '导演模式', triggeredAt: 1, sourceFloor: aiCount, source: 'force' }];
    } else {
        throw new Error(`unknown forceRun kind: ${kind}`);
    }

    // 手动执行计入导演迭代统计（本周期玩家手动分析次数）
    // 纯手动流不计——它在导演的调度世界观之外，不应影响导演的排期学习
    if (kind !== 'director' && source !== 'manual') {
        const dm = readDirectorMeta();
        if (dm) {
            dm.manualRuns = (dm.manualRuns || 0) + batch.length;
            saveDirectorMeta();
        }
    }

    const runResults = await runPipeline(batch);
    // 结构化结果：HTML 前端拿 outputs 里的 outputKey 逐个 /ruby read 刷新
    // 导演批次不产出 runResults 条目（排期结果写聊天元数据+计划条目，非输出条目）：
    // 走到这里且批内唯一任务是导演 = runDirectorTask 已成功返回，直接按成功契约返回
    if (batch.length === 1 && batch[0].type === 'director') {
        return { ok: true, summary: '导演排期完成', completed: 1, failed: 0, tasks: [{ name: batch[0].displayName || '导演模式', ok: true, outputKey: '' }] };
    }
    const completed = runResults.filter((r) => r.ok).length;
    const failed = runResults.length - completed;
    return {
        ok: failed === 0 && runResults.length > 0,
        summary: `${batch.map((t) => t.displayName).join(', ')} 执行完毕（${completed}/${runResults.length} 成功）`,
        completed,
        failed,
        tasks: runResults,
    };
}

/**
 * 导演任务执行：组装高度结构化提示词（任务清单/排期规则/调度参考/正文/参考条目/输出格式），
 * 调用导演API，严格解析调度表——仅格式错乱/内容不完整按创作者设定的次数自动重试；
 * 成功后计划写入聊天元数据（tick 查表唤醒）+ 聊天世界书计划条目（保持关闭），并轮转近5周期历史。
 */
async function runDirectorTask(d, ctxObj) {
    const { cfgData, preset, charBook, chatBook, referencePool, referenceValues, providerSummary, customTags, apiCfg, genParams, chatIdAtStart, characterIdAtStart, ignoreLatest } = ctxObj;
    const c = ctx();
    const dirCfg = d.config;
    const L = dirCfg.cycleLength;
    const dmeta = ensureDirectorMeta(c ? reader.countAiReplies(c.chat) : 0);
    if (!dmeta) throw new Error('聊天元数据不可用');
    const runSeq = dmeta.history.length + 1;

    // 独立导演API（玩家面板勾选，全局设置）：仅覆盖 url/key/model，空字段跟随RUBY分析API；
    // 流式等传输方式完全跟随RUBY基础API设置，不存在独立传输设计
    const dirApi = config.getDirectorApiConfig();
    const effApiCfg = dirApi.enabled
        ? { ...apiCfg, url: dirApi.url || apiCfg.url, key: dirApi.key || apiCfg.key, model: dirApi.model || apiCfg.model }
        : apiCfg;
    log(`director api: ${dirApi.enabled
        ? `独立（model=${effApiCfg.model || '未设置'}｜url=${dirApi.url ? '已覆盖' : '跟随'}｜key=${dirApi.key ? '已覆盖' : '跟随'}）`
        : '未启用 — 跟随RUBY基础API'}`);

    // 导演专注阅读（focusRead，默认开）：每层只读首尾各 skimHead/skimTail 字——
    // 排期不需要全文（任务清单/参考池/总结已足够参考），长文稀释格式纪律是"输出未包yaml/
    // 解析不出位置任务"的主要诱因
    const skim = (dirCfg.focusRead !== false)
        ? {
            head: Number.isFinite(Number(dirCfg.skimHead)) ? Number(dirCfg.skimHead) : 100,
            tail: Number.isFinite(Number(dirCfg.skimTail)) ? Number(dirCfg.skimTail) : 100,
        }
        : null;

    // 增量正文（导演独立书签）；手动执行时书签已推进会导致空读，重置重读
    let inc = reader.incrementalRead('director', customTags, { noWindowLimit: !!providerSummary, ignoreLatest, skim });
    if (inc.count === 0 || !inc.text) {
        if (d.source === 'force') {
            reader.resetBookmark('director');
            inc = reader.incrementalRead('director', customTags, { noWindowLimit: !!providerSummary, skim });
            log(`director force run: bookmark reset, re-reading ${inc.count} floors`);
        } else {
            log('director: no new floors since last run (bookmark at current), scheduling with empty context');
        }
    }
    applySummaryReplacement(c, inc, providerSummary, customTags);
    const contextText = reader.capText(inc.text, cfgData.unlimitedInputChars ? Infinity : undefined).text;

    // 任务清单：id+名称必发；简介手写优先，否则从提示词条目自动提取约200字切面
    // 仅手动任务（manualOnly）不进入导演候选——它们只由前端/命令手动触发
    const enabledTasks = (preset.tasks || []).filter((t) => t.enabled && !t.manualOnly);
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

    const round = runSeq;
    const prevPlan = dmeta.plan;
    const prevAssignments = (prevPlan?.assignments && Array.isArray(prevPlan.assignments)) ? prevPlan.assignments : [];
    const nameOf = (taskId) => taskList.find((t) => t.id === taskId)?.name || `任务#${taskId}`;
    const lastCycle = prevAssignments.map((a) => ({
        position: a.floor - prevPlan.runFloor + 1,
        taskId: a.taskId,
        name: nameOf(a.taskId),
    }));
    const woken = (dmeta.woken || []).map((a) => ({
        position: prevPlan ? a.floor - prevPlan.runFloor + 1 : a.floor,
        taskId: a.taskId,
        name: nameOf(a.taskId),
    }));
    const overdue = computeOverdue(dmeta, taskList, round);
    const lastStats = prevPlan ? {
        planned: prevAssignments.length,
        woken: dmeta.woken.length,
        manual: dmeta.manualRuns || 0,
    } : null;

    const prompt = director.buildDirectorPrompt({
        tasks: taskList,
        cycleLength: L,
        minSpacing: dirCfg.minSpacing,
        aggressive: !!dirCfg.aggressive,
        round,
        lastCycle,
        woken,
        overdue,
        lastStats,
        contextText,
        refSections,
    });
    const messages = buildMessages('导演模式', prompt, cfgData);

    // gemini 3.5 及以上（含pro/flash）已取消assistant预填充支持：破限预填充消息自动降为user
    const effModel = String(effApiCfg.model || '');
    if (director.isGeminiPostPrefillDrop(effModel)) {
        let converted = 0;
        for (const m of messages) {
            if (m.role === 'assistant') { m.role = 'user'; converted++; }
        }
        if (converted > 0) log(`gemini 3.5+ model detected (${effModel}): ${converted} prefill assistant message(s) -> user`);
    }

    // 导演就是分析任务：genParams/messages 与任务循环完全一致；apiCfg 仅按导演页的复制粘贴覆盖 url/key/model
    notify('info', '🎬 导演排期中...', { timeOut: 4000 });
    const maxAttempts = 1 + Math.max(0, Math.round(dirCfg.retryLimit || 0));
    let parsed = null;
    let lastReason = '';
    let attempts = 0;
    while (attempts < maxAttempts) {
        attempts++;
        const result = await ai.callModel({
            apiCfg: effApiCfg,
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
        // 导演失败不退回静态位置调度（排期权始终在导演）：自动流下顺延两层楼再试，
        // 带着更新的正文重排，避免整周期静默空转；手动流不动 nextDirectorFloor
        if (d.source === 'auto' && Number.isFinite(d.sourceFloor)) {
            dmeta.nextDirectorFloor = d.sourceFloor + 2;
        }
        saveDirectorMeta();
        emitState();
        const failTip = d.source === 'auto'
            ? `将在第${dmeta.nextDirectorFloor}楼自动重试，也可在导演面板手动重新执行`
            : '可在导演面板手动重新执行';
        notify('error', `🔴 导演模式失败：${lastReason}（已重试 ${attempts - 1} 次）。${failTip}`, { timeOut: 10000 });
        return;
    }

    // 中途切换聊天/角色则丢弃结果
    if (c.getCurrentChatId?.() !== chatIdAtStart || c.characterId !== characterIdAtStart) {
        warn('director: chat changed during generation, plan discarded');
        return;
    }

    // 下次导演间隔：激进模式由导演自决（"下次导演间隔"字段），普通模式=周期长度
    const runFloor = inc.endFloor || dmeta.anchor + 1;
    const gap = dirCfg.aggressive && Number.isFinite(parsed.directorGap) && parsed.directorGap >= 2
        ? Math.min(parsed.directorGap, 60)
        : L;
    const validated = director.validateSchedule(parsed.assignments, { maxPosition: gap - 1, minSpacing: dirCfg.minSpacing, taskList });
    for (const w of validated.warnings) warn(`director schedule: ${w}`);

    // 历史轮转：上一周期计划连同实际表现（计划数/触发数/手动次数）进历史，供迭代学习（最多5条）
    if (prevPlan && Number.isFinite(prevPlan.runFloor)) {
        dmeta.history.unshift({
            runFloor: prevPlan.runFloor,
            taskIds: prevAssignments.map((a) => a.taskId),
            planned: prevAssignments.length,
            woken: dmeta.woken.length,
            manual: dmeta.manualRuns || 0,
        });
        dmeta.history = dmeta.history.slice(0, 5);
    }
    // 位置换算为绝对楼层只做一次：后续计划条目/通知都用这份带 floor 的清单，
    // position 保留周期相对序号（唤醒/展示用），woken 标记到期即跑状态
    const plannedAssignments = validated.assignments.map((a) => ({ floor: runFloor + a.position - 1, position: a.position, taskId: a.taskId, woken: false }));
    dmeta.plan = {
        runFloor,
        assignments: plannedAssignments,
        createdAt: Date.now(),
    };
    dmeta.nextDirectorFloor = runFloor + gap;
    dmeta.anchor = runFloor;
    dmeta.woken = [];
    dmeta.manualRuns = 0;
    dmeta.lastDirectorRun = { floor: runFloor, at: Date.now(), ok: true, gap, aggressive: !!dirCfg.aggressive };
    saveDirectorMeta();
    reader.saveBookmark('director', inc.endFloor);

    // 计划条目写入聊天世界书（保持关闭，仅引擎读取/排查用）
    if (chatBook && dirCfg.planKey) {
        try {
            const content = [
                `【RUBY导演计划·第${round}次执导】（自动生成，请保持条目关闭，仅供导演引擎读取）`,
                `导演运行楼层: ${runFloor}｜下次导演: 第${dmeta.nextDirectorFloor}楼${dirCfg.aggressive ? '（激进模式，间隔由导演自决）' : `（周期${L}）`}`,
                ...plannedAssignments.map((a) => `第${a.floor}楼: task${a.taskId} ${nameOf(a.taskId)}`),
            ].join('\n');
            await worldbook.writeOutputEntry(chatBook, { key: dirCfg.planKey, content, disable: true });
            await worldbook.persistBook(chatBook);
        } catch (e) {
            warn(`director plan entry write failed: ${e?.message || e}`);
        }
    }

    state.lastRunAt = Date.now();
    state.lastRunSummary = validated.assignments.length > 0
        ? `导演计划：${validated.assignments.length}个任务（第${round}次执导，下次导演第${dmeta.nextDirectorFloor}楼）`
        : `导演计划：本周期不排任务（第${round}次执导）`;
    notify('success', `🎬 导演计划已生成（第${round}次执导）：${plannedAssignments.map((a) => `第${a.floor}楼→task${a.taskId}`).join('，') || '本周期无任务'}｜下次导演第${dmeta.nextDirectorFloor}楼`, { timeOut: 8000 });
    log(`director plan ready: ${JSON.stringify(dmeta.plan.assignments)} | nextDirectorFloor=${dmeta.nextDirectorFloor}`);
    emitState();
}

export async function runPipeline(taskBatch) {
    if (!taskBatch || taskBatch.length === 0) return [];

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
    let wroteToChatBook = false;
    const runResults = [];
    // 本批次成功写入的输出条目 key（批次收尾推送事件时随 detail 带给前端）
    const pushedKeys = [];

    try {
        const charBook = await worldbook.getCharBookName();
        const chatBook = await worldbook.getChatBookName();
        if (!charBook) {
            warn('character world book not found');
            notify('warning', 'RUBY：未找到角色世界书，无法执行分析');
            return runResults; // forceRun 消费返回值做统计，裸 return 会对 undefined 调 .filter
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

        // 总结接口（小白x / 龙血玄黄·数据库 / 柚月记忆表 / 柏宝书）：已总结楼层用总结替代正文。
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
                    providerSummary = { boundary: shu.boundary, text: shu.text, label: '龙血玄黄·数据库剧情总结' };
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
    // 忽略最新一层（玩家面板勾选）：所有读取（任务/导演）最新AI回复不读不计数——
    // 防当层输出截断/失败仍被计入书签，留待下一层分析一并读取
    const ignoreLatest = !!config.getUi().ignoreLatestFloor;

    if (taskBatch.length === 1 && taskBatch[0].type === 'director') {
        await runDirectorTask(taskBatch[0], {
            cfgData, preset, charBook, chatBook, referencePool, referenceValues,
            providerSummary, customTags, apiCfg, genParams, chatIdAtStart, characterIdAtStart,
            ignoreLatest,
        });
        return runResults; // forceRun 消费返回值做统计（.filter），裸 return 会抛 TypeError
    }

        for (let taskIndex = 0; taskIndex < taskBatch.length; taskIndex++) {
            const current = taskBatch[taskIndex];
            const taskConfig = current.config;
            const taskKey = current.type;
            const taskDisplayName = current.displayName;
            // 纯手动流（source: 'manual'）使用独立书签：读哪些楼、推进到哪，都与周期/导演流的 taskKey 互不影响
            const bmKey = current.source === 'manual' ? `manual:${taskKey}` : taskKey;

            try {
                if (c.getCurrentChatId?.() !== chatIdAtStart || c.characterId !== characterIdAtStart) {
                    warn('chat or character changed during pipeline, aborting remaining tasks');
                    return runResults; // 与下方同类早退保持一致，保证 forceRun 统计安全
                }

                log(`task ${taskIndex + 1}/${taskBatch.length}: ${taskDisplayName} (${current.source})`);

                let inc = reader.incrementalRead(bmKey, customTags, { noWindowLimit: !!providerSummary, ignoreLatest });
                log(`incremental read: floors ${inc.startFloor}-${inc.endFloor} (${inc.count} floors, ${(inc.text || '').length} chars)${ignoreLatest ? ' [忽略最新一层]' : ''}`);

                if (inc.count === 0 || !inc.text) {
                    // force/manual 或导演计划重触发（重新生成的楼层内容变化）：重置书签重读该楼层
                    if (current.source === 'force' || current.source === 'director' || current.source === 'manual') {
                        reader.resetBookmark(bmKey);
                        inc = reader.incrementalRead(bmKey, customTags, { noWindowLimit: !!providerSummary, ignoreLatest });
                        log(`bookmark reset, re-reading ${inc.count} floors (${current.source})`);
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
                const keywordScan = (current.source === 'force' || current.source === 'director' || current.source === 'manual')
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

                // 任务级标签过滤（v3）：readTagMode='include' 只读列出标签内容（解包），'exclude' 剥除列出标签块；
                // 未配置则原文。过滤在截断之前——让字符上限吃在过滤后的有效文本上。
                const filteredText = reader.applyTaskTagFilter(inc.text, taskConfig);
                if (filteredText !== inc.text) {
                    log(`task tag filter [${taskConfig.readTagMode}]: ${taskDisplayName} ${inc.text.length} → ${filteredText.length} chars`);
                    inc.text = filteredText;
                }

                // 全局字符上限：默认 20 万，只截断对话正文（保留靠前部分、抛弃后续剩余正文）；
                // 玩家面板勾选"无字符上限"后传 Infinity，正文永不截断。
                // 参考条目池与历史分析输出在下方组装阶段追加，从不参与此上限，绝不因截断丢失。
                const capped = reader.capText(inc.text, cfgData.unlimitedInputChars ? Infinity : undefined);
                if (capped.truncated > 0) {
                    warn(`body exceeds ${reader.MAX_INPUT_CHARS} chars: ${inc.text.length} chars, discarding last ${capped.truncated} chars of chat text (references unaffected)`);
                    inc.text = capped.text;
                    inc.truncatedChars = capped.truncated;
                    notify('warning', `RUBY：${taskDisplayName} 正文超过字符上限，末尾 ${capped.truncated} 字符已截断抛弃`);
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
                        ? `\n\n（⚠️ 本次正文超过字符上限，末尾约 ${inc.truncatedChars} 字符已被截断抛弃，仅上方保留部分为有效分析素材）`
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
                    runResults.push({ name: taskDisplayName, ok: false, reason: '内容过短' });
                    continue;
                }
                log(`generation done: ${result.length} chars`);

                if (c.getCurrentChatId?.() !== chatIdAtStart || c.characterId !== characterIdAtStart) {
                    warn(`${taskDisplayName}: chat changed during generation, result discarded`);
                    return runResults;
                }

                const outputKey = taskConfig.outputKey;
                const outputVarName = taskConfig.outputVarName || (taskKey === 'startup' ? 'startupOutput' : `task_${taskConfig.id}_Output`);

                if (!outputKey) {
                    log(`${taskDisplayName}: no output entry configured, result kept in memory only`);
                    outputValues[outputVarName] = result.trim();
                    reader.saveBookmark(bmKey, inc.endFloor);
                    completedCount++;
                    runResults.push({ name: taskDisplayName, ok: true, outputKey: '' });
                    continue;
                }

                if (!chatBook) {
                    warn('chat world book not found');
                    failedCount++;
                    runResults.push({ name: taskDisplayName, ok: false, reason: '无聊天世界书' });
                    continue;
                }

                // 写入前快照：把输出条目当前内容（= 上一次分析结果）存入聊天元数据，
                // 本次分析出错覆盖了好结果时，玩家可从面板「恢复上一层快照」一键回滚
                try {
                    const prevContent = await worldbook.readEntryContent(chatBook, outputKey);
                    if (prevContent.trim()) {
                        reader.saveLastOutputSnapshot({ outputKey, taskName: taskDisplayName, content: prevContent });
                    }
                } catch (snapErr) {
                    warn(`snapshot before write failed (non-fatal): ${snapErr.message}`);
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
                    // 过滤关键词仅在任务勾选「使用可选过滤关键词」并填入内容时生效，未勾选一律传空（清空残留）
                    selectiveKeys: (taskConfig.selectiveKeysEnabled && Array.isArray(taskConfig.selectiveKeys)) ? taskConfig.selectiveKeys : [],
                });
                wroteToChatBook = true;

                await worldbook.disableCharEntry(charBook, outputKey);
                outputValues[outputVarName] = result.trim();
                reader.saveBookmark(bmKey, inc.endFloor);
                completedCount++;
                runResults.push({ name: taskDisplayName, ok: true, outputKey });
                pushedKeys.push(outputKey);
                // 每份分析结果落笔即推送前端（手动/自动/前端触发一律走此管线）：
                // 状态栏（iframe）监听宿主 window 的本事件即时重读，无需等消息重渲染；轮询做兜底
                try {
                    window.dispatchEvent(new CustomEvent('ruby:chatbooks-changed', {
                        detail: { key: outputKey, keys: [outputKey], taskName: taskDisplayName },
                    }));
                } catch { /* 事件派发失败不影响分析管线 */ }
                log(`✅ ${taskDisplayName} done (bookmark at floor ${inc.endFloor})`);

            } catch (taskErr) {
                warn(`task ${taskDisplayName} failed: ${taskErr.message}`);
                notify('error', `${taskDisplayName} 失败: ${taskErr.message}`, { timeOut: 6000 });
                failedCount++;
                runResults.push({ name: taskDisplayName, ok: false, reason: taskErr.message });
            }
        }

        if (completedCount > 0 && chatBook) {
            await worldbook.persistBook(chatBook);
        }

        // 给本次写入分析输出的「聊天世界书」打标签（登记到全局登记簿）：
        // 只在书级别记录书名 + 所属角色，不碰条目、不靠 UID 识别
        if (wroteToChatBook) {
            try {
                const identity = config.getCharacterIdentity();
                config.registerGeneratedChatBook({
                    chatId: chatIdAtStart || '',
                    chatBookName: chatBook,
                    characterAvatar: identity?.avatar || '',
                    characterName: identity?.name || charName || '',
                });
                window.dispatchEvent(new CustomEvent('ruby:chatbooks-changed', { detail: { keys: pushedKeys.slice() } }));
                log(`generated chat book registered: ${chatBook} (${identity?.name || charName})`);
            } catch (e) {
                warn(`register generated chat book failed: ${e?.message || e}`);
            }
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
        return runResults;
    } catch (err) {
        state.lastError = err?.message || String(err);
        warn(`pipeline error: ${state.lastError}`, err?.stack);
        notify('error', `RUBY分析失败: ${state.lastError}`, { timeOut: 8000 });
        return runResults;
    } finally {
        state.running = false;
        emitState();
        // 手动流/外部触发占用 running 期间到达的 tick 只置了 needTick 却无人消化——
        // pipeline 一结束就补一次调度检查（tick 自身路径 needTick 不会被这里置位，不会重复跑）
        if (state.needTick) {
            state.needTick = false;
            scheduleTick();
        }
    }
}
