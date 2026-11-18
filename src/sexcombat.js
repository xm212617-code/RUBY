// ═══════════════════════════════════════════════════════════════
// 通用性斗 · RUBY 内置脚本（随卡挂载）
// 启用后：写场景判断蓝灯条目（胶水：分级判定+数值权威，格式教学归卡片规则条目）、
//         装隐藏正则、事件驱动结算、情潮面板随战局出现。
// ═══════════════════════════════════════════════════════════════
import { ctx, log, warn, st } from './env.js';
import * as config from './config.js';

const K = {
    state: '通用性斗_当局',
    report: '通用性斗_战况',
    rule: '通用性斗_场景判断',
    open: '通用性斗_开局',
    stage: '通用性斗_阶段状态',
    exp: '通用性斗_经验总档',
    levelPrefix: '通用性斗_等级_',
};

const LEVELS = [
    { name: '处子', min: 0,  floor: 0,   charge: 5 },
    { name: '新手', min: 12, floor: 10,  charge: 4 },
    { name: '经验', min: 25, floor: 25,  charge: 3 },
    { name: '老手', min: 37, floor: 50,  charge: 2 },
    { name: '魅魔', min: 50, floor: 100, charge: 1 },
];
const STAGES = ['平静', '微热', '急促', '激越', '燃尽'];
const HEART = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
const escH = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const d = (n) => 1 + Math.floor(Math.random() * n);
const dice = (count, faces) => { let s = 0; for (let i = 0; i < count; i++) s += d(faces); return s; };


/* ══════════ 脚本库状态（按角色卡，存扩展设置） ══════════ */
function cardKey() {
    const id = config.getCharacterIdentity();
    return id ? id.avatar : null;
}
function isEnabled() {
    const k = cardKey(); if (!k) return false;
    return !!scriptCfg()[k];
}
function setEnabled(v) {
    const k = cardKey(); if (!k) return false;
    scriptCfg()[k] = !!v;
    config.persist();
    return true;
}

/* ══════════ 等级 ══════════ */
function expOf(name) {
    if (SC.exp[name] !== undefined) return SC.exp[name];
    const init = scriptCfg().initialLevels || {};
    if (init[name] !== undefined) return init[name];
    if (name === (scriptCfg().userName || 'user')) return 0;
    return scriptCfg().defaultLevel || 10;
}
function lvIdx(nameOrExp) {
    const n = (typeof nameOrExp === 'number') ? nameOrExp : expOf(nameOrExp);
    let i = 0; LEVELS.forEach((L, k) => { if (n >= L.floor) i = k; }); return i;
}
const lvDef = (i) => LEVELS[Math.max(0, Math.min(4, i))];
const userName = () => scriptCfg().userName || 'user';

/* ══════════ 斜杠与条目（扩展上下文直连） ══════════ */
async function run(cmd) {
    const c = ctx();
    if (c && typeof c.executeSlashCommands === 'function') {
        const r = await c.executeSlashCommands(cmd);
        return (r === null || r === undefined) ? '' : String(r);
    }
    return String(await st(cmd) ?? '');
}
async function readJSON(key, book) {
    const raw = await run('/ruby "RPC~read~key=' + key + '~json=true~book=' + (book || 'chat') + '"');
    try { return JSON.parse(raw); } catch (e) { return null; }
}
async function writeEntry(key, content, opts) {
    const o = opts || {};
    const v = '_scx_' + Date.now().toString(36) + Math.floor(Math.random() * 999);
    await run('/setvar key=' + v + ' "' + String(content ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\|/g, '｜') + '"');
    let cmd = '/ruby RPC~write~key=' + key + '~var=' + v + '~book=' + (o.book || 'chat') + '~position=' + (o.position === undefined ? 1 : o.position) + '~order=' + (o.order === undefined ? 210 : o.order) + (o.constant !== undefined ? '~constant=' + (o.constant ? 'true' : 'false') : '') + (o.depth !== undefined ? '~depth=' + o.depth : '');
    if (o.comment) cmd += '~comment=' + o.comment;
    await run(cmd);
}

/* ══════════ 隐藏正则（装一次，全局） ══════════ */
function ensureRegexes() {
    const c = ctx(); if (!c) return;
    const es = c.extensionSettings || window.extension_settings;
    if (!es) return;
    es.regex = Array.isArray(es.regex) ? es.regex : [];
    const want = [
        { scriptName: '通用性斗·隐藏情潮XML', findRegex: '<情潮[^>]*>[\\s\\S]*?<\\/情潮[^>]*>', replaceString: '', placement: 1, markdownOnly: true, promptOnly: false, runOnEdit: true, minDepth: null, maxDepth: null, disabled: false },
        { scriptName: '通用性斗·隐藏report', findRegex: '<report>([\\s\\S]*?)<\\/report>', replaceString: '', placement: 1, markdownOnly: true, promptOnly: true, runOnEdit: true, minDepth: null, maxDepth: null, disabled: false },
    ];
    let added = 0;
    for (const w of want) {
        if (!es.regex.some((x) => x.scriptName === w.scriptName)) { es.regex.push({ trimStrings: [], substituteRegex: 0, ...w }); added++; }
    }
    if (added) {
        if (typeof c.saveSettingsDebounced === 'function') c.saveSettingsDebounced();
        log('[性斗] 已注入隐藏正则 ×' + added);
    }
}

