import { ctx, log, warn } from './env.js';

const SETTINGS_KEY = 'RubyAnalyzer';

export const DEFAULT_STARTUP = {
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
};

export const makeDefaultPreset = () => ({
    id: 'default',
    name: '默认方案',
    description: '',
    referencePool: [],
    tasks: [],
    nextTaskId: 1,
    startupTask: JSON.parse(JSON.stringify(DEFAULT_STARTUP)),
});

export const makeDefaultConfigData = () => ({
    charName: '',
    customContentTags: [],
    summaryProvider: '',
    presets: [makeDefaultPreset()],
    activePresetId: 'default',
    jailbreak: null,
    gen: {},
});

const makeDefaultApi = () => ({
    provider: 'main',
    url: '',
    key: '',
    model: '',
    stream: true,
    cache: [],
    reasoningEffort: '',
});

const makeDefaultUi = () => ({
    orbHidden: false,
    orbSize: 60,
    orbX: null,
    orbY: null,
    notify: true,
});

/** 悬浮球尺寸取值范围：当前悬浮窗 60px 为上限，可逐步缩小 */
export function clampOrbSize(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 60;
    return Math.max(32, Math.min(60, Math.round(v)));
}

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * 生成参数清洗：只保留合法值，其余一律剔除（不发送，交由酒馆预设/服务商默认）。
 * 顶层 enabled 标志默认关闭——关闭时引擎完全不传采样参数。
 */
export function sanitizeGenParams(gen) {
    const src = (gen && typeof gen === 'object') ? gen : {};
    const rules = {
        temperature: { min: 0, max: 2 },
        top_p: { min: 0, max: 1, exclusiveMin: true },
        top_k: { min: 1, max: 1000 },
        presence_penalty: { min: -2, max: 2 },
        frequency_penalty: { min: -2, max: 2 },
    };
    const out = {};
    for (const [key, rule] of Object.entries(rules)) {
        const n = Number(src[key]);
        if (!Number.isFinite(n)) continue;
        if (n < rule.min || n > rule.max) continue;
        if (rule.exclusiveMin && n <= rule.min) continue;
        out[key] = n;
    }
    const mt = Number(src.max_tokens);
    if (Number.isFinite(mt) && mt >= 1) out.max_tokens = mt;
    if (['low', 'medium', 'high'].includes(String(src.reasoning_effort))) {
        out.reasoning_effort = String(src.reasoning_effort);
    }
    if (src.enabled === true) out.enabled = true;
    return out;
}

export function getSettings() {
    const c = ctx();
    if (!c) return null;
    const store = (c.extensionSettings[SETTINGS_KEY] ||= {});
    store.api = { ...makeDefaultApi(), ...(store.api || {}) };
    store.api.cache = Array.isArray(store.api.cache) ? store.api.cache : [];
    const rawProvider = String(store.api.provider || '');
    if (rawProvider !== 'main' && rawProvider !== 'custom') {
        store.api.provider = (rawProvider === 'st' || rawProvider === '') && !store.api.url ? 'main' : 'custom';
    }
    store.global = normalizeConfigData(store.global || makeDefaultConfigData());
    store.characterConfigs = (store.characterConfigs && typeof store.characterConfigs === 'object') ? store.characterConfigs : {};
    store.ui = { ...makeDefaultUi(), ...(store.ui || {}) };
    return store;
}

export function persist() {
    const c = ctx();
    if (typeof c?.saveSettingsDebounced === 'function') {
        c.saveSettingsDebounced();
    }
}

export function normalizeConfigData(raw) {
    const data = (raw && typeof raw === 'object') ? raw : {};
    const result = makeDefaultConfigData();
    result.charName = String(data.charName || '');
    result.customContentTags = Array.isArray(data.customContentTags)
        ? data.customContentTags.filter((t) => typeof t === 'string' && t.trim())
        : [];
    // 总结接口：''=关闭；'littlewhitebox'=小白x；'shujuku'=SP·数据库；'yuzuki'=柚月记忆表
    result.summaryProvider = ['littlewhitebox', 'shujuku', 'yuzuki'].includes(data.summaryProvider) ? data.summaryProvider : '';
    // 柚月记忆表：剧情摘要时间线是否随记忆总结一并注入（默认开）
    result.yuzukiIncludePlot = data.yuzukiIncludePlot !== false;
    result.presets = Array.isArray(data.presets) && data.presets.length > 0
        ? data.presets.map(normalizePreset)
        : [makeDefaultPreset()];
    result.activePresetId = String(data.activePresetId || result.presets[0].id);
    if (!result.presets.some((p) => p.id === result.activePresetId)) {
        result.activePresetId = result.presets[0].id;
    }
    result.jailbreak = data.jailbreak || null;
    result.gen = sanitizeGenParams(data.gen);
    return result;
}

