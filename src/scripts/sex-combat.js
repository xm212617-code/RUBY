import { registerCardScript } from '../script-registry.js';
import { ctx, h } from '../env.js';
import { buildSexCombatDocument } from './sex-combat-view.js';

const SCRIPT_ID = 'sex-combat';
const PROMPT_REGEX_ID = 'ruby-sex-combat-v1';
const RENDER_REGEX_ID = 'ruby-sex-combat-render-v1';
const TAG = /^[A-Za-z][\w:-]{0,63}$/;
const DEFAULTS = {
    enabled: false,
    defaultJudgment: true,
    trigger: { tag: 'SceneInfo', field: '场景类型', value: 'NSFWH' },
    roster: { tag: 'SceneInfo', field: '在场角色' },
    rosterFormat: 'yaml-list',
    actionTag: 'report',
    marker: 'xingdou',
    markerAnchor: 'report',
    markerPlacement: 'after-anchor-end',
    defaultExperience: 10,
    characters: [],
};

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeName(value) {
    return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function experience(value, fallback = 10) {
    return (typeof value === 'number' || (typeof value === 'string' && value.trim()))
        && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback;
}

function tag(value, fallback) {
    return typeof value === 'string' && TAG.test(value.trim()) ? value.trim() : fallback;
}

function text(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/** Detached, JSON-safe script settings. Runtime and UI share these defaults. */
export function normalizeSexCombatConfig(input = {}) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const trigger = {
        tag: tag(source.trigger?.tag, DEFAULTS.trigger.tag),
        field: text(source.trigger?.field, DEFAULTS.trigger.field),
        value: text(source.trigger?.value, DEFAULTS.trigger.value),
    };
    const roster = { tag: tag(source.roster?.tag, DEFAULTS.roster.tag), field: text(source.roster?.field, DEFAULTS.roster.field) };
    const actionTag = tag(source.actionTag, DEFAULTS.actionTag);
    let marker = tag(source.marker, DEFAULTS.marker);
    const reserved = [trigger.tag, actionTag, roster.tag].map((name) => name.toLowerCase());
    if (reserved.includes(marker.toLowerCase())) marker = ['xingdou', 'ruby-sex-combat-marker', 'ruby-sex-combat-marker-2', 'ruby-sex-combat-marker-3'].find((name) => !reserved.includes(name));
    const defaultExperience = experience(source.defaultExperience);
    const seen = new Set();
    const characters = [];
    for (const entry of Array.isArray(source.characters) ? source.characters : []) {
        const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
        const key = normalizeName(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        characters.push({ name, experience: experience(entry.experience, defaultExperience) });
    }
    return {
        enabled: source.enabled === true,
        defaultJudgment: typeof source.defaultJudgment === 'boolean' ? source.defaultJudgment : true,
        trigger,
        roster,
        rosterFormat: ['yaml-list', 'json', 'loose'].includes(source.rosterFormat) ? source.rosterFormat : DEFAULTS.rosterFormat,
        actionTag,
        marker,
        markerAnchor: source.markerAnchor === 'trigger' || source.markerAnchor === trigger.tag ? 'trigger' : 'report',
        markerPlacement: 'after-anchor-end',
        defaultExperience,
        characters,
    };
}

function validate(config) {
    const errors = [];
    for (const [label, name] of [['启动', config.trigger?.tag], ['角色列表', config.roster?.tag], ['行动', config.actionTag], ['标记', config.marker]]) {
        if (!TAG.test(String(name || ''))) errors.push(`${label} XML 标签名格式无效`);
    }
    if (!String(config.trigger?.field || '').trim()) errors.push('启动字段不能为空');
    if (!String(config.trigger?.value || '').trim()) errors.push('启动值不能为空');
    if (!String(config.roster?.field || '').trim()) errors.push('角色字段不能为空');
    if (!['yaml-list', 'json', 'loose'].includes(config.rosterFormat)) errors.push('角色列表格式无效');
    if (!['trigger', 'report'].includes(config.markerAnchor)) errors.push('请选择启动块或行动报告闭合后插入');
    if ([config.trigger?.tag, config.roster?.tag, config.actionTag].some((name) => String(name).toLowerCase() === String(config.marker).toLowerCase())) {
        errors.push('标记名不能与解析标签相同');
    }
    if (experience(config.defaultExperience, -1) < 0) errors.push('默认经验必须是非负有限数');
    const seen = new Set();
    for (const entry of config.characters || []) {
        const key = normalizeName(entry.name);
        if (!key) errors.push('角色名不能为空');
        else if (seen.has(key)) errors.push(`角色重复：${entry.name}`);
        seen.add(key);
        if (experience(entry.experience, -1) < 0) errors.push(`经验无效：${entry.name || '(空名字)'}`);
    }
    return errors;
}

// Preserve offsets while excluding examples and comments from structural matching.
function maskExamples(source) {
    return source.replace(/^[ \t]*(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)[\s\S]*?(?:^[ \t]*\1[ \t]*(?=\r?$)|(?![\s\S]))/gm,
        (match) => match.replace(/[^\r\n]/g, ' '))
        .replace(/<!--[^]*?-->|(`+)[^\r\n]*?\1/g, (match) => match.replace(/[^\r\n]/g, ' '));
}

function blocks(source, name) {
    const pattern = escapeRegex(name);
    const view = maskExamples(source);
    const starts = [...view.matchAll(new RegExp(`<${pattern}(?=[\\s>])[^>]*>`, 'gi'))];
    const ends = [...view.matchAll(new RegExp(`<\\/${pattern}\\s*>`, 'gi'))];
    if (starts.length !== 1 || ends.length !== 1 || ends[0].index < starts[0].index + starts[0][0].length) return null;
    const start = starts[0].index + starts[0][0].length;
    return { content: source.slice(start, ends[0].index), end: ends[0].index + ends[0][0].length };
}

function scalar(value) {
    const raw = String(value).trim();
    if (raw.startsWith('"') && raw.endsWith('"')) {
        try { return JSON.parse(raw); } catch { return raw; }
    }
    if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
    return raw.replace(/[ \t]+#.*$/, '').trim();
}

function field(block, name) {
    if (!block) return { found: false, value: null };
    const body = maskExamples(block.content).trim();
    if (body.startsWith('{')) {
        try {
            const data = JSON.parse(body);
            // Duplicate keys are ambiguous even though JSON.parse accepts the last value.
            const key = escapeRegex(JSON.stringify(name));
            const count = [...body.matchAll(new RegExp(`${key}\\s*:`, 'g'))].length;
            return { found: Object.hasOwn(data, name) && count === 1, value: data[name] };
        } catch { return { found: false, value: null }; }
    }
    const key = escapeRegex(name);
    const rows = body.split(/\r?\n/);
    const re = new RegExp(`^([\\t ]*)(?:${key}|"${key}"|'${key}')[\\t ]*[:：][\\t ]*(.*)$`);
    const matches = rows.map((row, index) => ({ match: row.match(re), index })).filter((item) => item.match);
    if (matches.length !== 1) return { found: false, value: null };
    const { match, index } = matches[0];
    const lines = [match[2]];
    for (let i = index + 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row.trim()) { lines.push(''); continue; }
        const indent = row.match(/^[\t ]*/)[0].length;
        if (indent <= match[1].length && /^\s*[^:：]+[:：]/.test(row) && !/^\s*-\s/.test(row)) break;
        lines.push(row);
    }
    return { found: true, value: lines.join('\n').trim() };
}

function rosterNames(value, format) {
    let values;
    if (Array.isArray(value)) values = value;
    else if (format === 'json') {
        try { values = JSON.parse(String(value)); } catch { return null; }
    } else if (format === 'yaml-list') {
        const raw = String(value ?? '').trim();
        if (!raw || raw === '[]') return [];
        if (raw.startsWith('[')) {
            try { values = JSON.parse(raw); } catch {
                if (!raw.endsWith(']')) return null;
                const items = raw.slice(1, -1).match(/'(?:''|[^'])*'|"(?:\\.|[^"\\])*"|[^,]+/g) || [];
                values = items.map((item) => scalar(item));
            }
        } else {
            const rows = raw.split(/\r?\n/).map((row) => row.trim()).filter((row) => row && !row.startsWith('#'));
            values = rows.map((row) => scalar(row.replace(/^-\s+/, '')));
        }
    } else values = String(value ?? '').split(/[,，;；\r\n]+/);
    if (!Array.isArray(values) || values.some((entry) => typeof entry !== 'string')) return null;
    const seen = new Set();
    return values.map((entry) => String(scalar(entry)).split('|', 1)[0].trim()).filter((name) => {
        const key = normalizeName(name);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Read data only: never evaluate character-supplied JS, YAML constructors or HTML. */
export function parseSexCombatScene(text, input = {}) {
    const config = normalizeSexCombatConfig(input);
    const source = String(text ?? '');
    const triggerBlock = blocks(source, config.trigger.tag);
    const trigger = field(triggerBlock, config.trigger.field);
    const roster = field(config.roster.tag.toLowerCase() === config.trigger.tag.toLowerCase() ? triggerBlock : blocks(source, config.roster.tag), config.roster.field);
    const names = roster.found ? rosterNames(roster.value, config.rosterFormat) : null;
    const report = blocks(source, config.actionTag);
    const errors = [];
    if (!triggerBlock || !trigger.found || typeof trigger.value !== 'string') errors.push('启动块或启动字段缺失、重复或无效');
    if (names === null) errors.push('角色字段缺失、重复或列表格式无效');
    const value = trigger.found && typeof trigger.value === 'string' ? String(scalar(trigger.value)).trim() : null;
    const triggered = value === config.trigger.value;
    return {
        valid: errors.length === 0,
        active: config.enabled && triggered && errors.length === 0,
        triggered,
        value,
        roster: names || [],
        characters: names ? [...names] : [],
        report: report ? report.content.trim() : null,
        actionBlock: report ? report.content.trim() : null,
        errors,
    };
}

/** One owned closing marker after one complete anchor; no tail fallback. */
export function syncSexCombatMarkers(text, input = {}) {
    const config = normalizeSexCombatConfig(input);
    const source = String(text ?? '');
    const re = new RegExp(`<\\/${escapeRegex(config.marker)}\\s*>`, 'gi');
    const matches = [...maskExamples(source).matchAll(re)];
    let clean = source;
    for (const match of matches.reverse()) clean = clean.slice(0, match.index) + clean.slice(match.index + match[0].length);
    if (!parseSexCombatScene(clean, config).active) return clean;
    const anchor = blocks(clean, config.markerAnchor === 'trigger' ? config.trigger.tag : config.actionTag);
    if (!anchor) return clean;
    const before = clean.slice(0, anchor.end).replace(/[ \t\r\n]*$/, '');
    const after = clean.slice(anchor.end).replace(/^[ \t\r\n]*/, '');
    return before + '\n' + `</${config.marker}>` + (after ? '\n' + after : '');
}

export function sexCombatLevelName(value) {
    if (value >= 100) return '魅魔';
    if (value >= 50) return '老手';
    if (value >= 25) return '经验';
    if (value >= 10) return '新手';
    return '处子';
}

/** Stable IDs replace only owned entries; unrelated card Regex are untouched. */
export function buildSexCombatRegexScripts(existing, input = {}) {
    const config = normalizeSexCombatConfig(input);
    const common = {
        findRegex: `/<\\/${escapeRegex(config.marker)}\\s*>/gi`,
        trimStrings: [], placement: [2], disabled: !config.enabled,
        runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null,
    };
    const panel = buildSexCombatDocument(config);
    const owned = new Map([
        [PROMPT_REGEX_ID, { ...common, id: PROMPT_REGEX_ID, scriptName: 'RUBY 性斗标记（prompt 剥除）', replaceString: '', markdownOnly: false, promptOnly: true }],
        [RENDER_REGEX_ID, { ...common, id: RENDER_REGEX_ID, scriptName: 'RUBY 情潮面板（完整 HTML iframe）', replaceString: '```html\n' + panel.replace(/\$/g, '\\$') + '\n```', markdownOnly: true, promptOnly: false }],
    ]);
    const hiddenTags = [...new Set([config.trigger.tag, config.roster.tag, config.actionTag].map((name) => escapeRegex(name)))];
    owned.set('ruby-sex-combat-blocks-display-v1', {
        ...common,
        id: 'ruby-sex-combat-blocks-display-v1',
        scriptName: 'RUBY 性斗场景与行动块（仅显示隐藏）',
        findRegex: `/<(${hiddenTags.join('|')})(?=[\\s>])[^>]*>[\\s\\S]*?<\\/\\1\\s*>/gi`,
        replaceString: '', markdownOnly: true, promptOnly: false,
    });
    const result = [];
    for (const entry of Array.isArray(existing) ? existing : []) {
        if (owned.has(entry?.id) || [PROMPT_REGEX_ID, RENDER_REGEX_ID, 'ruby-sex-combat-blocks-display-v1'].includes(entry?.id)) {
            if (owned.has(entry.id)) { result.push(owned.get(entry.id)); owned.delete(entry.id); }
        } else result.push(structuredClone(entry));
    }
    return result.concat([...owned.values()]);
}

export function isSexCombatRegexReady(character, settings, input = {}) {
    const config = normalizeSexCombatConfig(input);
    if (!config.enabled || !character?.avatar || settings?.disabledExtensions?.includes('regex')) return false;
    if (!settings?.character_allowed_regex?.includes(character.avatar)) return false;
    const enabled = new Set((character.data?.extensions?.regex_scripts || []).filter((entry) => !entry?.disabled).map((entry) => entry?.id));
    return enabled.has(PROMPT_REGEX_ID) && enabled.has(RENDER_REGEX_ID);
}

export function isSexCombatRegexMetadataReady(character, settings, input = {}) {
    const config = normalizeSexCombatConfig(input);
    if (!character?.avatar || settings?.disabledExtensions?.includes('regex')) return false;
    if (!settings?.character_allowed_regex?.includes(character.avatar)) return false;
    const enabled = new Set((character.data?.extensions?.regex_scripts || []).filter((entry) => !entry?.disabled).map((entry) => entry?.id));
    return enabled.has(PROMPT_REGEX_ID) && enabled.has(RENDER_REGEX_ID);
}

async function installRegex(input, target) {
    const c = ctx();
    const characterId = c?.characterId;
    const character = c?.characters?.[characterId];
    if (characterId === undefined || characterId === null || !character || typeof c?.writeExtensionField !== 'function') {
        throw new Error('请在支持写回的角色卡聊天中安装 Regex。');
    }
    if (!target?.avatar || target.avatar !== character.avatar) {
        throw new Error('角色卡已切换，请在目标角色卡重新安装 Regex。');
    }
    const settings = c.extensionSettings;
    if (!settings) throw new Error('无法读取 Scoped Regex 授权设置；请在 Regex 扩展设置中手动启用此角色。');
    if (settings.disabledExtensions?.includes('regex')) throw new Error('Regex 扩展当前已全局禁用，请先在 ST 扩展设置中启用 Regex。');
    const scripts = buildSexCombatRegexScripts(character.data?.extensions?.regex_scripts, input);
    await c.writeExtensionField(characterId, 'regex_scripts', scripts);
    const current = ctx();
    if (current?.characters?.[current?.characterId]?.avatar !== target.avatar) {
        throw new Error('角色卡在写入期间切换，Regex 已写入原角色卡；当前角色未授权，请切回原卡查看。');
    }
    character.data ||= {};
    character.data.extensions ||= {};
    character.data.extensions.regex_scripts = scripts;
    settings.character_allowed_regex ||= [];
    if (!settings.character_allowed_regex.includes(character.avatar)) {
        settings.character_allowed_regex.push(character.avatar);
        c.saveSettingsDebounced?.();
    }
}

function buildConfigPanel(root, context, current, message = '') {
    const config = normalizeSexCombatConfig(current ?? context.data?.cardScripts?.[SCRIPT_ID]);
    const currentContext = ctx();
    const regexReady = isSexCombatRegexReady(currentContext?.characters?.[currentContext?.characterId], currentContext?.extensionSettings, config);
    const input = (id, label, value, type = 'text') => `<label class="form-row"><span class="form-label">${label}</span><input id="${id}" class="w200" type="${type}" ${type === 'number' ? 'min="0" step="any"' : ''} value="${h(value)}"></label>`;
    root.innerHTML = `<div class="form-section"><div class="form-header blue">通用性斗</div><div class="form-body">
        <p class="tip">Ruby 状态机负责结算；Scoped Regex 负责渲染消息内小 UI，并从模型 prompt 剥除结束标记。安装时仅授权当前角色的 scoped Regex，不会开启全局禁用的 Regex 扩展。</p>
        <div id="sc-regex-status" class="status-box ${regexReady ? '' : 'error'}">消息内小 UI 与标记过滤：${regexReady ? '已启用' : '未启用；点击保存并安装 Regex 后生效'}</div>
        <label class="form-row"><span class="form-label">启用脚本</span><input id="sc-enabled" type="checkbox" ${config.enabled ? 'checked' : ''}></label>
        <div class="form-header blue">启动判断</div>
        ${input('sc-trigger-tag', 'XML 标签', config.trigger.tag)}${input('sc-trigger-field', '字段', config.trigger.field)}${input('sc-trigger-value', '启动值', config.trigger.value)}
        <label class="form-row"><span class="form-label">默认判断蓝灯</span><input id="sc-default-judgment" type="checkbox" ${config.defaultJudgment ? 'checked' : ''}></label>
        <button type="button" id="sc-judgment" class="btn outline small">${config.defaultJudgment ? '关闭' : '启用'}默认判断蓝灯并保存</button>
        <p class="tip">蓝灯条目由 RUBY 运行时安装与开关；此处保存 defaultJudgment 配置。</p>
        <div class="form-header blue">当前角色解析</div>
        ${input('sc-roster-tag', 'XML 标签', config.roster.tag)}${input('sc-roster-field', '角色字段', config.roster.field)}
        <label class="form-row"><span class="form-label">列表格式</span><select id="sc-roster-format">${[['yaml-list', 'YAML 列表'], ['json', 'JSON 数组'], ['loose', '逗号 / 分号 / 换行']].map(([value, label]) => `<option value="${value}" ${config.rosterFormat === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <p class="tip">YAML 支持带或不带连字符的换行姓名，可加 |服装；JSON 支持字符串数组。重复或未闭合 XML 块不触发。</p>
        <div class="form-header blue">行动报告与显示标记</div>
        ${input('sc-action-tag', '行动 XML', config.actionTag)}${input('sc-marker', '标记名称', config.marker)}
        <label class="form-row"><span class="form-label">插入锚点</span><select id="sc-marker-anchor"><option value="report" ${config.markerAnchor === 'report' ? 'selected' : ''}>行动报告闭合后</option><option value="trigger" ${config.markerAnchor === 'trigger' ? 'selected' : ''}>启动 XML 闭合后</option></select></label>
        <p class="tip">标记独占一行，仅在所选完整锚点后插入；无锚点不插入、不回退。安装时同步隐藏场景、角色与行动 XML 的聊天显示，原文和 prompt 保留。改名后请更新 Regex。</p>
        <div class="form-header blue">默认经验与角色底账</div>
        ${input('sc-default-exp', '未登记经验', config.defaultExperience, 'number')}<span id="sc-default-level">${sexCombatLevelName(config.defaultExperience)}</span>
        <div id="sc-character-list">${config.characters.map((entry, index) => `<div class="form-row" data-character="${index}"><input class="sc-name w200" aria-label="角色名" value="${h(entry.name)}"><input class="sc-exp w120" aria-label="经验次数" type="number" min="0" step="any" value="${entry.experience}"><span class="sc-level">${sexCombatLevelName(entry.experience)}</span><button type="button" class="sc-del btn red small" data-index="${index}">删除</button></div>`).join('') || '<p class="tip">未登记角色默认经验 10，可调整。</p>'}</div>
        <div class="form-row sc-character-add-row"><input id="sc-character-name" class="w200" aria-label="新增角色名" placeholder="角色名"><input id="sc-character-exp" class="w120" aria-label="新增经验" type="number" min="0" step="any" value="${config.defaultExperience}"><span id="sc-new-level">${sexCombatLevelName(config.defaultExperience)}</span><button type="button" id="sc-character-add" class="btn outline small">添加角色</button></div>
        <div class="btn-row sc-save-row"><button type="button" id="sc-save" class="btn blue">保存脚本配置</button><button type="button" id="sc-install-regex" class="btn outline">保存并安装 / 更新卡片 Regex</button></div>
        <div id="sc-feedback" class="status-box" role="status">${h(message || '可连续添加、修改或删除角色，数量不限；完成后点击保存。等级随经验实时显示。')}</div>
    </div></div>`;

    const value = (id) => root.querySelector(`#${id}`).value.trim();
    const checked = (id) => root.querySelector(`#${id}`).checked;
    const feedback = (message, failed = false) => {
        const node = root.querySelector('#sc-feedback');
        node.textContent = message;
        node.classList.toggle('error', failed);
    };
    function readForm() {
        return {
            ...config, enabled: checked('sc-enabled'), defaultJudgment: checked('sc-default-judgment'),
            trigger: { tag: value('sc-trigger-tag'), field: value('sc-trigger-field'), value: value('sc-trigger-value') },
            roster: { tag: value('sc-roster-tag'), field: value('sc-roster-field') },
            rosterFormat: value('sc-roster-format'), actionTag: value('sc-action-tag'), marker: value('sc-marker'),
            markerAnchor: value('sc-marker-anchor'), defaultExperience: value('sc-default-exp'),
            characters: [...root.querySelectorAll('[data-character]')].map((row) => ({ name: row.querySelector('.sc-name').value.trim(), experience: row.querySelector('.sc-exp').value })),
        };
    }
    let saving = false;
    async function saveDraft(draft, withRegex = false) {
        if (saving) return;
        const errors = validate(draft);
        if (errors.length) { feedback(errors.join('；'), true); return; }
        saving = true;
        try {
            const c = withRegex ? ctx() : null;
            const target = { avatar: c?.characters?.[c?.characterId]?.avatar };
            const next = normalizeSexCombatConfig(draft);
            const result = await context.save((scriptConfig) => { Object.assign(scriptConfig, next); });
            if (result === false || result?.ok === false) throw new Error(result?.errors?.join('；') || result?.message || '配置保存失败');
            if (withRegex) await installRegex(next, target);
            buildConfigPanel(root, context, next, withRegex ? '配置已保存，面板显示与 prompt 剥除 Regex 已更新。' : '脚本配置已保存。');
        } catch (error) { feedback(`${withRegex ? '保存 / 安装' : '保存'}失败：${error?.message || error}`, true); }
        finally { saving = false; }
    }
    root.querySelector('#sc-save').addEventListener('click', () => saveDraft(readForm()));
    root.querySelector('#sc-install-regex').addEventListener('click', () => saveDraft(readForm(), true));
    root.querySelector('#sc-judgment').addEventListener('click', () => {
        const draft = readForm();
        draft.defaultJudgment = !draft.defaultJudgment;
        return saveDraft(draft);
    });
    root.querySelector('#sc-default-judgment').addEventListener('change', () => {
        root.querySelector('#sc-judgment').textContent = `${checked('sc-default-judgment') ? '关闭' : '启用'}默认判断蓝灯并保存`;
    });
    root.querySelector('#sc-character-add').addEventListener('click', () => {
        const draft = readForm();
        draft.characters.push({ name: value('sc-character-name'), experience: value('sc-character-exp') });
        const errors = validate(draft);
        if (errors.length) { feedback(errors.join('；'), true); return; }
        buildConfigPanel(root, context, draft, `已添加角色，共 ${draft.characters.length} 名；尚未保存，请完成编辑后点击保存。`);
    });
    root.querySelectorAll('.sc-del').forEach((button) => button.addEventListener('click', () => {
        const draft = readForm();
        draft.characters.splice(Number(button.dataset.index), 1);
        buildConfigPanel(root, context, draft, `已删除角色，剩余 ${draft.characters.length} 名；尚未保存。`);
    }));
    root.querySelectorAll('[data-character]').forEach((row) => row.querySelector('.sc-exp').addEventListener('input', (event) => {
        row.querySelector('.sc-level').textContent = experience(event.target.value, -1) < 0 ? '无效经验' : sexCombatLevelName(Number(event.target.value));
    }));
    for (const [id, label] of [['sc-default-exp', 'sc-default-level'], ['sc-character-exp', 'sc-new-level']]) {
        root.querySelector(`#${id}`).addEventListener('input', () => {
            root.querySelector(`#${label}`).textContent = experience(value(id), -1) < 0 ? '无效经验' : sexCombatLevelName(Number(value(id)));
        });
    }
}

registerCardScript({
    id: SCRIPT_ID,
    name: '通用性斗',
    description: '场景触发、角色列表、情潮面板标记、默认判断蓝灯与经验底账。',
    render(root, context) { buildConfigPanel(root, context); },
});