/* ══════════ 场景判断（胶水版：分级判定 + 数值权威，格式教学归卡片规则条目） ══════════ */
function ruleText() {
    return [
      '<SceneInfo>',
      '地点：具体地点',
      '时间：YYYY年MM月DD日 周X 时段 HH:MM',
      '场景类型：SFW / NSFW / NSFWH',
      '在场角色：',
      '- 角色名|状态',
      '</SceneInfo>',
      'NSFWH=真正发生性行为（性器相接即算）。NSFWH 楼正文尾部附 <report>。',
    ].join('\n');
  }

  function scriptCfg() {
    store.scripts = store.scripts || {};
    store.scripts.sexcombat = store.scripts.sexcombat || { enabled: false, initialLevels: {}, defaultLevel: 10, userName: 'user' };
    const sc = store.scripts.sexcombat;
    if (sc.defaultLevel === undefined) sc.defaultLevel = 10;
    if (!sc.userName) sc.userName = 'user';
    if (!sc.trigger) sc.trigger = 'nsfwh';
    sc.positions = sc.positions || { reportPos: 1, reportOrder: 210, openPos: 1, openOrder: 900, stagePos: 1, stageOrder: 898, rulePos: 4, ruleOrder: 989 };
    return sc;
}
function isEnabled() {
    const k = cardKey(); if (!k) return false;
    return !!scriptCfg()[k];
}
function setEnabled(v) {
    const k = cardKey(); if (!k) return false;
    scriptCfg()[k] = !!v;
    config.persist();
    return true;
}

/* ══════════ 等级 ══════════ */
function expOf(name) {
    if (SC.exp[name] !== undefined) return SC.exp[name];
    const init = scriptCfg().initialLevels || {};
    if (init[name] !== undefined) return init[name];
    if (name === (scriptCfg().userName || 'user')) return 0;
    return scriptCfg().defaultLevel || 10;
}
function lvIdx(nameOrExp) {
    const n = (typeof nameOrExp === 'number') ? nameOrExp : expOf(nameOrExp);
    let i = 0; LEVELS.forEach((L, k) => { if (n >= L.floor) i = k; }); return i;
}
const lvDef = (i) => LEVELS[Math.max(0, Math.min(4, i))];
const userName = () => scriptCfg().userName || 'user';

/* ══════════ 斜杠与条目（扩展上下文直连） ══════════ */
async function run(cmd) {
    const c = ctx();
    if (c && typeof c.executeSlashCommands === 'function') {
        const r = await c.executeSlashCommands(cmd);
        return (r === null || r === undefined) ? '' : String(r);
    }
    return String(await st(cmd) ?? '');
}
async function readJSON(key, book) {
    const raw = await run('/ruby "RPC~read~key=' + key + '~json=true~book=' + (book || 'chat') + '"');
    try { return JSON.parse(raw); } catch (e) { return null; }
}
async function writeEntry(key, content, opts) {
    const o = opts || {};
    const v = '_scx_' + Date.now().toString(36) + Math.floor(Math.random() * 999);
    await run('/setvar key=' + v + ' "' + String(content ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\|/g, '｜') + '"');
    let cmd = '/ruby RPC~write~key=' + key + '~var=' + v + '~book=' + (o.book || 'chat') + '~position=' + (o.position === undefined ? 1 : o.position) + '~order=' + (o.order === undefined ? 210 : o.order) + (o.constant !== undefined ? '~constant=' + (o.constant ? 'true' : 'false') : '') + (o.depth !== undefined ? '~depth=' + o.depth : '');
    if (o.comment) cmd += '~comment=' + o.comment;
    await run(cmd);
}

/* ══════════ 隐藏正则（装一次，全局） ══════════ */
function ensureRegexes() {
    const c = ctx(); if (!c) return;
    const es = c.extensionSettings || window.extension_settings;
    if (!es) return;
    es.regex = Array.isArray(es.regex) ? es.regex : [];
    const want = [
        { scriptName: '通用性斗·隐藏情潮XML', findRegex: '<情潮[^>]*>[\\s\\S]*?<\\/情潮[^>]*>', replaceString: '', placement: 1, markdownOnly: true, promptOnly: false, runOnEdit: true, minDepth: null, maxDepth: null, disabled: false },
        { scriptName: '通用性斗·隐藏report', findRegex: '<report>([\\s\\S]*?)<\\/report>', replaceString: '', placement: 1, markdownOnly: true, promptOnly: true, runOnEdit: true, minDepth: null, maxDepth: null, disabled: false },
    ];
    let added = 0;
    for (const w of want) {
        if (!es.regex.some((x) => x.scriptName === w.scriptName)) { es.regex.push({ trimStrings: [], substituteRegex: 0, ...w }); added++; }
    }
    if (added) {
        if (typeof c.saveSettingsDebounced === 'function') c.saveSettingsDebounced();
        log('[性斗] 已注入隐藏正则 ×' + added);
    }
}

/* ══════════ 场景判断（胶水版：分级判定 + 数值权威，格式教学归卡片规则条目） ══════════ */
function ruleText() {
    const u = userName();
    return [
        '<通用性斗_场景判断>',
        '场景分级判定：本脚本的触发标记为「' + (scriptCfg().trigger || 'nsfwh') + '」——SceneInfo 场景类型含此标记时性斗启动。',
        '性斗参战者 = 当楼 SceneInfo 在场角色 + ' + u + '，只认这些人。',
        '数值权威：NSFWH 楼的性行为进展与结果，一切以情潮战况中的数值为准——' + u + '的输入只是意图，写出来的不等于真实结果；照数值写，不粉饰也不强行翻转。',
        '终局纪律：任一方到达顶点（情潮战况显示距离顶点归零）即进入不应期——写其不应期状态，禁止继续性行为，等待情潮战况的下一步指示。',
        '</通用性斗_场景判断>',
    ].join('\n');
}

