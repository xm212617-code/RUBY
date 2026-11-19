import { ctx, warn } from '../env.js';
import { isAgentMode } from '../agent-mode.js';
import { resolveConfig } from '../config.js';
import { readVerifiedEntries, writeVerifiedEntry } from '../worldbook.js';
import { isSexCombatRegexMetadataReady, normalizeSexCombatConfig, parseSexCombatScene, syncSexCombatMarkers } from './sex-combat.js';
import { renderSexCombatContent } from './sex-combat-view.js';

const PREFIX = 'RUBY_UniversalSexCombat_';
const KEYS = { state: PREFIX + '当局', exp: PREFIX + '经验总档', level: PREFIX + '等级_', judgment: PREFIX + '默认判断', report: PREFIX + '战况', protocol: PREFIX + 'report协议', guidance: PREFIX + '扮演约束', open: PREFIX + '开局', stage: PREFIX + '阶段状态', end: PREFIX + '收场_' };
const ENDINGS = ['user高潮', '女方反应指南', '对手高潮', '疲软收场', 'user胜利终局', '不应期指南'];
const PLACEMENTS = new Map([
    [KEYS.judgment, { position: 4, depth: 0, order: 991 }],
    [KEYS.report, { position: 4, depth: 1, order: 899 }],
    [KEYS.protocol, { position: 4, depth: 0, order: 990 }],
    [KEYS.guidance, { position: 4, depth: 0, order: 989 }],
    [KEYS.open, { position: 4, depth: 1, order: 900 }],
    [KEYS.stage, { position: 4, depth: 1, order: 898 }],
    ...ENDINGS.map((name, i) => [KEYS.end + name, { position: 4, depth: 1, order: [894, 890, 895, 893, 892, 891][i] }]),
]);
export const SEX_COMBAT_LEVELS = [
    { name: '处子', floor: 0, min: 0, charge: 5 },
    { name: '新手', floor: 10, min: 12, charge: 4 },
    { name: '经验', floor: 25, min: 25, charge: 3 },
    { name: '老手', floor: 50, min: 37, charge: 2 },
    { name: '魅魔', floor: 100, min: 50, charge: 1 },
];
const levelIndex = (count) => SEX_COMBAT_LEVELS.reduce((index, level, i) => count >= level.floor ? i : index, 0);
const stageOf = (ex) => Math.max(1, Math.min(5, 1 + Math.floor(ex / 20)));
const nameKey = (name) => String(name || '').normalize('NFKC').trim().replace(/^(['"])([\s\S]*)\1$/, '$2').replace(/[\s（）()·・.。－-]/g, '').toLocaleLowerCase();
const nameEq = (a, b) => nameKey(a) === nameKey(b);
const isPlayerName = (name, aliases = []) => ['user', '{{user}}', ...aliases].some((alias) => nameKey(alias) && nameEq(name, alias));
const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (value) => JSON.parse(JSON.stringify(value));
const stripFences = (text) => String(text || '').replace(/^[ \t]*(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?(?:^[ \t]*\1[ \t]*\r?$|(?![\s\S]))/gm, '');

/** Same bounded YAML action grammar as the repaired county implementation. */
export function parseSexCombatReport(text, tag = 'report', playerNames = []) {
    const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const source = stripFences(text);
    const blocks = [...source.matchAll(new RegExp(`<${escaped}>([\\s\\S]*?)<\\/${escaped}>`, 'gi'))];
    if (blocks.length !== 1 || (source.match(new RegExp(`<\\/?${escaped}>`, 'gi')) || []).length !== 2) return null;
    const out = Object.create(null);
    let current, seen;
    for (const raw of blocks[0][1].split(/\r?\n/)) {
        if (!raw.trim() || /^\s*#/.test(raw)) continue;
        const indent = raw.length - raw.trimStart().length;
        const pair = raw.trim().match(/^([^:：]+)[:：]\s*(.*)$/);
        if (!pair) return null;
        if (indent === 0) {
            current = pair[1].trim();
            if (isPlayerName(current, playerNames)) current = 'user';
            if (pair[2].trim() || Object.keys(out).some((name) => nameEq(name, current))) return null;
            out[current] = { 单向: 0, 双向: 0, targets: [] };
            seen = new Set();
        } else {
            if (!current || indent < 2 || !/^\d+$/.test(pair[2])) return null;
            const action = pair[1].trim().match(/^(单向|双向)(?:\s*->\s*(.+))?$/);
            if (!action) return null;
            const target = isPlayerName(action[2], playerNames) ? 'user' : action[2]?.trim();
            const key = action[1] + ':' + nameKey(target);
            if (seen.has(key)) return null;
            seen.add(key);
            const count = Math.min(Number(pair[2]), action[1] === '单向' ? 3 : 2);
            if (target) out[current].targets.push({ kind: action[1], name: target, count });
            else out[current][action[1]] = count;
        }
    }
    return Object.keys(out).length ? out : null;
}

/** Dependency injection keeps the real host lifecycle testable without iframe/UI. */
export function createScriptRuntime(dependencies = {}) {
    const getContext = dependencies.getContext || ctx;
    const getConfig = dependencies.getConfig || resolveConfig;
    const read = dependencies.read || readVerifiedEntries;
    const write = dependencies.write || writeVerifiedEntry;
    const host = dependencies.host || globalThis.window;
    const random = dependencies.random || Math.random;
    const sessions = new Map();
    let queue = Promise.resolve(), initialized = false, timer, activeSession;
    const bindings = [];
    const subscribedEvents = new Set();
    const enqueue = (fn) => { const task = queue.then(fn); queue = task.catch(() => {}); return task; };
    const die = (faces) => 1 + Math.floor(random() * faces);
    const dice = (count, faces) => { let total = 0; for (let i = 0; i < count; i++) total += die(faces); return total; };
    function playerNames() {
        const c = getContext(), names = [c?.name1];
        try { names.push(c?.substituteParams?.('{{user}}')); } catch { /* name1 remains available if macro expansion fails. */ }
        return names.filter((name) => typeof name === 'string' && name.trim());
    }
    function identity(c) { return c?.chatId == null || c.chatId === '' ? null : JSON.stringify([c.characterId, c.groupId, String(c.chatId)]); }
    function reportError(error) { (dependencies.onError || warn)('script runtime:', error?.message || String(error)); }
    function configForCard() {
        const result = getConfig();
        const raw = result?.data?.cardScripts?.['sex-combat'];
        return { exists: result?.layer === 'character' && raw != null, config: normalizeSexCombatConfig(raw) };
    }
    function hasInstalledRegex(c, config) {
        const character = c?.characters?.[c.characterId];
        const scripts = character?.data?.extensions?.regex_scripts;
        if (!character?.avatar || !Array.isArray(scripts) || !isSexCombatRegexMetadataReady(character, c.extensionSettings, config)) return false;
        const escapedMarker = String(config.marker).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = `/<\\/${escapedMarker}\\s*>/gi`;
        const prompt = scripts.find((entry) => entry?.id === 'ruby-sex-combat-v1');
        const render = scripts.find((entry) => entry?.id === 'ruby-sex-combat-render-v1');
        return prompt?.scriptName === 'RUBY 性斗标记（prompt 剥除）'
            && prompt.findRegex === pattern && prompt.replaceString === ''
            && prompt.markdownOnly === false && prompt.promptOnly === true
            && JSON.stringify(prompt.placement) === '[2]'
            && render?.id === 'ruby-sex-combat-render-v1'
            && render.findRegex === pattern && render.markdownOnly === true
            && render.promptOnly === false
            && typeof render.replaceString === 'string'
            && render.replaceString.startsWith('```html\n<!doctype html>')
            && render.replaceString.includes('data-ruby-sex-combat="true"')
            && render.replaceString.includes('sc-board')
            && render.replaceString.includes('sc-pairs')
            && render.replaceString.includes('sc-gauges')
            && render.replaceString.includes('sc-fatigue')
            && render.replaceString.includes('ruby-sex-combat-view-request')
            && render.replaceString.includes('</html>\n```')
            && JSON.stringify(render.placement) === '[2]';
    }
    function canRun(c, card = configForCard()) {
        return Boolean(c && card.exists && hasInstalledRegex(c, card.config));
    }
    function sessionFor(c) {
        const key = identity(c);
        if (!key) return null;
        let session = sessions.get(key);
        if (!session || session.origin.chatMetadata !== c.chatMetadata) {
            session = makeSession(c, key);
            sessions.set(key, session);
        }
        activeSession = session;
        return session;
    }
    function makeSession(origin, key) {
        const s = { origin, state: null, levels: Object.create(null), ready: false, dirty: false, known: new Set(), published: new Map(), receipts: {}, lockedThrough: -1, scan: 0, config: null, error: '', generating: false, epoch: 0 };
        const guard = () => {
            const current = getContext();
            if (identity(current) !== key || current.chatMetadata !== origin.chatMetadata || current.characterId !== origin.characterId || current.groupId !== origin.groupId) throw new Error('chat or character changed');
        };
        const io = { origin, guard };
        async function records(exactKey, all = false) {
            guard();
            const found = await read('chat', exactKey, { all, primaryOnly: !all }, io);
            guard();
            if (!Array.isArray(found)) throw new Error('invalid worldbook read');
            return all ? found : found.filter((record) => record.keys?.[0] === exactKey);
        }
        async function put(entryKey, content, placement = {}, constant = false) {
            guard();
            const result = await write('chat', { key: entryKey, content, constant, disable: !constant, position: 1, depth: 1, order: 100, ...placement, primaryOnly: true, syncPlacement: true, normalizeActivation: true }, io);
            guard();
            if (!result || !Number.isInteger(result.uid) || !result.book) throw new Error('worldbook write failed: ' + entryKey);
            if (PLACEMENTS.has(entryKey) || entryKey.startsWith(KEYS.end + '对手高潮_')) s.known.add(entryKey);
        }
        function count(name) {
            if (Object.hasOwn(s.levels, name)) return s.levels[name];
            const configured = s.config.characters.find((entry) => nameEq(entry.name, name));
            return configured?.experience ?? (name === 'user' ? 0 : s.config.defaultExperience);
        }
        async function hydrate(names) {
            for (const name of new Set(['user', ...names])) {
                if (Object.hasOwn(s.levels, name)) continue;
                const [record] = await records(KEYS.level + name);
                const match = record?.content?.match(/(?:经验|次数)[:：]\s*(\d+)/);
                s.levels[name] = match ? Math.min(100, Number(match[1])) : count(name);
            }
        }
        async function restore() {
            const all = await records(PREFIX, true);
            for (const record of all) {
                const primary = record.keys?.[0];
                if (PLACEMENTS.has(primary) || primary?.startsWith(KEYS.end + '对手高潮_')) s.known.add(primary);
            }
            const [exp] = await records(KEYS.exp);
            for (const line of String(exp?.content || '').split(/\r?\n/)) {
                const match = line.trim().match(/^([^:：]+)[:：]\s*(\d+)\s*$/);
                if (match) s.levels[match[1].trim()] = Math.min(100, Number(match[2]));
            }
            const [record] = await records(KEYS.state);
            let saved;
            try { saved = record?.content?.trim() ? JSON.parse(record.content) : null; } catch { /* XP snapshot remains recoverable. */ }
            if (saved?.version === 2 || saved?.version === 3) {
                const st = saved.state;
                if (!st || (st.user && Array.isArray(st.opps) && st.opps.length <= 6 && Number.isFinite(st.p))) {
                    s.state = st;
                    for (const [name, value] of Object.entries(saved.levels || {})) if (Number.isFinite(value) && value >= 0) s.levels[name] = Math.min(100, Math.floor(value));
                    s.lockedThrough = saved.lockedThrough ?? st?.lastSettledFloor ?? -1;
                    s.receipts = saved.receipts || {};
                    s.scan = saved.scan ?? Math.max(0, st?.scanFloor ?? st?.startFloor ?? 0);
                }
            } else if (saved?.user && Array.isArray(saved.opps) && Number.isFinite(saved.p) && !saved.cleared) {
                s.state = saved;
                if (saved.ended) saved.xpApplied = true;
                s.lockedThrough = saved.lastSettledFloor ?? -1;
                s.scan = saved.scanFloor ?? saved.startFloor ?? 0;
            }
            if (s.state) {
                s.state.nsfwhFloors ??= Object.keys(s.state.participation || {}).map(Number);
                for (const opponent of s.state.opps) opponent.p ??= s.state.p;
            }
            s.ready = true;
            s.dirty = Boolean(s.state || s.known.size);
        }
        function rollP(user, opponent) {
            const low = SEX_COMBAT_LEVELS[user].min, high = 100 - SEX_COMBAT_LEVELS[opponent].min;
            return high <= low ? low : Math.round(low + (high - low) * ((die(100) + die(100)) / 2) / 100);
        }
        function begin(floor, names) {
            const userLevel = levelIndex(count('user'));
            const strongest = Math.max(0, ...names.map((name) => levelIndex(count(name))));
            const p = rollP(userLevel, strongest);
            s.state = { active: true, battleId: key + ':' + floor, startFloor: floor, lastSettledFloor: floor - 1, scanFloor: floor, round: 0, p, nsfwhFloors: [], user: { pos: 0, ex: 0, lv: userLevel }, opps: names.map((name) => { const lv = levelIndex(count(name)); return { name, lv, p: names.length === 1 ? p : rollP(userLevel, lv), pos: 100, ex: 0, exited: false, present: true }; }), ended: null };
        }
        function rollHit(actor, defender) {
            const raw = die(100), stage = stageOf(actor.ex);
            const total = raw + 40 + actor.lv * 10 + (stageOf(defender.ex) >= 3 ? 15 : 0) + (stage === 3 ? 10 : stage >= 4 ? -10 : 0);
            return raw >= 96 ? '妙手' : total < 50 ? '严重失手' : total < 100 ? '部分失手' : '得手';
        }
        function netPush(actor, defender, verdict, single, actorStage, defenderStage) {
            let n = actor.lv + 1 + (single ? Number(actorStage >= 2) + Number(actorStage >= 4) + Number(actorStage >= 5) : 0);
            if (verdict === '部分失手') n = Math.ceil(n / 2);
            return Math.max(0, dice(n, 6) - dice(defender.lv + 1 + Number(defenderStage >= 4), 4)) + (verdict === '妙手' ? 10 : 0);
        }
        function d1(name) { return '<情潮指南 类型="不应期" 角色="' + name + '">\n扮演指导：' + name + '已进入不应期——生理状态：敏感度大幅钝化，性刺激不再引发反应，甚至带来不适；体力与润滑一同退潮。\n写：不应期的身体事实、余韵中的情绪、慢慢恢复常态的过程。\n不写：任何由性刺激引发的反应——不应期里硬起、湿润、再度高潮都不成立。\n</情潮指南>'; }
        function bOpp(name) { return '<情潮收场 类型="对手高潮" 角色="' + name + '">\n写作指导：' + name + '已经高潮，进入不应期——写其高潮后的状态与余韵，具体表现由其性格与人设决定。禁止写其继续任何主动性行为；此后只写余韵反应。\n</情潮收场>'; }
        function finish(type) {
            const st = s.state;
            if (!st?.active) return;
            st.active = false;
            st.ended = { type, names: type === 'opp' ? st.opps.map((o) => o.name) : [] };
            st.endedFloor = st.lastSettledFloor;
            if (!st.xpApplied) {
                for (const name of new Set(['user', ...st.opps.map((o) => o.name)])) s.levels[name] = Math.min(100, count(name) + st.nsfwhFloors.length);
                st.xpApplied = true;
            }
            st.endEntries = [];
            const add = (suffix, text) => st.endEntries.push({ key: KEYS.end + suffix, text });
            const rivals = st.opps.filter((o) => !o.exited && o.present !== false).map((o) => o.name).join('、') || '对方';
            if (type === 'opp') add('对手高潮', st.opps.map((o) => bOpp(o.name)).join('\n'));
            if (type === 'user') {
                add('user高潮', '<情潮收场 类型="user高潮" 角色="user">\n写作指导：user已经高潮，进入不应期——写其不应期状态，禁止再写任何性器接触或继续性行为。\n' + rivals + '尚有余力，反应按其性格与人设择一而写：假高潮作弄 / 出言嘲讽 / 搂着安慰 / 口头认下 / 其他符合人设的从容反应。\n</情潮收场>');
                add('女方反应指南', '<情潮指南 类型="user高潮后反应" 角色="' + rivals + '">\n扮演指导：user已高潮进入不应期——' + rivals + '还没到顶，身体悬在半途，但她得先处理眼前这个人。\n她的反应由性格与人设决定，几种混着来也可以：可能是假高潮，跟着叫、装作也到顶，但破绽要看得出来——节奏对不上、眼神清明、事后自己拆穿或被人察觉；可能是嘲讽，居高临下地点破他的快与少，话里带刺又带笑；可能是失望，没被满足的意犹未尽不掩饰，也懒得多演；可能是宽慰，搂着说没事、这很正常，软话多于戏弄；也可能只是照顾，收拾、递水、擦汗，话不多。\n催促不在事后——它发生在他还动着的最后几秒：怎么不动了、好难受、快动动。等他真的射了，才接上那句"哦哦你射了啊，挺舒服的"，或者"啊？你怎么射了"——够没够到，全写在她接话的那一瞬间。\n先从人设里定下她此刻最可能的那一种或几种，再落笔；不要平均地演。\n</情潮指南>');
            }
            if (type === 'flaccid') add('疲软收场', '<情潮收场 类型="疲软收场">\n写作指导：双方均进入不应期——勃起消退、阴道润滑减少，性行为在生理上无法继续。写双方的不应期状态与这场性事的收束（停下、休息、清理）。无人达到高潮。禁止写继续性行为。\n</情潮收场>');
            if (type === 'userWin') add('user胜利终局', '<情潮收场 类型="user胜利终局">\n写作指导：在场的对手已全部高潮并进入不应期——写user的状态与从容。此后由user按其性格决定如何对待不应期中的众人；各对手只写余韵反应，无主动行为。\n</情潮收场>');
            add('不应期指南', [...(type === 'opp' ? [] : ['user']), ...st.opps.map((o) => o.name)].map(d1).join('\n'));
        }
        function settle(rep, floor) {
            const st = s.state, user = st.user;
            if (!st.active || !rep || floor <= st.lastSettledFloor) return;
            const roster = [{ name: 'user', actor: user }, ...st.opps.filter((o) => !o.exited && o.present !== false).map((o) => ({ name: o.name, actor: o }))];
            const actionFor = (name) => rep[Object.keys(rep).find((other) => nameEq(name, other))];
            if (!roster.some(({ name }) => { const a = actionFor(name); return a && (a.单向 + a.双向 > 0 || a.targets.some((t) => t.count > 0)); })) return;
            st.round++;
            st.lastSettledFloor = floor;
            const distance = (actor) => actor === user ? st.p - actor.pos : actor.pos - actor.p;
            const charged = new Set(), fallen = [], results = [];
            let userClimax = distance(user) <= 0;
            const push = (actor, amount) => { actor.pos = actor === user ? Math.min(st.p, actor.pos + amount) : Math.max(actor.p, actor.pos - amount); };
            const gain = (actor, base, verdict) => { const amount = base + (distance(actor) <= 15 ? 3 : 0); actor.ex = Math.min(100, actor.ex + (verdict === '部分失手' ? Math.ceil(amount / 2) : amount)); charged.add(actor); };
            for (const { name, actor } of roster) {
                const action = actionFor(name);
                if (!action || actor.exited) continue;
                for (const kind of ['单向', '双向']) {
                    let remaining = kind === '单向' ? 3 : 2;
                    const choices = action.targets.filter((t) => t.kind === kind);
                    if (action[kind]) choices.push({ count: action[kind] });
                    for (const choice of choices) {
                        const n = Math.min(remaining, choice.count); remaining -= n;
                        const target = choice.name ? roster.find((r) => r.actor !== actor && !r.actor.exited && nameEq(r.name, choice.name)) : actor === user ? roster.find((r) => r.actor !== user && !r.actor.exited) : roster.find((r) => r.actor === user);
                        if (!target) continue;
                        const defender = target.actor;
                        for (let i = 0; i < n; i++) {
                            if (actor.exited || defender.exited || userClimax) break;
                            const aStage = stageOf(actor.ex), dStage = stageOf(defender.ex), single = kind === '单向';
                            const peer = actor !== user && defender !== user;
                            const verdict = peer ? '得手' : rollHit(actor, defender);
                            results.push(`${name} → ${target.name} ${kind}：${peer ? '已结算' : verdict}`);
                            if (verdict === '严重失手') continue;
                            push(defender, netPush(actor, defender, verdict, single, aStage, dStage));
                            if (single) gain(defender, SEX_COMBAT_LEVELS[defender.lv].charge + die(4), verdict);
                            else {
                                push(actor, netPush(defender, actor, verdict, false, dStage, aStage));
                                gain(defender, 2, verdict); gain(actor, 2, verdict);
                            }
                            for (const participant of [actor, defender]) if (participant !== user && distance(participant) === 0) { participant.exited = true; fallen.push(participant.name); }
                            if (distance(user) === 0) userClimax = true;
                        }
                    }
                }
            }
            for (const { actor } of roster) if (!actor.exited && !charged.has(actor) && actor.ex < 80) actor.ex = Math.max(0, actor.ex - 2);
            st.results = results;
            if (userClimax) finish('user');
            else if (st.opps.every((o) => o.exited)) finish(st.opps.length === 1 ? 'opp' : 'userWin');
            else if (st.round >= 10) finish('flaccid');
            else if (fallen.length) {
                const previous = new Map((st.endEntries || []).map((e) => [e.key, e.text]));
                st.endEntries = [{ key: KEYS.end + '对手高潮', text: fallen.map(bOpp).join('\n') }, { key: KEYS.end + '不应期指南', text: fallen.map(d1).join('\n') }].map((e) => ({ ...e, text: [previous.get(e.key), e.text].filter(Boolean).join('\n') }));
            }
        }
        function protocol() {
            const { actionTag: tag, trigger, roster } = s.config;
            const active = s.state?.active;
            const names = active ? s.state.opps.filter((o) => !o.exited && o.present !== false).map((o) => o.name) : ['对手姓名'];
            const examples = ['user', ...names].flatMap((name) => [name + ':', '  单向: 0', '  双向: 0']);
            return [
                '<report协议>',
                `本轮输出的 <${trigger.tag}> 中「${trigger.field}」为「${trigger.value}」且有实际参与的对手时，必须在正文与场景块之后、回复最末尾输出且只输出一个 <${tag}> 块；首次进入该场景的回复同样必须申报。非启动场景不输出该块。`,
                active ? '当前申报名单：user、' + names.join('、') + '。按本轮实际在场情况更新，不添加离场或已退出者。' : `对手段名取本轮 <${roster.tag}> 的「${roster.field}」实际姓名；“对手姓名”只是占位，不得照抄。`,
                '格式模板如下：user段名固定写user，不替换为玩家姓名；每个实际参与者独立一段，键名固定为单向、双向，使用半角冒号和两空格缩进。',
                '<' + tag + '>', examples.join('\n'), '</' + tag + '>',
                '模板中的0表示无行动。按本楼正文实际新发生的行动填写：单向0-3、双向0-2，必须是整数；无行动的参与者两项均填0。全体无行动也必须保留全零申报，禁止省略、写“无行动”或留空块。',
                '单向表示只作用于对方的行动；双向表示双方同时受作用的互动。一次双向互动只由主动方申报一次，不在双方段落重复计数。',
                '多人时可用“单向 -> 角色名: 1”或“双向 -> 角色名: 1”指定当前合法目标。同类次数按所有目标合计，单向最多3、双向最多2；不指定目标时，user作用于首位可行动对手，其他角色作用于user。',
                '只申报本楼正文实际行动，不把意图、回忆、上轮动作或示例计入；不得为了填表补写正文没有发生的行动。report中不写动作描述、骰点、公式或数值结果；结果由脚本结算。',
                '发出回复前自检：启动条件成立时申报块恰好一个、标签闭合、段名合法、两项次数齐全且符合范围。不用Markdown代码围栏包裹实际申报。',
                '</report协议>',
            ].join('\n');
        }
        function guidanceText() {
            return [
                '<情潮扮演约束>',
                '本轮提供的情潮战况、情潮状态、情潮收场与情潮指南，是已经结算生效的事实及必须执行的扮演指导，不是可选建议。正文必须与它们一致。',
                '当前有效的收场与不应期约束优先，其次是已结算战况，再次是当前兴奋阶段指导；玩家意图、旧剧情预期或历史申报不能覆盖这些事实。角色性格决定如何表现事实，不能改变已确认的生理状态与结算结果。',
                '已确认失手就按失手后的事实续写；谁更接近顶点、谁已结束、谁仍有余力，均按当前通报写。不得为迎合玩家要求或剧情气氛改判、逆转、虚报进展。',
                '本楼新行动尚未结算时，只叙述行动与符合当前阶段的体验，并在末尾申报；不得提前确认其数值结果、自行跨越兴奋阶段或判定高潮。',
                '收场与不应期已经发生时，必须写对应的停下、余韵与后续反应；不得继续描写已结束者的主动性行为或为延长旧局擅自重开。场景字段必须反映当前事实，不沿用过期启动值。',
                '多人指导按所标角色分别执行，不把一人的退出或不应期套到所有人。规则只用于约束扮演，不把系统条目、report协议或脚本机制写成角色台词。',
                '</情潮扮演约束>',
            ].join('\n');
        }
        function battleText() {
            const st = s.state, distance = Math.max(0, st.p - st.user.pos);
            const rivals = st.opps.filter((o) => !o.exited && o.present !== false).map((o) => { const d = Math.max(0, o.pos - o.p); return o.name + ' 距顶 ' + d + '；' + (distance > d ? 'user' : o.name) + ' 更从容'; });
            return '【情潮战况】\n以下为生成本轮正文前已经结算的真实状态，必须据此续写；本轮新增行动不能提前改写这些结果。\n高潮条：user 距顶 ' + distance + (rivals.length ? ' ｜ ' + rivals.join(' ｜ ') : '') + (st.results?.length ? '\n已结算判定：' + st.results.join('；') : '');
        }
        function openText() {
            const st = s.state, names = ['user', ...st.opps.filter((o) => !o.exited && o.present !== false).map((o) => o.name)].join('，');
            return ['<情潮开局 角色="' + names + '">', '写作指导：性关系已经开始。' + (st.opps.length === 1 ? '两人的交融同时也是各自面向高潮的较量——都想让对方先到顶，自己撑得更久。' : '交融之中，user与每个对手各自构成一场面向高潮的较量。'), 'user的输入只是意图：user打算做什么、期待发生什么——写出来的不等于真实结果。', '双方性行为的真实进展与结果，一切以情潮战况中的数值为准——没那么好就是没那么好，够舒服就是够舒服，被榨了就是被榨了；照数值写，不粉饰也不强行翻转，不动摇双方的从容关系。', '必须执行当前阶段和收场指导，不自行判定谁更接近顶点，不自行描写高潮的发生，不虚报任何进展。', '你的职责是氛围与体感：动作、反应、气息、声音、节奏——数值之外的血肉由你来长。', '启动场景的每楼末尾必须按 report 协议申报，无行动也明确填0，不得省略。', '</情潮开局>'].join('\n');
        }
        function stageText() {
            return [{ name: 'user', ...s.state.user }, ...s.state.opps.filter((o) => !o.exited && o.present !== false)].map((o) => {
                const stage = stageOf(o.ex);
                const text = stage === 3 ? o.name + '进入急促阶段。状态：单向行动增多，动作更密更贴，节奏也更快。' : stage === 4 ? o.name + '的兴奋值升到阶段④。状态：转为主动，开始抢主导——单向行动明显变多，双向里也不肯落下风。' : stage === 5 ? o.name + '进入燃尽阶段。状态：单向行动最盛，顶格状态持续到本局结束。' : o.name + (stage === 2 ? '当前处于微热阶段。' : '当前处于平静阶段。');
                return '<情潮状态 角色="' + o.name + '" 阶段="' + stage + '" 进度="' + o.ex + '/100">\n必须按当前阶段扮演：' + text + '具体反应保持角色人设，不擅自跳到其他阶段或把阶段状态写成已经高潮。\n</情潮状态>';
            }).filter(Boolean).join('\n');
        }
        function judgmentText() {
            const config = s.config, trigger = config.trigger, roster = config.roster;
            const sameBlock = roster.tag.toLowerCase() === trigger.tag.toLowerCase();
            const format = config.rosterFormat === 'json' ? 'JSON 字符串数组' : config.rosterFormat === 'loose' ? '逗号、分号或换行分隔的角色名字' : 'YAML 换行列表，建议每行「- 角色名」；也接受省略连字符，可在名字后加 |服装';
            const example = (value) => {
                const names = ['角色甲', '角色乙'];
                if (config.rosterFormat === 'json') {
                    const fields = { [trigger.field]: value };
                    if (sameBlock) fields[roster.field] = names;
                    const first = `<${trigger.tag}>\n${JSON.stringify(fields, null, 2)}\n</${trigger.tag}>`;
                    return sameBlock ? first : first + `\n<${roster.tag}>\n${JSON.stringify({ [roster.field]: names }, null, 2)}\n</${roster.tag}>`;
                }
                const rosterLine = config.rosterFormat === 'loose'
                    ? `${roster.field}：角色甲，角色乙`
                    : `${roster.field}：\n- 角色甲\n- 角色乙`;
                const first = `<${trigger.tag}>\n${trigger.field}：${value}${sameBlock ? '\n' + rosterLine : ''}\n</${trigger.tag}>`;
                return sameBlock ? first : first + `\n<${roster.tag}>\n${rosterLine}\n</${roster.tag}>`;
            };
            const inactiveValue = trigger.value === 'SFW' ? 'NSFW' : 'SFW';
            return [
                '<场景与角色判断>',
                '每次回复在正文之外输出一个 <' + trigger.tag + '> 块，其中「' + trigger.field + '」字段记录当前场景类型。',
                '只有真正发生性行为、性器接触时，该字段才可写为「' + trigger.value + '」；仅暧昧、裸露、准备、事后休息均不满足，应写为 SFW 或 NSFW 等非启动值。',
                (sameBlock ? '同一块内' : '另输出一个 <' + roster.tag + '> 块，') + '用「' + roster.field + '」字段列出当前实际在场角色，格式为' + format + '。',
                '角色名单只列实际在场的对手，不列user、{{user}}或玩家角色名；玩家始终由系统单独管理。不把回忆、想象、提及但不在场的人加入。',
                '严格参照以下完整格式输出，标签必须成对闭合、字段名保持不变。不要用 Markdown 代码围栏包裹实际输出。',
                '示例姓名仅示范格式；实际输出请替换成当前在场角色的真实姓名，不要照抄“角色甲/角色乙”。这里只要求场景与角色字段，不要额外照搬其它卡的地点或时间字段。',
                '【未达到启动条件的输出示例】',
                example(inactiveValue),
                '【确实满足启动条件的输出示例】',
                example(trigger.value),
                '每轮只输出当前真实状态对应的一组，禁止同时输出两种示例；启动值必须逐字写为「' + trigger.value + '」。',
                '</场景与角色判断>',
            ].join('\n');
        }
        async function publish(desired) {
            if (s.config.enabled && s.config.defaultJudgment) desired.set(KEYS.judgment, judgmentText());
            if (s.config.enabled && (s.config.preSceneProtocol || s.state?.active)) desired.set(KEYS.protocol, protocol());
            for (const entryKey of new Set([...s.known, ...desired.keys()])) {
                const text = desired.get(entryKey) || '', placement = PLACEMENTS.get(entryKey) || { position: 4, depth: 1, order: 895 };
                const fingerprint = JSON.stringify([text, placement]);
                if (s.published.get(entryKey) === fingerprint) continue;
                await put(entryKey, text, placement, Boolean(text));
                s.published.set(entryKey, fingerprint);
            }
        }
        function desiredEntries() {
            const desired = new Map();
            if (s.state?.active) { desired.set(KEYS.report, battleText()); desired.set(KEYS.open, openText()); desired.set(KEYS.stage, stageText()); }
            if (s.state && !s.state.endConsumed) for (const entry of s.state.endEntries || []) desired.set(entry.key, entry.text);
            if (s.state?.active || (s.state && !s.state.endConsumed && s.state.endEntries?.length)) desired.set(KEYS.guidance, guidanceText());
            return desired;
        }
        async function persist() {
            await put(KEYS.state, JSON.stringify({ version: 3, state: s.state, levels: s.levels, lockedThrough: s.lockedThrough, receipts: s.receipts, scan: s.scan }));
            await publish(desiredEntries());
            const names = Object.keys(s.levels), exp = names.map((name) => '  ' + name + ': ' + s.levels[name]).join('\n');
            if (names.length && s.savedExp !== exp) {
                await put(KEYS.exp, exp);
                for (const name of names) await put(KEYS.level + name, '等级: ' + SEX_COMBAT_LEVELS[levelIndex(s.levels[name])].name + '\n经验: ' + s.levels[name]);
                s.savedExp = exp;
            }
            s.dirty = false;
        }
        function clear(resetLedger = false) {
            s.state = null; s.scan = 0; s.dirty = true; s.prompt = null; s.signature = null;
            if (resetLedger) { s.receipts = {}; s.lockedThrough = -1; }
        }
        async function tick(config, preparing = false) {
            if (isAgentMode(getContext())) return;
            guard(); s.config = config;
            if (!s.ready) await restore();
            if (!config.enabled) {
                s.scene = null;
                if (s.state) { clear(); await persist(); }
                else await publish(new Map());
                s.signature = null;
                return;
            }
            const aliases = playerNames();
            // Older checkpoints may contain the expanded player name as a second combatant.
            // Repair identities without replaying settled actions or changing genuine opponent stats.
            if (s.state?.opps.some((o) => isPlayerName(o.name, aliases))) {
                s.state.opps = s.state.opps.filter((o) => !isPlayerName(o.name, aliases));
                s.state.results = [];
                s.dirty = true;
                if (!s.state.opps.length) clear();
            }
            if (s.dirty) await persist();
            const c = getContext();
            if (!Array.isArray(c.chat) || (!preparing && (s.generating || (c.streamingProcessor && !c.streamingProcessor.isFinished)))) return;
            let last = c.chat.length - 1;
            while (last >= 0 && (c.chat[last]?.is_user || c.chat[last]?.is_system || c.chat[last]?.extra?.ruby_agent)) last--;
            if (last < 0) { if (s.state || s.lockedThrough >= 0) { clear(true); await persist(); } else await publish(new Map()); return; }
            const sceneFor = (text) => {
                const scene = parseSexCombatScene(text, config);
                const names = scene.characters.filter((name) => !isPlayerName(name, aliases)).slice(0, 6);
                return { ...scene, roster: names, characters: names };
            };
            // Refresh the visible roster even when this floor has already been settled and locked.
            s.scene = sceneFor(c.chat[last].mes);
            const signature = JSON.stringify([last, c.chat[last].swipe_id, c.chat[last].mes, config, aliases]);
            if (s.signature === signature) return;
            if (s.state?.startFloor > last) clear();
            const start = s.state ? Math.min(s.scan, last) : last;
            for (let floor = start; floor <= last; floor++) {
                const message = c.chat[floor];
                if (!message || message.is_user || message.is_system || message.extra?.ruby_agent || floor <= s.lockedThrough) continue;
                const signature = JSON.stringify([floor, message.swipe_id, message.mes]);
                if (signature === s.failedReply) continue;
                const scene = sceneFor(message.mes);
                s.scene = scene;
                if (!scene.active) { if (s.state) clear(); await publish(new Map()); break; }
                const names = scene.characters;
                if (!names.length) { if (s.state) clear(); await publish(new Map()); break; }
                if (s.state?.ended) { if (!s.state.endConsumed) break; s.state = null; }
                if (s.state && !names.some((name) => s.state.opps.some((o) => nameEq(o.name, name)))) s.state = null;
                await hydrate(names);
                if (!s.state) begin(floor, names);
                else {
                    s.state.opps.forEach((o) => { o.present = names.some((name) => nameEq(name, o.name)); });
                    for (const name of names) if (s.state.opps.length < 6 && !s.state.opps.some((o) => nameEq(o.name, name))) { const lv = levelIndex(count(name)); s.state.opps.push({ name, lv, p: rollP(s.state.user.lv, lv), pos: 100, ex: 0, exited: false, present: true }); }
                }
                const st = s.state;
                if (!st.nsfwhFloors.includes(floor)) st.nsfwhFloors.push(floor);
                const rep = parseSexCombatReport(message.mes, config.actionTag, aliases);
                s.dirty = true;
                if (!rep) { s.scan = floor === last ? floor : floor + 1; st.scanFloor = s.scan; continue; }
                settle(rep, floor);
                s.scan = st.lastSettledFloor === floor || floor < last ? floor + 1 : floor;
                st.scanFloor = s.scan;
                if (st.lastSettledFloor === floor) { s.lockedThrough = floor; s.receipts[floor] = JSON.stringify([message.swipe_id, message.mes]); }
                if (st.ended) break;
            }
            if (s.dirty) await persist();
            else await publish(desiredEntries());
            s.signature = signature;
        }
        return Object.assign(s, { guard, tick, persist, clear });
    }
    function render() {
        // The Regex-owned standalone HTML iframe requests state through the message bridge below.
    }
    function viewSnapshot() {
        const c = getContext();
        const card = configForCard();
        const key = identity(c);
        const session = key ? sessions.get(key) : null;
        if (!card.exists || !session || !canRun(c, card)) return null;
        return clone({ configured: true, state: session.state, levels: session.levels, scene: session.scene, defaultExperience: session.config?.defaultExperience ?? card.config.defaultExperience ?? 10, error: session.error });
    }
    function respondToView(event) {
        const data = event?.data;
        if (data?.type !== 'ruby-sex-combat-view-request' || typeof data.nonce !== 'string' || data.nonce.length > 160 || !event.source) return;
        const frames = host?.document?.querySelectorAll?.('#chat .mes .mes_text iframe') || [];
        const frame = [...frames].find((candidate) => candidate.isConnected !== false && candidate.contentWindow === event.source);
        if (!frame) return;
        let owned = String(frame.getAttribute?.('srcdoc') || '').includes('data-ruby-sex-combat="true"');
        try { owned ||= Boolean(frame.contentDocument?.querySelector('[data-ruby-sex-combat="true"]')); } catch { /* Isolated documents use their srcdoc marker. */ }
        if (!owned) return;
        const c = getContext();
        const card = configForCard();
        if (!canRun(c, card) || !identity(c)) return;
        const snapshot = viewSnapshot() || Object.freeze({ configured: true, state: null, levels: {}, scene: null, error: '' });
        event.source.postMessage({ type: 'ruby-sex-combat-view-state', nonce: data.nonce, identity: identity(c), html: renderSexCombatContent(snapshot) }, event.origin && event.origin !== 'null' ? event.origin : '*');
    }
    async function tick(preparing = false) {
        const c = getContext(), card = configForCard();
        if (!c || !identity(c)) return;
        if (!card.exists) {
            const previous = sessions.get(identity(c));
            if (previous?.ready && (previous.state || previous.known.size)) await previous.tick({ ...previous.config, enabled: false });
            activeSession = null; render(); return;
        }
        if (!canRun(c, card)) { activeSession = null; render(); return; }
        const session = sessionFor(c);
        try { await session.tick(card.config, preparing); session.error = ''; }
        catch (error) { session.error = error?.message || String(error); throw error; }
        finally { if (identity(getContext()) === identity(c)) render(); }
    }
    function syncMarkers(messageId) {
        const c = getContext(), card = configForCard();
        if (!canRun(c, card) || !Array.isArray(c?.chat)) return;
        if (c.streamingProcessor && !c.streamingProcessor.isFinished) return;
        const id = Number.isInteger(Number(messageId)) && Number(messageId) >= 0 ? Number(messageId) : c.chat.length - 1;
        const message = c.chat[id];
        if (!message || message.is_user || message.is_system) return;
        let source = message.mes;
        const previousMarker = message.extra?.rubySexCombatMarker;
        if (previousMarker && previousMarker !== card.config.marker) source = syncSexCombatMarkers(source, { ...card.config, enabled: false, marker: previousMarker });
        const next = syncSexCombatMarkers(source, card.config);
        message.extra ||= {};
        message.extra.rubySexCombatMarker = card.config.marker;
        if (next === message.mes) return;
        message.mes = next;
        c.updateMessageBlock?.(id, message);
        Promise.resolve(c.saveChat?.()).catch(reportError);
    }
    function listen(events, type, listener) {
        if (!type || subscribedEvents.has(type)) return;
        subscribedEvents.add(type);
        events.on(type, listener);
        bindings.push(() => events.removeListener?.(type, listener));
    }
    async function before(type, options, dryRun) {
        if (dryRun || type === 'quiet' || type === 'impersonate') return;
        const c = getContext(), card = configForCard();
        if (!canRun(c, card) || !identity(c)) return;
        try {
            await enqueue(async () => {
                if (identity(getContext()) !== identity(c) || getContext()?.chatMetadata !== c.chatMetadata) throw new Error('chat or character changed');
                await tick(true);
                const session = sessionFor(c); session.guard();
                session.epoch++; session.generating = true; session.built = false; session.signal = options?.signal;
                session.prompt = session.state?.endEntries?.length ? { state: session.state, entries: session.state.endEntries } : null;
            });
        } catch (error) { if (identity(getContext()) === identity(c)) c.stopGeneration?.(); reportError(error); throw error; }
    }
    async function received(id, type) {
        const c = getContext(), session = sessions.get(identity(c));
        if (type === 'quiet' || type === 'impersonate') return;
        const stream = c?.streamingProcessor, message = c?.chat?.[id];
        if (session?.signal?.aborted || (stream && (stream.isStopped || !stream.isFinished || stream.abortController?.signal?.aborted))) return;
        if (session?.generating && session.built && message && !message.is_user && !message.is_system && String(message.mes || '').trim()) {
            const delivery = session.prompt;
            session.generating = false; session.prompt = null; session.built = false; session.failedReply = null;
            await enqueue(async () => {
                session.guard();
                if (delivery && session.state === delivery.state && session.state.endEntries === delivery.entries) { session.state.endConsumed = Boolean(session.state.ended); session.state.endEntries = []; session.dirty = true; await session.persist(); }
            });
        }
        if (identity(getContext()) !== identity(c) || getContext()?.chatMetadata !== c?.chatMetadata) return;
        syncMarkers(id);
        await enqueue(() => tick());
    }
    function init() {
        if (initialized) return;
        const c = getContext();
        if (!c?.eventSource || !c?.eventTypes) return;
        initialized = true;
        const events = c.eventSource, types = c.eventTypes;
        const safe = (fn) => (...args) => Promise.resolve(fn(...args)).catch(reportError);
        if (host?.addEventListener) {
            host.addEventListener('message', respondToView);
            bindings.push(() => host.removeEventListener('message', respondToView));
        }
        listen(events, types.GENERATION_AFTER_COMMANDS, before);
        listen(events, types.GENERATE_AFTER_DATA, (_data, dryRun) => { const session = sessions.get(identity(getContext())); if (!dryRun && session?.generating) session.built = true; });
        listen(events, types.MESSAGE_RECEIVED, safe(received));
        listen(events, types.GENERATION_ENDED, () => {
            const c = getContext(), session = sessions.get(identity(c));
            if (!session?.generating) return;
            const last = c.chat?.length - 1, message = c.chat?.[last], epoch = session.epoch;
            session.failedReply = message ? JSON.stringify([last, message.swipe_id, message.mes]) : null;
            setTimeout(() => { if (session.epoch === epoch) { session.generating = false; session.built = false; session.prompt = null; } }, 0);
        });
        listen(events, types.GENERATION_STOPPED, () => { const c = getContext(), session = sessions.get(identity(c)); if (session) { const last = c.chat?.length - 1, m = c.chat?.[last]; session.failedReply = m ? JSON.stringify([last, m.swipe_id, m.mes]) : null; session.epoch++; session.generating = false; session.built = false; session.prompt = null; } });
        for (const type of [types.CHAT_CHANGED, types.CHARACTER_SELECTED]) listen(events, type, safe(() => {
            for (const session of sessions.values()) { session.epoch++; session.generating = false; session.built = false; session.prompt = null; }
            activeSession = null;
            syncMarkers(); return enqueue(() => tick());
        }));
        for (const type of [types.MESSAGE_UPDATED, types.MESSAGE_SWIPED, types.MESSAGE_DELETED]) listen(events, type, safe((id) => { syncMarkers(id); return enqueue(() => tick()); }));
        if (host?.addEventListener) { const changed = safe(() => { syncMarkers(); return enqueue(() => tick()); }); host.addEventListener('ruby:config-changed', changed); bindings.push(() => host.removeEventListener('ruby:config-changed', changed)); }
        if (dependencies.poll !== false) {
            let pending = false;
            timer = setInterval(() => {
                if (pending) return;
                pending = true;
                syncMarkers();
                enqueue(() => tick()).catch(reportError).finally(() => { pending = false; });
            }, 1000);
        }
        syncMarkers(); enqueue(() => tick()).catch(reportError);
    }
    return { init, tick: () => enqueue(() => tick()), syncMarkers, before, received, snapshot: () => activeSession ? clone({ state: activeSession.state, levels: activeSession.levels, scene: activeSession.scene, error: activeSession.error }) : null, dispose() { for (const unbind of bindings.splice(0)) unbind(); subscribedEvents.clear(); clearInterval(timer); initialized = false; } };
}

let runtime;
export function initScriptRuntime() { runtime ||= createScriptRuntime(); runtime.init(); return runtime; }
export function syncScriptMarkers(messageId) { runtime?.syncMarkers(messageId); }
export function getScriptRuntimeState() { return runtime?.snapshot() || null; }