export function normalizePreset(raw) {
    const p = (raw && typeof raw === 'object') ? raw : {};
    const preset = makeDefaultPreset();
    preset.id = String(p.id || `preset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    preset.name = String(p.name || '未命名方案');
    preset.description = String(p.description || '');
    preset.referencePool = Array.isArray(p.referencePool)
        ? p.referencePool.map((r) => ({
            entryKey: String(r?.entryKey || ''),
            varName: String(r?.varName || ''),
            label: String(r?.label || r?.entryKey || r?.varName || ''),
        })).filter((r) => r.entryKey && r.varName)
        : [];
    preset.tasks = Array.isArray(p.tasks) ? p.tasks.map(normalizeTask) : [];
    const maxId = preset.tasks.reduce((m, t) => Math.max(m, t.id || 0), 0);
    preset.nextTaskId = Number(p.nextTaskId) > maxId ? Number(p.nextTaskId) : maxId + 1;
    const rawStartup = (p.startupTask && typeof p.startupTask === 'object') ? p.startupTask : {};
    const mergedStartup = { ...clone(DEFAULT_STARTUP), ...rawStartup };
    // 周期位置以导入的原始字段为准（cyclePositions > triggerFloors），防止默认值 [1,2] 覆盖旧格式数据
    mergedStartup.cyclePositions = normalizePositions(
        rawStartup.cyclePositions ?? rawStartup.triggerFloors ?? mergedStartup.cyclePositions,
    );
    preset.startupTask = mergedStartup;
    return preset;
}

export function normalizeTask(raw) {
    const t = (raw && typeof raw === 'object') ? raw : {};
    const task = {
        id: Number(t.id) || 0,
        enabled: t.enabled !== false,
        displayName: String(t.displayName || `任务#${t.id || '?'}`),
        cyclePositions: normalizePositions(t.cyclePositions ?? t.cyclePosition ?? t.triggerFloor),
        cyclePosition: 0,
        triggerFloor: 0,
        promptKey: String(t.promptKey || ''),
        outputKey: String(t.outputKey || ''),
        extraKeys: String(t.extraKeys || ''),
        outputVarName: String(t.outputVarName || `task_${t.id || 0}_Output`),
        enableJailbreak: t.enableJailbreak !== false,
        outputConstant: !!t.outputConstant,
        outputDisable: t.outputDisable ? 1 : 0,
        selective: !!t.selective,
        selectiveKeys: Array.isArray(t.selectiveKeys) ? t.selectiveKeys : [],
        noRecursion: !!t.noRecursion,
        position: Number.isFinite(Number(t.position)) ? Number(t.position) : 0,
        depth: Number.isFinite(Number(t.depth)) ? Number(t.depth) : 4,
        order: Number.isFinite(Number(t.order)) ? Number(t.order) : 100,
        keywordScanEnabled: !!t.keywordScanEnabled,
        keywordScanKeywords: Array.isArray(t.keywordScanKeywords)
            ? t.keywordScanKeywords.map((k) => String(k || '').trim()).filter(Boolean)
            : (typeof t.keywordScanKeywords === 'string'
                ? t.keywordScanKeywords.split(',').map((k) => k.trim()).filter(Boolean)
                : []),
        useReferences: Array.isArray(t.useReferences) ? t.useReferences.map(String) : [],
        useOutputs: Array.isArray(t.useOutputs) ? t.useOutputs.map(String) : [],
        // characters（任务级角色绑定）已废弃：读取时静默丢弃，避免误过滤
    };
    task.cyclePosition = task.cyclePositions[0] || 0;
    task.triggerFloor = task.cyclePosition;
    return task;
}