/* ══════════ 状态 ══════════ */
const SC = { state: null, exp: {}, lastFloor: -1, lastSig: '', bound: false, booted: false, levelsReady: false, panel: null };

function rollP(minU, minO) {
    const lo = minU, hi = 100 - minO;
    if (hi <= lo) return lo;
    return Math.round(lo + (hi - lo) * ((d(100) + d(100)) / 2) / 100);
}
function st0() {
    return {
        active: true, startFloor: 0, lastSettledFloor: -1, round: 0, p: 50, scanFloor: 1,
        user: { pos: 0, ex: 0 }, opps: [], ended: null, endedFloor: 0, cleared: false, endEntries: [],
    };
}
function stageOf(ex) { return Math.max(0, Math.min(5, Math.ceil(ex / 20))); }
function newBattle(fl, chars) {
    const old = SC.state;
    const oldEnds = old ? (old.endEntries || []) : [];
    SC.state = st0();
    SC.state.startFloor = fl;
    SC.state.scanFloor = fl + 1;
    SC.state.p = rollP(lvDef(lvIdx(expOf(userName()))).min, lvDef(Math.max.apply(null, chars.map((n) => lvIdx(expOf(n))).concat([lvIdx(expOf(userName()))]))).min);
    SC.state.opps = chars.map((n) => ({ name: n, pos: 100, ex: 0, exited: false, present: true }));
    (async () => {
        const drops = [[K.stage, { constant: false, order: 898 }]];
        oldEnds.forEach((e) => drops.push([e.key, { constant: false, order: e.order }]));
        for (const [k, o] of drops) await writeEntry(k, '', o);
    })();
    return SC.state;
}
function syncRoster(chars) {
    const stx = SC.state; if (!stx || !chars || !chars.length) return;
    stx.opps.forEach((o) => { o.present = chars.indexOf(o.name) >= 0; });
    chars.forEach((n) => {
        if (!stx.opps.some((o) => o.name === n)) {
            stx.opps.push({ name: n, pos: 100, ex: 0, exited: false, present: true });
            log('[性斗] 中途加入：' + n);
        }
    });
}

/* ══════════ 骰子（正式定稿） ══════════ */
function rollHit(atkLv, defLv, defStage, atkStage) {
    const raw = d(100);
    let total = raw + 40 + atkLv * 10;
    if (defStage >= 3) total += 15;
    if (atkStage >= 4) total -= 10;
    if (raw >= 96) return '妙手';
    if (total < 50) return '严重失手';
    if (total < 100) return '部分失手';
    return '得手';
}
function netPush(atkLv, defLv, verdict) {
    if (verdict === '严重失手') return 0;
    let n = atkLv + 1;
    if (verdict === '部分失手') n = Math.ceil(n / 2);
    const net = Math.max(0, dice(n, 6) - dice(defLv + 1, 4));
    return verdict === '妙手' ? net + 10 : net;
}
function charge(targetLv, dist) {
    let c = lvDef(targetLv).charge + d(4);
    if (dist <= 15) c += 3;
    return c;
}

/* ══════════ 申报解析（YAML 层级） ══════════ */
function parseReport(mes) {
    const m = String(mes || '').match(/<report>([\s\S]*?)<\/report>/i);
    if (!m) return null;
    const out = {}; let cur = null;
    m[1].split(/\r?\n/).forEach((raw) => {
        if (!raw.trim() || /^\s*#/.test(raw)) return;
        const indent = (raw.match(/^\s*/) || [''])[0].length;
        const t = raw.trim();
        const kv = t.match(/^([^:：]+)[:：]\s*(.*)$/);
        if (indent === 0) {
            if (!kv) { cur = null; return; }
            cur = kv[1].trim(); if (!out[cur]) out[cur] = { 单向: 0, 双向: 0 }; return;
        }
        if (cur && kv) {
            const k = kv[1].trim(), v = parseInt(kv[2], 10) || 0;
            if (k === '单向' || k === '双向') out[cur][k] = Math.min(v, k === '单向' ? 3 : 2);
        }
    });
    return Object.keys(out).length ? out : null;
}
function parseScene(mes) {
    const m = String(mes || '').match(/<SceneInfo>([\s\S]*?)<\/SceneInfo>/i);
    if (!m) return { hard: false, chars: [] };
    const block = m[1];
    const hard = /nsfwh/i.test(block);
    const cm = block.match(/在场角色[：:]\s*([\s\S]*?)(?=\n\n|\n<\/SceneInfo>|$)/);
    const chars = [];
    if (cm) cm[1].split(/\r?\n/).forEach((line) => {
        const t = line.trim(); if (!t.startsWith('-')) return;
        const name = t.replace(/^-\s*/, '').split('|')[0].trim();
        if (name && name !== userName() && chars.indexOf(name) < 0) chars.push(name);
    });
    return { hard: hard, chars: chars };
}


/* ══════════ 结算（定稿骰机） ══════════ */
function settleRound(rep, floor, c) {
    const stx = SC.state;
    stx.round++; stx.lastSettledFloor = floor;
    syncRoster(parseScene(c.chat[floor] ? c.chat[floor].mes : '').chars);
    const u = userName();
    const target = stx.opps.find((o) => !o.exited && o.present !== false);
    const uRep = rep[u] || { 单向: 0, 双向: 0 };
    const uLv = lvIdx(u), uExp = expOf(u);
    if (target) {
        const tLv = lvIdx(target.name), tExp = expOf(target.name);
        for (let i = 0; i < (uRep.单向 || 0); i++) {
            const v = rollHit(uLv, tLv, stageOf(target.ex), stageOf(stx.user.ex));
            target.pos = Math.max(stx.p, target.pos - netPush(uLv, tLv, v));
            if (v !== '严重失手') target.ex = Math.min(100, target.ex + charge(tLv, target.pos - stx.p));
        }
        for (let i = 0; i < (uRep.双向 || 0); i++) {
            const v = rollHit(uLv, tLv, stageOf(target.ex), stageOf(stx.user.ex));
            target.pos = Math.max(stx.p, target.pos - netPush(uLv, tLv, v));
            stx.user.pos = Math.min(stx.p, stx.user.pos + Math.max(0, dice(tLv + 1, 6) - dice(uLv + 1, 4)));
            target.ex = Math.min(100, target.ex + 2); stx.user.ex = Math.min(100, stx.user.ex + 2);
        }
    }
    stx.opps.forEach((o) => {
        if (o.exited || o.present === false) return;
        const r = rep[o.name]; if (!r) return;
        const oLv = lvIdx(o.name);
        for (let i = 0; i < (r.单向 || 0); i++) {
            const v = rollHit(oLv, uLv, stageOf(stx.user.ex), stageOf(o.ex));
            stx.user.pos = Math.min(stx.p, stx.user.pos + netPush(oLv, uLv, v));
            if (v !== '严重失手') stx.user.ex = Math.min(100, stx.user.ex + charge(uLv, stx.p - stx.user.pos));
        }
        for (let i = 0; i < (r.双向 || 0); i++) {
            const v = rollHit(oLv, uLv, stageOf(stx.user.ex), stageOf(o.ex));
            stx.user.pos = Math.min(stx.p, stx.user.pos + netPush(oLv, uLv, v));
            o.pos = Math.max(stx.p, o.pos - Math.max(0, dice(uLv + 1, 6) - dice(oLv + 1, 4)));
            stx.user.ex = Math.min(100, stx.user.ex + 2); o.ex = Math.min(100, o.ex + 2);
        }
    });
    if (!rep[u] && !(uRep.单向 || uRep.双向)) stx.user.ex = Math.max(0, stx.user.ex - 2);
    stx.opps.forEach((o) => { if (!rep[o.name]) o.ex = Math.max(0, o.ex - 2); });

    if (stx.user.pos >= stx.p) { endBattle('user'); return; }
    const fallen = stx.opps.filter((o) => !o.exited && o.present !== false && o.pos <= stx.p);
    fallen.forEach((o) => { o.exited = true; });
    if (stx.opps.filter((o) => !o.exited && o.present !== false).length === 0) { endBattle('userWin'); return; }
    if (fallen.length) { endBattle('opp', fallen); return; }
    if (stx.round >= 10) endBattle('flaccid');
}
function endBattle(type, extra) {
    const stx = SC.state;
    stx.active = false;
    stx.ended = { type: type, names: (type === 'opp' ? (extra || []).map((o) => o.name) : []) };
    stx.endedFloor = stx.lastSettledFloor;
    const floors = Math.max(1, stx.endedFloor - stx.startFloor + 1);
    const u = userName();
    SC.exp[u] = expOf(u) + floors;
    stx.opps.forEach((o) => { SC.exp[o.name] = expOf(o.name) + floors; });
    log('[性斗] 经验入账：+' + floors + ' →', u + '=' + SC.exp[u], stx.opps.map((o) => o.name + '=' + SC.exp[o.name]).join(', '));
    persist();
}

/* ══════════ 通报与注入文案 ══════════ */
function battleText() {
    const stx = SC.state;
    const uDist = Math.max(0, stx.p - stx.user.pos);
    let minDist = Infinity, minName = '';
    stx.opps.forEach((o) => { if (!o.exited && o.present !== false) { const dd = o.pos - stx.p; if (dd < minDist) { minDist = dd; minName = o.name; } } });
    const calmer = (minDist === Infinity || uDist > minDist) ? u : minName;
    const oppPart = stx.opps.filter((o) => !o.exited && o.present !== false).map((o) => o.name + ' 距离顶点还有' + Math.max(0, o.pos - stx.p)).join(' ｜ ');
    return '【情潮战况】\n高潮条：' + u + ' 距离顶点还有' + uDist + ' ｜ ' + oppPart + '\n从容对比：' + calmer + ' 更从容——写作时据此掌握双方的松紧与节奏。';
}
function openText() {
    const stx = SC.state;
    const roles = [u()].concat(stx.opps.map((o) => o.name)).join('，');
    const solo = stx.opps.length === 1;
    const rival = solo ? '两人的交融同时也是各自面向高潮的较量——都想让对方先到顶，自己撑得更久。' : '交融之中，' + u() + '与每个对手各自构成一场面向高潮的较量。';
    return [
        '<情潮开局 角色="' + roles + '">',
        '写作指导：性关系已经开始。' + rival,
        u() + '的输入只是意图——写出来的不等于真实结果。',
        '双方性行为的真实进展与结果，一切以情潮战况中的数值为准——没那么好就是没那么好，被榨了就是被榨了；照数值写，不粉饰也不强行翻转，不动摇双方的从容关系。',
        '不自行判定谁更接近顶点，不自行描写高潮的发生，不虚报任何进展。',
        '你的职责是氛围与体感：动作、反应、气息、声音、节奏。',
        '每轮正文末尾，按 report 协议附上本轮的申报。',
        '</情潮开局>',
    ].join('\n');
}
function stageTextFor(name, ex) {
    const s = stageOf(ex);
    if (s === 3) return '<情潮状态 角色="' + name + '" 阶段="3" 进度="' + ex + '/100">\n' + name + '的兴奋值已过半。状态：单向行动增多，动作更密更贴，节奏也更快。\n</情潮状态>';
    if (s === 4) return '<情潮状态 角色="' + name + '" 阶段="4" 进度="' + ex + '/100">\n' + name + '的兴奋值升到阶段④。状态：转为主动，开始抢主导——单向行动明显变多，双向里也不肯落下风。\n</情潮状态>';
    if (s === 5) return '<情潮状态 角色="' + name + '" 阶段="5" 进度="' + ex + '/100">\n' + name + '的兴奋值已到顶。状态：单向行动最盛，顶格状态持续到本局结束。\n</情潮状态>';
    return '';
}
function stageText() {
    const stx = SC.state;
    const parts = [stageTextFor(u(), stx.user.ex)];
    stx.opps.forEach((o) => { if (!o.exited && o.present !== false) parts.push(stageTextFor(o.name, o.ex)); });
    return parts.filter(Boolean).join('\n');
}
function d1Text(n) {
    return '<情潮指南 类型="不应期" 角色="' + n + '">\n扮演指导：' + n + '已进入不应期——生理状态：敏感度大幅钝化，性刺激不再引发反应，甚至带来不适。\n写：不应期的身体事实、余韵中的情绪。\n不写：任何由性刺激引发的反应。\n</情潮指南>';
}
function d2Text(n) {
    return '<情潮指南 类型="user高潮后反应" 角色="' + n + '">\n扮演指导：' + n + '还没到顶，身体悬在半途。反应由其性格与人设决定：假高潮（破绽要看得出来）/ 嘲讽 / 失望 / 宽慰 / 照顾；催促发生在他还动着的最后几秒，他射了才接上反应——够没够到，写在接话的那一瞬间。\n</情潮指南>';
}
function bOpp(n) { return '<情潮收场 类型="对手高潮" 角色="' + n + '">\n写作指导：' + n + '已经高潮，进入不应期——写其高潮后的状态与余韵。禁止写其继续任何主动性行为。\n</情潮收场>'; }
function bUser(n) { return '<情潮收场 类型="user高潮">\\n写作指导：' + u() + '已经高潮，进入不应期——禁止再写任何性器接触或继续性行为。\\n' + n + '的反应按其性格与人设择一而写：假高潮作弄 / 出言嘲讽 / 搂着安慰 / 口头认下。\\n</情潮收场>'; }
function bFlaccid() { return '<情潮收场 类型="疲软收场">\n写作指导：双方均进入不应期——性行为在生理上无法继续。写疲软状态与这场性事的收束。无人达到高潮。禁止写继续性行为。\n</情潮收场>'; }
function bWin() { return '<情潮收场 类型="user胜利终局">\n写作指导：在场对手已全部高潮并进入不应期——写' + u() + '的状态与从容，由其决定如何对待不应期中的众人。\n</情潮收场>'; }

/* ══════════ 持久化 ══════════ */
async function persist() {
    const stx = SC.state; if (!stx) return;
    const expLines = Object.keys(SC.exp).map((n) => '  ' + n + ': ' + SC.exp[n]).join('\n');
    await writeEntry(K.exp, expLines, { constant: false, comment: '通用性斗·经验总档（勿读）' });
    stx.opps.forEach((o) => {
        const i = lvIdx(o.name);
        writeEntry(K.levelPrefix + o.name, '等级: ' + LEVELS[i].name + '\n经验: ' + expOf(o.name), { constant: false, comment: '通用性斗·等级（勿读）' });
    });
    writeEntry(K.levelPrefix + u(), '等级: ' + LEVELS[lvIdx(u())].name + '\n经验: ' + expOf(u()), { constant: false, comment: '通用性斗·等级（勿读）' });
    const posCfg = scriptCfg().positions || {};
    if (stx.cleared) {
        for (const k of [K.report, K.rule, K.open, K.stage]) await writeEntry(k, '', { constant: false, position: k === K.rule ? (posCfg.rulePos || 4) : 1, order: k === K.rule ? (posCfg.ruleOrder || 989) : (k === K.stage ? (posCfg.stageOrder || 898) : (posCfg.reportOrder || 210)) });
        (stx.endEntries || []).forEach((e) => { writeEntry(e.key, '', { constant: false, position: 1, order: e.order }); });
    } else {
        await writeEntry(K.report, battleText(), { constant: true, position: posCfg.reportPos || 1, order: posCfg.reportOrder || 210, comment: '情潮战况' });
        if (!stx.ended) {
            await writeEntry(K.open, openText(), { constant: true, position: posCfg.openPos || 1, order: posCfg.openOrder || 900, comment: '情潮开局' });
            await writeEntry(K.stage, stageText(), { constant: true, position: posCfg.stagePos || 1, order: posCfg.stageOrder || 898, comment: '情潮状态' });
            (stx.endEntries || []).forEach((e) => { writeEntry(e.key, '', { constant: false, position: 1, order: e.order }); });
        } else {
            await writeEntry(K.stage, '', { constant: false, order: 898 });
            (stx.endEntries || []).forEach((e) => { writeEntry(e.key, e.text, { constant: true, position: 1, order: e.order, comment: '情潮收场' }); });
        }
    }
}

/* ══════════ tick ══════════ */
async function tick() {
    const c = ctx(); if (!c || !Array.isArray(c.chat) || c.chat.length === 0) return;
    const last = c.chat.length - 1;
    const mesSig = (c.chat[last].mes || '').length + ':' + String(c.chat[last].mes || '').slice(-80);
    if (last === SC.lastFloor && mesSig === SC.lastSig) return;
    SC.lastFloor = last; SC.lastSig = mesSig;
    try {
        const mes = c.chat[last].mes || '';
        if (SC.state && !SC.state.active && !SC.state.cleared && last > SC.state.endedFloor) {
            log('[性斗] 清场 @楼' + last);
            SC.state.cleared = true;
            await persist();
            SC.state = null;
            render();
            return;
        }
        let scan = (SC.state && SC.state.active) ? Math.max(SC.state.scanFloor || SC.state.startFloor, SC.state.startFloor, SC.state.lastSettledFloor + 1) : last;
        for (let f = Math.min(scan, last); f <= last; f++) {
            const msg = c.chat[f]; if (!msg || msg.is_user) continue;
            const m = msg.mes || '';
            const rep = parseReport(m);
            if (SC.state && SC.state.active && !SC.state.ended && rep && f !== SC.state.lastSettledFloor) {
                const scF = parseScene(m);
                const inRoster = scF.chars.some((n) => SC.state.opps.some((o) => o.name === n && !o.exited)) ||
                    Object.keys(rep).some((n) => n !== u() && SC.state.opps.some((o) => o.name === n && !o.exited));
                if (scF.chars.length && !inRoster) restart(f, scF.chars);
                else syncRoster(scF.chars);
                log('[性斗] 结算 report @楼' + f);
                settleRound(rep, f, c);
                if (SC.state.ended) break;
            } else if ((!SC.state || !SC.state.active) && new RegExp(scriptCfg().trigger || 'nsfwh', 'i').test(m)) {
                const sc = parseScene(m);
                if (sc.hard && sc.chars.length) {
                    log('[性斗] 开局 @楼' + f + ' 对手:' + sc.chars.join('、'));
                    newBattle(f, sc.chars);
                    const r0 = parseReport(m);
                    if (r0) settleRound(r0, f, c);
                    if (SC.state.ended) break;
                }
            } else if (SC.state && SC.state.active && !SC.state.ended && new RegExp(scriptCfg().trigger || 'nsfwh', 'i').test(m)) {
                const scF = parseScene(m);
                if (scF.chars.length && !scF.chars.some((n) => SC.state.opps.some((o) => o.name === n && !o.exited))) restart(f, scF.chars);
                else syncRoster(scF.chars);
            }
        }
        if (SC.state) SC.state.scanFloor = Math.max(SC.state.scanFloor || SC.state.startFloor, last + 1);
        await persist();
    } catch (e) {
        warn('[性斗] tick 失败（下轮重试）:', e?.message || e);
    } finally {
        render();
    }
}
function restart(fl, chars) {
    const old = SC.state;
    log('[性斗] 换人重开 @楼' + fl);
    const oldEnds = old ? (old.endEntries || []) : [];
    newBattle(fl, chars);
    (async () => {
        const drops = [[K.stage, { constant: false, order: 898 }]];
        oldEnds.forEach((e) => drops.push([e.key, { constant: false, order: e.order }]));
        for (const [k, o] of drops) await writeEntry(k, '', o);
    })();
}


/* ══════════ 面板 UI ══════════ */
function render() {
    let panel = document.getElementById('ruby_sc_panel');
    if (!panel) return;
    const stx = SC.state;
    if (!stx) { panel.classList.add('scx-absent'); return; }
    panel.classList.remove('scx-absent');
    const inner = panel.querySelector('.scx-inner');
    const uName = u();
    if (stx.ended) {
        const n = (stx.ended.names || []).join('、') || '对方';
        const t = stx.ended.type === 'user' ? '再怎么努力也忍不住了——高潮将至。这一局，' + n + '确实技高一筹。' : stx.ended.type === 'opp' ? n + '已经忍不到了——高潮将至。这一局，' + uName + '确实技高一筹。' : stx.ended.type === 'flaccid' ? '疲软将至——谁也没能赢下谁。' : '全胜收官。';
        inner.innerHTML = '<div class="scx-end">' + escH(t) + '</div>';
        return;
    }
    const uDist = Math.max(0, stx.p - stx.user.pos);
    let bars = '';
    stx.opps.forEach((o) => {
        const dO = Math.max(0, o.pos - stx.p);
        let segs = ''; for (let i = 0; i < 5; i++) segs += '<div class="scx-gseg' + (i < stageOf(o.ex) ? ' s' + stageOf(o.ex) : '') + '"></div>';
        bars += '<div class="scx-opprow' + (o.present === false ? ' gone' : '') + '">' +
            '<div class="scx-oppname">' + escH(o.name) + ' · ' + LEVELS[lvIdx(o.name)].name + (o.present === false ? ' · 未在场' : '') + '</div>' +
            '<div class="scx-climax"><div class="scx-pheart" style="left:' + stx.p + '%">' + HEART + '</div><div class="scx-pline" style="left:' + stx.p + '%"></div>' +
            '<div class="scx-track"><div class="scx-trail user" style="width:' + stx.user.pos + '%"></div><div class="scx-trail opp" style="width:' + (100 - o.pos) + '%"></div>' +
            '<div class="scx-ptr user" style="left:' + stx.user.pos + '%">' + HEART + '</div><div class="scx-ptr opp" style="left:' + o.pos + '%">' + HEART + '</div></div></div>' +
            '<div class="scx-grow"><div class="scx-glabel"><span class="scx-gdot opp"></span>兴奋</div><div class="scx-gsegs">' + segs + '</div><div class="scx-gpill">' + STAGES[Math.max(0, stageOf(o.ex) - 1)] + '</div></div></div>';
    });
    let usegs = ''; for (let i = 0; i < 5; i++) usegs += '<div class="scx-gseg' + (i < stageOf(stx.user.ex) ? ' s' + stageOf(stx.user.ex) : '') + '"></div>';
    inner.innerHTML =
        '<div class="scx-namerow"><div class="scx-chip"><span class="scx-av user">你</span><span>' + escH(uName) + '<small class="scx-lv">' + LEVELS[lvIdx(uName)].name + '</small></span></div>' +
        '<div class="scx-chip"><span class="scx-av opp">彼</span><span>' + escH(stx.opps.map((o) => o.name).join('、')) + '</span></div></div>' +
        bars +
        '<div class="scx-fatigue"><span class="scx-ftag">疲软倒计时</span><div class="scx-ftrack"><div class="scx-ffill" style="width:' + (stx.round * 10) + '%"></div></div><span class="scx-fnum">' + stx.round + '/10</span></div>' +
        '<div class="scx-grow"><div class="scx-glabel"><span class="scx-gdot user"></span>兴奋</div><div class="scx-gsegs">' + usegs + '</div><div class="scx-gpill">' + STAGES[Math.max(0, stageOf(stx.user.ex) - 1)] + '</div></div>';
}
function ensurePanel() {
    if (SC.panel) return;
    const el = document.createElement('div');
    el.id = 'ruby_sc_panel';
    el.className = 'scx-panel scx-absent';
    el.innerHTML = '<style>' + SCX_CSS + '</style>' +
        '<div class="scx-head"><div class="scx-title">' + HEART + ' 情潮</div><span class="scx-sub"></span><span class="scx-chev">▾</span></div>' +
        '<div class="scx-body"><div class="scx-inner"></div></div>';
    document.body.appendChild(el);
    el.querySelector('.scx-head').addEventListener('click', () => el.classList.toggle('scx-folded'));
    SC.panel = el;
}

/* ══════════ 生命周期 ══════════ */
async function ensureRuleEntries() {
    await writeEntry(K.rule, ruleText(), { constant: true, position: 4, depth: 0, order: 989, comment: '通用性斗·场景判断' });
}
async function clearInjections() {
    for (const k of [K.report, K.rule, K.open, K.stage]) await writeEntry(k, '', { constant: false, position: k === K.rule ? 4 : 1, order: k === K.rule ? 989 : 210 });
    SC.exp = {};
}
async function onChatChanged() {
    if (!isEnabled()) { stop(); return; }
    ensureRegexes();
    await ensureRuleEntries();
    const rec = await readJSON(K.state);
    const body = rec && rec.content ? String(rec.content) : '';
    const jm = body.match(/\{[\s\S]*\}/);
    if (jm) { try { SC.state = JSON.parse(jm[0]); } catch (e) {} }
    const expRec = await readJSON(K.exp);
    const eb = expRec && expRec.content ? String(expRec.content) : '';
    (eb || '').split(/\r?\n/).forEach((raw) => {
        const m = raw.trim().match(/^([^:：]+)[:：]\s*(\d+)\s*$/);
        if (m) SC.exp[m[1].trim()] = parseInt(m[2], 10);
    });
    log('[性斗] 场景判断条目已确保，经验已恢复');
    await tick();
}
async function onGenerationEnded() { if (isEnabled()) await tick(); }

function start() {
    if (SC.booted) return;
    SC.booted = true;
    ensurePanel();
    ensureRegexes();
    const c = ctx();
    if (c && c.eventSource && c.eventTypes) {
        if (!SC.bound) {
            SC.bound = true;
            c.eventSource.on(c.eventTypes.GENERATION_ENDED, onGenerationEnded);
            c.eventSource.on(c.eventTypes.CHAT_CHANGED, onChatChanged);
            c.eventSource.on(c.eventTypes.MESSAGE_RECEIVED, (_id, type) => { if (type === 'first_message') onChatChanged(); });
        }
        onChatChanged();
        log('[性斗] 通用性斗已启动（事件驱动）');
    } else warn('[性斗] 事件系统不可用');
}
function stop() {
    (async () => {
        await clearInjections();
        SC.state = null;
        SC.booted = false;
        render();
        log('[性斗] 通用性斗已停用');
    })();
}

/* ══════════ 库 API（settings.js / 沙箱调用） ══════════ */
export function getScriptCfg() { return scriptCfg(); }
export function saveScriptCfg() { config.persist(); }
export function levelNameFor(exp) { return LEVELS[lvIdx(parseInt(exp, 10) || 0)].name; }
export function getLevels() {
    const out = {};
    const init = scriptCfg().initialLevels || {};
    Object.keys(init).forEach((n) => { out[n] = init[n]; });
    Object.keys(SC.exp).forEach((n) => { out[n] = SC.exp[n]; });
    return out;
}
export function setInitialLevel(name, exp) {
    const sc = scriptCfg();
    sc.initialLevels = sc.initialLevels || {};
    sc.initialLevels[String(name).trim()] = parseInt(exp, 10) || 0;
    SC.exp[String(name).trim()] = parseInt(exp, 10) || 0;
    config.persist();
}
export function removeInitialLevel(name) {
    const sc = scriptCfg();
    if (sc.initialLevels) delete sc.initialLevels[name];
    delete SC.exp[name];
    (async () => { try { await writeEntry(K.levelPrefix + name, '', { constant: false, comment: '通用性斗·等级（勿读）' }); } catch (e) {} })();
    config.persist();
}
export function entryWrite(key, content, opts) { return writeEntry(key, content, opts); }
export async function entryRead(key, book) { return readJSON(key, book); }
export function getStatus() {
    const k = cardKey();
    return { supported: !!k, enabled: isEnabled(), cardName: k ? (config.getCharacterIdentity().name || '') : '' };
}
export async function toggle() {
    const v = !isEnabled();
    setEnabled(v);
    if (v) start(); else stop();
    return isEnabled();
}
export function init() {
    if (isEnabled()) start();
    else if (SC.booted) stop();
}

/* ══════════ 面板样式 ══════════ */
const SCX_CSS = `
  .scx-panel { position: fixed; left: 12px; bottom: 12px; z-index: 9000; width: min(520px, 92vw);
    border: 1px solid #f6cfda; border-radius: 14px; background: linear-gradient(165deg,#fff8fa,#ffe4ec);
    box-shadow: 0 14px 34px rgba(180,60,110,.25); font-family: system-ui, sans-serif; color: #6d3549; overflow: hidden; }
  .scx-panel.scx-absent { display: none; }
  .scx-head { display: flex; align-items: center; gap: 8px; padding: 9px 14px; cursor: pointer; border-bottom: 1px solid #f6cfda; background: rgba(255,255,255,.5); }
  .scx-title { display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 13px; }
  .scx-title svg { width: 13px; height: 13px; }
  .scx-sub { flex: 1; font-size: 10px; color: #bd8fa0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .scx-inner { padding: 10px 14px; display: flex; flex-direction: column; gap: 9px; }
  .scx-opprow.gone { opacity: .38; filter: grayscale(.6); }
  .scx-oppname { font-size: 10.5px; font-weight: 700; margin-bottom: 2px; }
  .scx-climax { position: relative; padding: 16px 2px 6px; }
  .scx-track { position: relative; height: 18px; border-radius: 99px; background: #ffe1ea; box-shadow: inset 0 2px 5px rgba(190,80,125,.28); }
  .scx-trail { position: absolute; top: 0; bottom: 0; }
  .scx-trail.user { left: 0; border-radius: 99px 0 0 99px; background: linear-gradient(90deg,#ffd3e0,#f291b0); }
  .scx-trail.opp { right: 0; border-radius: 0 99px 99px 0; background: linear-gradient(270deg,#e2cef5,#a97fd8); }
  .scx-pline { position: absolute; top: -4px; bottom: -4px; border-left: 2px dashed rgba(255,79,121,.55); z-index: 2; }
  .scx-pheart { position: absolute; top: -16px; width: 17px; height: 17px; transform: translateX(-50%); color: #ff4f79; z-index: 3; }
  .scx-pheart svg { width: 100%; height: 100%; }
  .scx-ptr { position: absolute; top: 50%; width: 22px; height: 22px; border-radius: 50%; transform: translate(-50%,-50%); display: flex; align-items: center; justify-content: center; border: 2px solid #fff; box-shadow: 0 2px 6px rgba(150,50,95,.35); z-index: 3; }
  .scx-ptr svg { width: 11px; height: 11px; color: #fff; }
  .scx-ptr.user { background: linear-gradient(140deg,#f291b0,#e06a94); }
  .scx-ptr.opp { background: linear-gradient(140deg,#a97fd8,#8d5cc4); }
  .scx-namerow { display: flex; justify-content: space-between; gap: 8px; }
  .scx-chip { display: flex; align-items: center; gap: 5px; padding: 2px 10px 2px 4px; background: rgba(255,255,255,.8); border: 1px solid #f6cfda; border-radius: 99px; font-size: 11px; font-weight: 600; }
  .scx-av { width: 19px; height: 19px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; color: #fff; }
  .scx-av.user { background: linear-gradient(140deg,#f291b0,#e06a94); }
  .scx-av.opp { background: linear-gradient(140deg,#a97fd8,#8d5cc4); }
  .scx-lv { display: inline-block; padding: 0 6px; border-radius: 99px; font-size: 9px; color: #fff; background: #e06a94; margin-left: 4px; }
  .scx-fatigue { display: flex; align-items: center; gap: 7px; }
  .scx-ftag { font-size: 10px; font-weight: 700; color: #bd8fa0; flex: none; }
  .scx-ftrack { flex: 1; height: 5px; border-radius: 99px; background: rgba(255,255,255,.65); overflow: hidden; }
  .scx-ffill { height: 100%; background: #f291b0; }
  .scx-fnum { font-size: 10px; font-weight: 700; color: #6d3549; }
  .scx-grow { display: flex; align-items: center; gap: 7px; }
  .scx-glabel { flex: none; font-size: 10px; font-weight: 700; color: #8a4a60; }
  .scx-gdot { width: 5px; height: 5px; border-radius: 50%; background: #e06a94; }
  .scx-gdot.opp { background: #8d5cc4; }
  .scx-gsegs { flex: 1; display: flex; gap: 2px; height: 9px; }
  .scx-gseg { flex: 1; border-radius: 99px; background: rgba(255,255,255,.75); }
  .scx-gseg.s1 { background: #f9c3d2; } .scx-gseg.s2 { background: #f59db6; } .scx-gseg.s3 { background: #ef7099; }
  .scx-gseg.s4 { background: #d94b7d; } .scx-gseg.s5 { background: #b82e5e; }
  .scx-gpill { flex: none; padding: 1px 7px; border-radius: 99px; border: 1px solid #f6cfda; background: rgba(255,255,255,.75); font-size: 9.5px; }
  .scx-end { padding: 12px; border: 1px solid #f6cfda; border-top: 3px solid #ff4f79; border-radius: 10px; background: rgba(255,255,255,.55); font-size: 12.5px; line-height: 1.8; text-align: center; }
  .scx-chev { margin-left: auto; font-size: 11px; color: #bd8fa0; }
`;