export function normalizePositions(raw) {
    let list = [];
    if (Array.isArray(raw)) list = raw;
    else if (typeof raw === 'string') list = raw.split(',');
    else if (Number.isFinite(Number(raw))) list = [Number(raw)];
    return [...new Set(list.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
}

export function getCharacterIdentity() {
    const c = ctx();
    if (!c || c.characterId === undefined || c.characterId === null || c.characterId < 0) return null;
    const ch = c.characters?.[c.characterId];
    if (!ch) return null;
    return { avatar: String(ch.avatar || ''), name: String(ch.name || '') };
}

/**
 * 角色卡内嵌配置：存于角色卡 JSON 的 data.extensions.RubyAnalyzer 字段，
 * 随卡片导出/分享。读取直接走当前已加载的角色对象。
 */
function findCharacterByIdentity(identity) {
    const c = ctx();
    if (!c || !identity?.avatar) return null;
    return (c.characters || []).find((x) => x?.avatar === identity.avatar) || null;
}

function getCardConfigRaw(identity) {
    const ch = findCharacterByIdentity(identity);
    const raw = ch?.data?.extensions?.[SETTINGS_KEY];
    return (raw && typeof raw === 'object') ? raw : null;
}

function setCardConfigInMemory(identity, value) {
    const ch = findCharacterByIdentity(identity);
    if (!ch) return false;
    ch.data ||= {};
    ch.data.extensions ||= {};
    if (value === null) delete ch.data.extensions[SETTINGS_KEY];
    else ch.data.extensions[SETTINGS_KEY] = value;
    return true;
}

function canWriteCard() {
    return typeof ctx()?.writeExtensionField === 'function';
}

let cardPersistTimer = null;
let pendingCardPersist = null;
const CARD_PERSIST_DELAY_MS = 2500;

async function flushCardPersist() {
    const job = pendingCardPersist;
    pendingCardPersist = null;
    cardPersistTimer = null;
    if (!job) return;
    const c = ctx();
    const chid = (c?.characters || []).findIndex((x) => x?.avatar === job.identity.avatar);
    if (chid < 0 || typeof c?.writeExtensionField !== 'function') {
        warn('card persist skipped: character not found or writeExtensionField unavailable');
        return;
    }
    try {
        await c.writeExtensionField(chid, SETTINGS_KEY, job.value);
        log(`card config persisted for ${job.identity.name} (${job.value === null ? 'removed' : 'updated'})`);
    } catch (e) {
        warn(`card persist failed: ${e?.message || e}`);
        window.toastr?.error?.(`RUBY：角色卡配置写入失败（${e?.message || e}）`, '', { timeOut: 6000 });
    }
}

function scheduleCardPersist(identity, value) {
    pendingCardPersist = { identity, value };
    if (cardPersistTimer) return;
    cardPersistTimer = setTimeout(flushCardPersist, CARD_PERSIST_DELAY_MS);
}

/** 立即写卡（跳过防抖等待）；显式操作（绑定/解绑/导入）后调用 */
export async function flushCardPersistNow() {
    if (cardPersistTimer) {
        clearTimeout(cardPersistTimer);
        cardPersistTimer = null;
    }
    await flushCardPersist();
}

export function resolveConfig() {
    const store = getSettings();
    if (!store) return { data: makeDefaultConfigData(), layer: 'unavailable', source: 'unavailable', identity: null };
    const identity = getCharacterIdentity();
    if (identity) {
        const cardRaw = getCardConfigRaw(identity);
        if (cardRaw) {
            return { data: normalizeConfigData(cardRaw), layer: 'character', source: 'card', identity };
        }
        if (store.characterConfigs[identity.avatar]) {
            return { data: normalizeConfigData(store.characterConfigs[identity.avatar]), layer: 'character', source: 'local', identity };
        }
    }
    return { data: store.global, layer: 'global', source: 'global', identity };
}

export function saveConfigData(data) {
    const store = getSettings();
    if (!store) return;
    const normalized = normalizeConfigData(data);
    const identity = getCharacterIdentity();
    if (identity && canWriteCard()) {
        // 卡片中心模型：打开角色时任何保存默认写入当前角色卡
        // （首次保存即自动绑定，旧本地绑定随之迁移为卡片内嵌）
        setCardConfigInMemory(identity, normalized);
        scheduleCardPersist(identity, normalized);
        delete store.characterConfigs[identity.avatar];
    } else if (identity && store.characterConfigs[identity.avatar]) {
        // 写卡 API 不可用环境的回退：维持旧本地绑定
        store.characterConfigs[identity.avatar] = normalized;
    } else {
        // 未打开角色：暂存全局层（面板会提示打开角色卡，不随卡导出）
        store.global = normalized;
    }
    persist();
}

export function getActivePreset(configData) {
    const data = configData || resolveConfig().data;
    return data.presets.find((p) => p.id === data.activePresetId) || data.presets[0] || makeDefaultPreset();
}

/**
 * 绑定当前生效配置到当前角色：写入角色卡 data.extensions 字段（随卡导出）。
 * 旧版本地绑定会自动迁移为卡片内嵌；未绑定时等效于把全局配置复制进卡。
 */
export function bindToCharacter() {
    const store = getSettings();
    const identity = getCharacterIdentity();
    if (!store || !identity) return false;
    const source = resolveConfig();
    const configData = clone(source.data);
    if (canWriteCard()) {
        setCardConfigInMemory(identity, configData);
        scheduleCardPersist(identity, configData);
        delete store.characterConfigs[identity.avatar];
        flushCardPersistNow().catch(() => { /* flush 内部已上报错误 */ });
        log(`config embedded into character card: ${identity.name}`);
    } else {
        store.characterConfigs[identity.avatar] = configData;
        log(`config bound to local settings (card API unavailable): ${identity.name}`);
    }
    persist();
    return true;
}

export function getBoundCharacters() {
    const store = getSettings();
    const c = ctx();
    const result = [];
    const seen = new Set();
    for (const ch of (c?.characters || [])) {
        const raw = ch?.data?.extensions?.[SETTINGS_KEY];
        if (ch?.avatar && raw && typeof raw === 'object') {
            result.push({ avatar: ch.avatar, name: ch.name || ch.avatar, source: 'card' });
            seen.add(ch.avatar);
        }
    }
    for (const avatar of Object.keys(store?.characterConfigs || {})) {
        if (seen.has(avatar)) continue;
        const ch = (c?.characters || []).find((x) => x?.avatar === avatar);
        result.push({ avatar, name: ch?.name || avatar, source: 'local' });
    }
    return result;
}

export function getApiConfig() {
    const store = getSettings();
    return store ? store.api : makeDefaultApi();
}

export function saveApiConfig(patch = {}) {
    const store = getSettings();
    if (!store) return;
    store.api = { ...store.api, ...patch };
    persist();
}

export function getUi() {
    const store = getSettings();
    return store ? store.ui : makeDefaultUi();
}

export function saveUi(patch = {}) {
    const store = getSettings();
    if (!store) return;
    store.ui = { ...store.ui, ...patch };
    persist();
}

/**
 * 解析导入的配置模板，兼容三代格式：
 * - v3（本插件）：presets 数组 + gen + jailbreak
 * - v2.x（旧版多方案）：presets 数组 + 顶层兼容副本，任务仅 triggerFloor，含 gen
 * - v1.x（旧版单方案）：无 presets，顶层 tasks/referencePool/startupTask
 */
export function parseImportTemplate(raw) {
    const data = (raw && typeof raw === 'object') ? raw : null;
    if (!data) throw new Error('无效的JSON数据');

    const metaOk = data._meta?.type === 'RUBY_ANALYZER_PRESET';
    const hasPresets = Array.isArray(data.presets) && data.presets.length > 0;
    const hasLegacy = Array.isArray(data.tasks) || Array.isArray(data.referencePool);
    if (!metaOk && !hasPresets && !hasLegacy) {
        throw new Error('不是有效的RUBY配置模板文件');
    }
    if (!hasPresets && !hasLegacy) {
        throw new Error('模板内容为空（未找到方案数据）');
    }

    let presets;
    let activePresetId;
    if (hasPresets) {
        presets = data.presets.map(normalizePreset);
        activePresetId = String(data.activePresetId || '');
    } else if (hasLegacy) {
        const single = normalizePreset({
            id: String(data.activePresetId || 'default'),
            name: '导入的方案',
            description: '',
            referencePool: Array.isArray(data.referencePool) ? data.referencePool : [],
            tasks: Array.isArray(data.tasks) ? data.tasks : [],
            nextTaskId: data.nextTaskId || 1,
            startupTask: (data.startupTask && typeof data.startupTask === 'object') ? data.startupTask : null,
        });
        presets = [single];
        activePresetId = single.id;
    } else {
        presets = [makeDefaultPreset()];
        activePresetId = presets[0].id;
    }
    if (!presets.some((p) => p.id === activePresetId)) {
        activePresetId = presets[0].id;
    }

    return {
        charName: String(data.charName || ''),
        customContentTags: Array.isArray(data.customContentTags)
            ? data.customContentTags.filter((t) => typeof t === 'string' && t.trim())
            : [],
        summaryProvider: ['littlewhitebox', 'shujuku', 'yuzuki'].includes(data.summaryProvider) ? data.summaryProvider : '',
        yuzukiIncludePlot: data.yuzukiIncludePlot !== false,
        jailbreak: data.jailbreak || null,
        gen: (data.gen && typeof data.gen === 'object') ? data.gen : {},
        presets,
        activePresetId,
        sourceVersion: String(data._meta?.version || '未知'),
        sourceTime: String(data._meta?.exportTime || ''),
        presetCount: presets.length,
        taskCount: presets.reduce((sum, p) => sum + (p.tasks || []).length, 0),
    };
}
