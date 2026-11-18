import { ctx, log, warn, st } from './env.js';
import * as config from './config.js';

const K = { state:'通用性斗_当局', report:'通用性斗_战况', rule:'通用性斗_场景判断', open:'通用性斗_开局', stage:'通用性斗_阶段状态', exp:'通用性斗_经验总档', lp:'通用性斗_等级_' };
const L = [
  {n:'处子',min:0,f:0,c:5},{n:'新手',min:12,f:10,c:4},{n:'经验',min:25,f:25,c:3},{n:'老手',min:37,f:50,c:2},{n:'魅魔',min:50,f:100,c:1},
];
const H = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
const S5 = ['平静','微热','急促','激越','燃尽'];
const d = n => 1 + Math.floor(Math.random() * n);
const dice = (c, f) => { let s = 0; for (let i = 0; i < c; i++) s += d(f); return s; };
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;');

let SC = { state:null, exp:{}, lastFloor:-1, lastSig:'', booted:false, ready:false, panel:null, bound:false };

// ── 脚本库配置 ──
function cfg() {
  const s = config.getSettings(); if (!s) return {};
  s.scripts = s.scripts || {};
  s.scripts.sexcombat = s.scripts.sexcombat || { enabled:false, trigger:'nsfwh', defaultLevel:10, userName:'user', initialLevels:{}, positions:{} };
  const c = s.scripts.sexcombat;
  if (!c.trigger) c.trigger = 'nsfwh';
  if (!c.userName) c.userName = 'user';
  if (c.defaultLevel === undefined) c.defaultLevel = 10;
  c.initialLevels = c.initialLevels || {};
  c.positions = c.positions || {};
  return c;
}
function isEnabled() { const k = cardKey(); return k ? !!cfg()[k] : false; }
function setEnabled(v) { const k = cardKey(); if (k) { cfg()[k] = !!v; config.persist(); } }
function cardKey() { const id = config.getCharacterIdentity(); return id ? id.avatar : null; }
function uName() { return cfg().userName || 'user'; }
function expOf(n) {
  if (SC.exp[n] !== undefined) return SC.exp[n];
  const il = cfg().initialLevels; if (il[n] !== undefined) return il[n];
  if (n === uName()) return 0;
  return cfg().defaultLevel || 10;
}
function lvI(n) {
  const v = typeof n === 'number' ? n : expOf(n);
  let i = 0; L.forEach((x, k) => { if (v >= x.f) i = k; }); return i;
}
const lvD = i => L[Math.max(0, Math.min(4, i))];

// ── 斜杠 ══
async function run(cmd) {
  const c = ctx();
  if (c?.executeSlashCommands) { const r = await c.executeSlashCommands(cmd); return r ?? '' ? String(r) : ''; }
  return String(await st(cmd) ?? '');
}
async function readE(key, book) {
  const raw = await run('/ruby "RPC~read~key=' + key + '~json=true~book=' + (book || 'chat') + '"');
  try { return JSON.parse(raw); } catch { return null; }
}
async function writeE(key, content, o = {}) {
  const v = '_sx_' + Date.now().toString(36) + Math.floor(Math.random() * 999);
  await run('/setvar key=' + v + ' "' + String(content ?? '').replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\|/g,'｜') + '"');
  let cmd = '/ruby RPC~write~key=' + key + '~var=' + v + '~book=' + (o.book || 'chat') + '~position=' + (o.pos ?? 1) + '~order=' + (o.ord ?? 210) + (o.constant !== undefined ? '~constant=' + (o.constant ? 'true' : 'false') : '') + (o.depth !== undefined ? '~depth=' + o.depth : '');
  if (o.comment) cmd += '~comment=' + o.comment;
  await run(cmd);
}

// ── 隐藏正则 ──
function ensureRe() {
  const c = ctx(); if (!c) return;
  const es = c.extensionSettings || window.extension_settings; if (!es) return;
  es.regex = Array.isArray(es.regex) ? es.regex : [];
  const want = [
    {scriptName:'通用性斗·隐藏情潮XML',findRegex:'<情潮[^>]*>[\\s\\S]*?<\\/情潮[^>]*>',replaceString:'',placement:1,markdownOnly:true,promptOnly:false,runOnEdit:true,minDepth:null,maxDepth:null,disabled:false},
    {scriptName:'通用性斗·隐藏report',findRegex:'<report>([\\s\\S]*?)<\\/report>',replaceString:'',placement:1,markdownOnly:true,promptOnly:true,runOnEdit:true,minDepth:null,maxDepth:null,disabled:false},
  ];
  let a = 0;
  for (const w of want) { if (!es.regex.some(x => x.scriptName === w.scriptName)) { es.regex.push({trimStrings:[],substituteRegex:0,...w}); a++; } }
  if (a) { if (typeof c.saveSettingsDebounced === 'function') c.saveSettingsDebounced(); log('[性斗] 隐藏正则 ×' + a); }
}

// ── 场景判断条目（纯格式，照 08_插图规则） ──
function ruleT() {
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

// ── 状态 ──
function rollP(lo, hi) { if (hi <= lo) return lo; return Math.round(lo + (hi - lo) * ((d(100) + d(100)) / 2) / 100); }
function st0() { return { active:true, startFloor:0, lastSettledFloor:-1, round:0, p:50, scanFloor:1, user:{pos:0,ex:0}, opps:[], ended:null, endedFloor:0, cleared:false, endEntries:[] }; }
function stageOf(e) { return Math.max(0, Math.min(5, Math.ceil(e / 20))); }
function newB(fl, chars) {
  const old = SC.state, oldE = old ? old.endEntries || [] : [];
  const uLv = lvI(expOf(uName()));
  const maxOLv = Math.max(...chars.map(n => lvI(expOf(n))), uLv);
  SC.state = st0();
  Object.assign(SC.state, { startFloor:fl, scanFloor:fl+1, p:rollP(lvD(uLv).min, lvD(maxOLv).min), opps:chars.map(n => ({name:n, pos:100, ex:0, exited:false, present:true})) });
  (async () => { const dd = [[K.stage, {constant:false, ord:898}]]; oldE.forEach(e => dd.push([e.key, {constant:false, ord:e.ord}])); for (const [k,o] of dd) await writeE(k, '', o); })();
}

// ── 骰子 ──
function hit(a, dv, ds, as) {
  const raw = d(100); let t = raw + 40 + a * 10;
  if (ds >= 3) t += 15; if (as >= 4) t -= 10;
  return raw >= 96 ? '妙手' : t < 50 ? '严重失手' : t < 100 ? '部分失手' : '得手';
}
function push(a, dv, v) {
  if (v === '严重失手') return 0;
  let n = a + 1; if (v === '部分失手') n = Math.ceil(n / 2);
  const net = Math.max(0, dice(n, 6) - dice(dv + 1, 4));
  return v === '妙手' ? net + 10 : net;
}
function chg(t, dist) { let c = lvD(t).c + d(4); if (dist <= 15) c += 3; return c; }

// ── 解析 ──
function pRep(mes) {
  const m = String(mes || '').match(/<report>([\s\S]*?)<\/report>/i); if (!m) return null;
  const out = {}; let cur = null;
  m[1].split(/\r?\n/).forEach(raw => {
    if (!raw.trim() || /^\s*#/.test(raw)) return;
    const ind = (raw.match(/^\s*/) || [''])[0].length;
    const t = raw.trim(); const kv = t.match(/^([^:：]+)[:：]\s*(.*)$/);
    if (ind === 0) { if (!kv) { cur = null; return; } cur = kv[1].trim(); if (!out[cur]) out[cur] = {单向:0,双向:0}; return; }
    if (cur && kv) { const k = kv[1].trim(), v = parseInt(kv[2], 10) || 0; if (k === '单向' || k === '双向') out[cur][k] = Math.min(v, k === '单向' ? 3 : 2); }
  });
  return Object.keys(out).length ? out : null;
}
function pScene(mes) {
  const m = String(mes || '').match(/<SceneInfo>([\s\S]*?)<\/SceneInfo>/i);
  if (!m) return { hard:false, chars:[] };
  const blk = m[1]; const trig = cfg().trigger || 'nsfwh';
  const hard = new RegExp(trig, 'i').test(blk);
  const cm = blk.match(/在场角色[：:]\s*([\s\S]*?)(?=\n\n|\n<\/SceneInfo>|$)/);
  const chars = [];
  if (cm) cm[1].split(/\r?\n/).forEach(l => {
    const t = l.trim(); if (!t.startsWith('-')) return;
    const n = t.replace(/^-\s*/, '').split('|')[0].trim();
    if (n && n !== uName() && !chars.includes(n)) chars.push(n);
  });
  return { hard, chars };
}
function syncR(chars) {
  const s = SC.state; if (!s || !chars?.length) return;
  s.opps.forEach(o => { o.present = chars.includes(o.name); });
  chars.forEach(n => { if (!s.opps.some(o => o.name === n)) { s.opps.push({name:n, pos:100, ex:0, exited:false, present:true}); log('[性斗] 中途加入：' + n); } });
}

// ── 结算 ──
function settle(rep, fl, c) {
  const s = SC.state; s.round++; s.lastSettledFloor = fl;
  syncR(pScene(c.chat[fl]?.mes || '').chars);
  const u = uName(); const uL = lvI(expOf(u));
  const tg = s.opps.find(o => !o.exited && o.present !== false);
  const uR = rep[u] || {};
  if (tg) {
    const tL = lvI(expOf(tg.name));
    for (let i = 0; i < (uR.单向 || 0); i++) {
      const v = hit(uL, tL, stageOf(tg.ex), stageOf(s.user.ex));
      tg.pos = Math.max(s.p, tg.pos - push(uL, tL, v));
      if (v !== '严重失手') tg.ex = Math.min(100, tg.ex + chg(tL, tg.pos - s.p));
    }
    for (let i = 0; i < (uR.双向 || 0); i++) {
      const v = hit(uL, tL, stageOf(tg.ex), stageOf(s.user.ex));
      tg.pos = Math.max(s.p, tg.pos - push(uL, tL, v));
      s.user.pos = Math.min(s.p, s.user.pos + Math.max(0, dice(tL + 1, 6) - dice(uL + 1, 4)));
      tg.ex = Math.min(100, tg.ex + 2); s.user.ex = Math.min(100, s.user.ex + 2);
    }
  }
  s.opps.forEach(o => {
    if (o.exited || o.present === false) return;
    const r = rep[o.name]; if (!r) return;
    const oL = lvI(expOf(o.name));
    for (let i = 0; i < (r.单向 || 0); i++) {
      const v = hit(oL, uL, stageOf(s.user.ex), stageOf(o.ex));
      s.user.pos = Math.min(s.p, s.user.pos + push(oL, uL, v));
      if (v !== '严重失手') s.user.ex = Math.min(100, s.user.ex + chg(uL, s.p - s.user.pos));
    }
    for (let i = 0; i < (r.双向 || 0); i++) {
      const v = hit(oL, uL, stageOf(s.user.ex), stageOf(o.ex));
      s.user.pos = Math.min(s.p, s.user.pos + push(oL, uL, v));
      o.pos = Math.max(s.p, o.pos - Math.max(0, dice(uL + 1, 6) - dice(oL + 1, 4)));
      s.user.ex = Math.min(100, s.user.ex + 2); o.ex = Math.min(100, o.ex + 2);
    }
  });
  if (!rep[u] && !(uR.单向 || uR.双向)) s.user.ex = Math.max(0, s.user.ex - 2);
  s.opps.forEach(o => { if (!rep[o.name]) o.ex = Math.max(0, o.ex - 2); });
  if (s.user.pos >= s.p) { endB('user'); return; }
  const fallen = s.opps.filter(o => !o.exited && o.present !== false && o.pos <= s.p);
  fallen.forEach(o => { o.exited = true; });
  if (!s.opps.filter(o => !o.exited && o.present !== false).length) { endB('userWin'); return; }
  if (fallen.length) { endB('opp', fallen); return; }
  if (s.round >= 10) endB('flaccid');
}
function endB(type, extra) {
  const s = SC.state; s.active = false;
  s.ended = { type, names: type === 'opp' ? (extra || []).map(o => o.name) : [] };
  s.endedFloor = s.lastSettledFloor;
  const fls = Math.max(1, s.endedFloor - s.startFloor + 1);
  const u = uName();
  SC.exp[u] = expOf(u) + fls;
  s.opps.forEach(o => { SC.exp[o.name] = expOf(o.name) + fls; });
  log('[性斗] 经验：+' + fls, u + '=' + SC.exp[u], s.opps.map(o => o.name + '=' + SC.exp[o.name]).join(','));
  persist();
}

// ── 文案 ──
function battleT() {
  const s = SC.state; const u = uName();
  const uD = Math.max(0, s.p - s.user.pos);
  let mn = Infinity, mnN = '';
  s.opps.forEach(o => { if (!o.exited && o.present !== false) { const dd = o.pos - s.p; if (dd < mn) { mn = dd; mnN = o.name; } } });
  const cal = mn === Infinity || uD > mn ? u : mnN;
  const op = s.opps.filter(o => !o.exited && o.present !== false).map(o => o.name + ' 距顶' + Math.max(0, o.pos - s.p)).join('｜');
  return '【情潮战况】\n高潮条：' + u + ' 距顶' + uD + '｜' + op + '\n从容：' + cal + ' 更从容';
}
function openT() {
  const s = SC.state; const u = uName();
  const roles = [u].concat(s.opps.map(o => o.name)).join('，');
  const solo = s.opps.length === 1;
  const rv = solo ? '两人的交融也是面向高潮的较量——都想让对方先到顶。' : '交融中，' + u + '与每个对手各自较量。';
  return ['<情潮开局 角色="' + roles + '">', '写作指导：性关系开始。' + rv, u + '的输入只是意图——写出来的不等于真实结果。', '进展与结果以情潮战况为准——照数值写，不粉饰不翻转。', '不自行判顶点，不自行写高潮，不虚报。', '职责=氛围与体感。', '每轮末尾按 report 协议申报。', '</情潮开局>'].join('\n');
}
function stageT(n, e) {
  const s = stageOf(e);
  if (s === 3) return '<情潮状态 角色="' + n + '" 阶段="3" 进度="' + e + '/100">\n' + n + '的兴奋值已过半。单向增多，更密更贴。\n</情潮状态>';
  if (s === 4) return '<情潮状态 角色="' + n + '" 阶段="4" 进度="' + e + '/100">\n' + n + '升到阶段④。转为主动，抢主导，单向变多。\n</情潮状态>';
  if (s === 5) return '<情潮状态 角色="' + n + '" 阶段="5" 进度="' + e + '/100">\n' + n + '的兴奋值已到顶。单向最盛，持续到本局结束。\n</情潮状态>';
  return '';
}
function stageTAll() {
  const s = SC.state;
  const parts = [stageT(u(), s.user.ex)];
  s.opps.forEach(o => { if (!o.exited && o.present !== false) parts.push(stageT(o.name, o.ex)); });
  return parts.filter(Boolean).join('\n');
}
function d1T(n) { return '<情潮指南 类型="不应期" 角色="' + n + '">\n扮演指导：' + n + '已进入不应期——敏感度大幅钝化，性刺激不引发反应。写：不应期身体事实、余韵。不写：性刺激引发的反应。\n</情潮指南>'; }
function d2T(n) { return '<情潮指南 类型="user高潮后反应" 角色="' + n + '">\n扮演指导：' + n + '还没到顶，悬在半途。反应按性格：假高潮（破绽可见）/嘲讽/失望/宽慰/照顾；催促=他还动着时她推他，他射了她才接话。\n</情潮指南>'; }
function bOpp(n) { return '<情潮收场 类型="对手高潮" 角色="' + n + '">\n写作指导：' + n + '已高潮进入不应期——写其后状态与余韵。禁止继续主动性行为。\n</情潮收场>'; }
function bUser(n) { return '<情潮收场 类型="user高潮">写作指导：' + u() + '已高潮进入不应期——禁止再写性行为。' + n + '的反应按人设：假高潮/嘲讽/安慰/口头认下。\n</情潮收场>'; }
function bFl() { return '<情潮收场 类型="疲软收场">写作指导：双方均进入不应期——性行为无法继续。写疲软与收束。无人到顶。禁止继续性行为。\n</情潮收场>'; }
function bWin() { return '<情潮收场 类型="user胜利终局">写作指导：在场对手全部高潮进入不应期——写' + u() + '的从容，由其决定如何对待众人。\n</情潮收场>'; }

// ── 持久化 ──
function persist() {
  const s = SC.state; if (!s) return;
  const expL = Object.keys(SC.exp).map(n => '  ' + n + ': ' + SC.exp[n]).join('\n');
  writeE(K.exp, expL, { constant: false, comment: '经验总档' });
  s.opps.forEach(o => writeE(K.lp + o.name, '等级: ' + L[lvI(o.name)].n + '\n经验: ' + expOf(o.name), { constant: false, comment: '等级' }));
  writeE(K.lp + uName(), '等级: ' + L[lvI(uName())].n + '\n经验: ' + expOf(uName()), { constant: false, comment: '等级' });
  if (s.cleared) {
    [K.report, K.rule, K.open, K.stage].forEach((k, i) => writeE(k, '', { constant: false, pos: i === 0 ? 4 : 1, ord: i === 0 ? 989 : [210, 900, 898][i - 1] || 210 }));
    s.endEntries.forEach(e => writeE(e.key, '', { constant: false, ord: e.ord }));
  } else {
    writeE(K.report, s.ended ? (s.endEntries || []).filter(e => e.key.includes('user高潮')).map(e => e.text).join('\n') || battleT() : battleT(), { constant: true });
    if (!s.ended) {
      writeE(K.open, openT(), { constant: true, ord: 900 });
      writeE(K.stage, stageTAll(), { constant: true, ord: 898 });
      s.endEntries.forEach(e => writeE(e.key, '', { constant: false, ord: e.ord }));
    } else {
      writeE(K.stage, '', { constant: false, ord: 898 });
      s.endEntries.forEach(e => writeE(e.key, e.text, { constant: true, ord: e.ord }));
    }
  }
}

// ── tick ──
async function tick() {
  const c = ctx(); if (!c?.chat?.length) return;
  const last = c.chat.length - 1;
  const sig = (c.chat[last].mes || '').length + ':' + String(c.chat[last].mes || '').slice(-80);
  if (last === SC.lastFloor && sig === SC.lastSig) return;
  SC.lastFloor = last; SC.lastSig = sig;
  try {
    if (SC.state && !SC.state.active && !SC.state.cleared && last > SC.state.endedFloor) {
      log('[性斗] 清场 @楼' + last); SC.state.cleared = true; await persist(); SC.state = null; render(); return;
    }
    let scan = SC.state?.active ? Math.max(SC.state.scanFloor || SC.state.startFloor, SC.state.startFloor, SC.state.lastSettledFloor + 1) : last;
    for (let f = Math.min(scan, last); f <= last; f++) {
      const msg = c.chat[f]; if (!msg || msg.is_user) continue;
      const m = msg.mes || '';
      const rep = pRep(m);
      if (SC.state?.active && !SC.state.ended && rep && f !== SC.state.lastSettledFloor) {
        const scF = pScene(m);
        const inR = scF.chars.some(n => SC.state.opps.some(o => o.name === n && !o.exited)) || Object.keys(rep).some(n => n !== uName() && SC.state.opps.some(o => o.name === n && !o.exited));
        if (scF.chars.length && !inR) restart(f, scF.chars); else syncR(scF.chars);
        log('[性斗] 结算 @楼' + f); settle(rep, f, c); if (SC.state.ended) break;
      } else if (!SC.state?.active && new RegExp(cfg().trigger || 'nsfwh', 'i').test(m)) {
        const sc = pScene(m);
        if (sc.hard && sc.chars.length) { log('[性斗] 开局 @楼' + f); newB(f, sc.chars); const r0 = pRep(m); if (r0) settle(r0, f, c); if (SC.state.ended) break; }
      } else if (SC.state?.active && !SC.state.ended && new RegExp(cfg().trigger || 'nsfwh', 'i').test(m)) {
        const scF = pScene(m);
        if (scF.chars.length && !scF.chars.some(n => SC.state.opps.some(o => o.name === n && !o.exited))) restart(f, scF.chars); else syncR(scF.chars);
      }
    }
    if (SC.state) SC.state.scanFloor = Math.max(SC.state.scanFloor || SC.state.startFloor, last + 1);
    persist();
  } catch (e) { warn('[性斗] tick 失败:', e?.message || e); } finally { render(); }
}
function restart(fl, chars) { log('[性斗] 换人重开 @楼' + fl); const old = SC.state; const oldE = old ? old.endEntries || [] : []; newB(fl, chars); (async () => { const dd = [[K.stage, {constant:false, ord:898}]]; oldE.forEach(e => dd.push([e.key, {constant:false, ord:e.ord}])); for (const [k,o] of dd) await writeE(k, '', o); })(); }

// ── 面板 ──
function render() {
  let p = document.getElementById('ruby_sc_panel'); if (!p) return;
  const s = SC.state;
  if (!s) { p.classList.add('scx-absent'); return; }
  p.classList.remove('scx-absent');
  const inner = p.querySelector('.scx-inner'); if (!inner) return;
  if (s.ended) {
    const n = s.ended.names?.join('、') || '对方';
    const t = s.ended.type === 'user' ? '再怎么努力也忍不住——高潮将至。' + n + '技高一筹。' : s.ended.type === 'opp' ? n + '已到顶——高潮将至。' + uName() + '技高一筹。' : s.ended.type === 'flaccid' ? '疲软将至——谁也没赢。' : '全胜。';
    inner.innerHTML = '<div class="scx-end">' + esc(t) + '</div>'; return;
  }
  const uD = Math.max(0, s.p - s.user.pos);
  let bars = '';
  s.opps.forEach(o => {
    const dO = Math.max(0, o.pos - s.p);
    let sg = ''; for (let i = 0; i < 5; i++) sg += '<div class="scx-gseg' + (i < stageOf(o.ex) ? ' s' + stageOf(o.ex) : '') + '"></div>';
    let usg = ''; for (let i = 0; i < 5; i++) usg += '<div class="scx-gseg' + (i < stageOf(s.user.ex) ? ' s' + stageOf(s.user.ex) : '') + '"></div>';
    bars += '<div class="scx-opprow' + (o.present === false ? ' gone' : '') + '"><div class="scx-oppname">' + esc(o.name) + '·' + L[lvI(o.name)].n + (o.present === false ? '·未在场' : '') + '</div>' +
      '<div class="scx-climax"><div class="scx-pheart" style="left:' + s.p + '%">' + H + '</div><div class="scx-pline" style="left:' + s.p + '%"></div>' +
      '<div class="scx-track"><div class="scx-trail user" style="width:' + s.user.pos + '%"></div><div class="scx-trail opp" style="width:' + (100 - o.pos) + '%"></div>' +
      '<div class="scx-ptr user" style="left:' + s.user.pos + '%">' + H + '</div><div class="scx-ptr opp" style="left:' + o.pos + '%">' + H + '</div></div></div>' +
      '<div class="scx-grow"><div class="scx-glabel"><span class="scx-gdot opp"></span>兴奋</div><div class="scx-gsegs">' + sg + '</div><div class="scx-gpill">' + S5[Math.max(0, stageOf(o.ex) - 1)] + '</div></div>' +
      '<div class="scx-grow"><div class="scx-glabel"><span class="scx-gdot user"></span>兴奋</div><div class="scx-gsegs">' + usg + '</div><div class="scx-gpill">' + S5[Math.max(0, stageOf(s.user.ex) - 1)] + '</div></div>';
  });
  inner.innerHTML = '<div class="scx-namerow"><div class="scx-chip"><span class="scx-av user">你</span><span>' + esc(uName()) + '<small class="scx-lv">' + L[lvI(expOf(uName()))].n + '</small></span></div>' +
    '<div class="scx-chip"><span class="scx-av opp">彼</span><span>' + esc(s.opps.map(o => o.name).join('、')) + '</span></div></div>' + bars +
    '<div class="scx-fatigue"><span class="scx-ftag">疲软</span><div class="scx-ftrack"><div class="scx-ffill" style="width:' + s.round * 10 + '%"></div></div><span class="scx-fnum">' + s.round + '/10</span></div>';
}
function ensureP() {
  if (SC.panel) return;
  const el = document.createElement('div'); el.id = 'ruby_sc_panel'; el.className = 'scx-panel scx-absent';
  el.innerHTML = '<style>' + SCX_CSS + '</style><div class="scx-head"><div class="scx-title">' + H + ' 情潮</div><span class="scx-sub"></span><span class="scx-chev">▾</span></div><div class="scx-body"><div class="scx-inner"></div></div>';
  document.body.appendChild(el);
  el.querySelector('.scx-head').addEventListener('click', () => el.classList.toggle('scx-folded'));
  SC.panel = el;
}
function bindEvents() {
  const c = ctx(); if (!c?.eventSource || !c?.eventTypes) { setTimeout(bindEvents, 1000); return; }
  if (SC.bound) return; SC.bound = true;
  c.eventSource.on(c.eventTypes.GENERATION_ENDED, tick);
  c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => { SC.lastFloor = -1; tick(); });
  c.eventSource.on(c.eventTypes.MESSAGE_RECEIVED, (_id, type) => { if (type === 'first_message') tick(); });
  log('[性斗] 事件绑定完成');
}

// ── 启停 ──
async function start() {
  if (SC.booted) return; SC.booted = true;
  ensureP(); ensureRe(); bindEvents();
  const rec = await readE(K.state);
  const body = rec?.content ? String(rec.content) : '';
  const jm = body.match(/\{[\s\S]*\}/);
  if (jm) { try { SC.state = JSON.parse(jm[0]); } catch {} }
  const expR = await readE(K.exp);
  const eb = expR?.content ? String(expR.content) : '';
  eb.split(/\r?\n/).forEach(l => { const m = l.trim().match(/^([^:：]+)[:：]\s*(\d+)\s*$/); if (m) SC.exp[m[1].trim()] = parseInt(m[2], 10); });
  SC.ready = true;
  log('[性斗] 已启动');
  tick();
}
async function stop() {
  for (const k of [K.report, K.rule, K.open, K.stage]) await writeE(k, '', { constant: false });
  SC.exp = {}; SC.state = null; SC.booted = false; SC.ready = false; render();
  log('[性斗] 已停用');
}

// ── 库 API ──
export function levelNameFor(e) { return L[lvI(parseInt(e, 10) || 0)].n; }
export function getLevels() { const o = {}; Object.keys(cfg().initialLevels).forEach(n => { o[n] = cfg().initialLevels[n]; }); Object.keys(SC.exp).forEach(n => { o[n] = SC.exp[n]; }); return o; }
export function setInitLevel(n, e) { const c = cfg(); c.initialLevels = c.initialLevels || {}; c.initialLevels[n] = parseInt(e, 10) || 0; SC.exp[n] = parseInt(e, 10) || 0; config.persist(); }
export function removeInitLevel(n) { delete cfg().initialLevels[n]; delete SC.exp[n]; (async () => { await writeE(K.lp + n, '', { constant: false }); })(); config.persist(); }
export function entryWrite(key, content, opts) { return writeE(key, content, opts); }
export async function entryRead(key, book) { return readE(key, book); }
export function getStatus() { const k = cardKey(); return { supported: !!k, enabled: isEnabled(), cardName: k ? (config.getCharacterIdentity()?.name || '') : '' }; }
export async function toggle() { const v = !isEnabled(); setEnabled(v); if (v) await start(); else await stop(); return isEnabled(); }
export function init() { if (isEnabled()) start(); else if (SC.booted) stop(); }

// ── CSS ──
const SCX_CSS = '.scx-panel{position:fixed;left:12px;bottom:12px;z-index:9000;width:min(520px,92vw);border:1px solid #f6cfda;border-radius:14px;background:linear-gradient(165deg,#fff8fa,#ffe4ec);box-shadow:0 14px 34px rgba(180,60,110,.25);font-family:system-ui,sans-serif;color:#6d3549;overflow:hidden}.scx-panel.scx-absent{display:none}.scx-head{display:flex;align-items:center;gap:8px;padding:9px 14px;cursor:pointer;border-bottom:1px solid #f6cfda;background:rgba(255,255,255,.5)}.scx-title{display:flex;align-items:center;gap:6px;font-weight:700;font-size:13px}.scx-title svg{width:13px;height:13px}.scx-sub{flex:1;font-size:10px;color:#bd8fa0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.scx-inner{padding:10px 14px;display:flex;flex-direction:column;gap:9px}.scx-opprow.gone{opacity:.38;filter:grayscale(.6)}.scx-oppname{font-size:10.5px;font-weight:700;margin-bottom:2px}.scx-climax{position:relative;padding:16px 2px 6px}.scx-track{position:relative;height:18px;border-radius:99px;background:#ffe1ea;box-shadow:inset 0 2px 5px rgba(190,80,125,.28)}.scx-trail{position:absolute;top:0;bottom:0}.scx-trail.user{left:0;border-radius:99px 0 0 99px;background:linear-gradient(90deg,#ffd3e0,#f291b0)}.scx-trail.opp{right:0;border-radius:0 99px 99px 0;background:linear-gradient(270deg,#e2cef5,#a97fd8)}.scx-pline{position:absolute;top:-4px;bottom:-4px;border-left:2px dashed rgba(255,79,121,.55);z-index:2}.scx-pheart{position:absolute;top:-16px;width:17px;height:17px;transform:translateX(-50%);color:#ff4f79;z-index:3}.scx-pheart svg{width:100%;height:100%}.scx-ptr{position:absolute;top:50%;width:22px;height:22px;border-radius:50%;transform:translate(-50%,-50%);display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 2px 6px rgba(150,50,95,.35);z-index:3}.scx-ptr svg{width:11px;height:11px;color:#fff}.scx-ptr.user{background:linear-gradient(140deg,#f291b0,#e06a94)}.scx-ptr.opp{background:linear-gradient(140deg,#a97fd8,#8d5cc4)}.scx-namerow{display:flex;justify-content:space-between;gap:8px}.scx-chip{display:flex;align-items:center;gap:5px;padding:2px 10px 2px 4px;background:rgba(255,255,255,.8);border:1px solid #f6cfda;border-radius:99px;font-size:11px;font-weight:600}.scx-av{width:19px;height:19px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff}.scx-av.user{background:linear-gradient(140deg,#f291b0,#e06a94)}.scx-av.opp{background:linear-gradient(140deg,#a97fd8,#8d5cc4)}.scx-lv{display:inline-block;padding:0 6px;border-radius:99px;font-size:9px;color:#fff;background:#e06a94;margin-left:4px}.scx-fatigue{display:flex;align-items:center;gap:7px}.scx-ftag{font-size:10px;font-weight:700;color:#bd8fa0;flex:none}.scx-ftrack{flex:1;height:5px;border-radius:99px;background:rgba(255,255,255,.65);overflow:hidden}.scx-ffill{height:100%;background:#f291b0}.scx-fnum{font-size:10px;font-weight:700;color:#6d3549}.scx-grow{display:flex;align-items:center;gap:7px}.scx-glabel{flex:none;font-size:10px;font-weight:700;color:#8a4a60}.scx-gdot{width:5px;height:5px;border-radius:50%;background:#e06a94}.scx-gdot.opp{background:#8d5cc4}.scx-gsegs{flex:1;display:flex;gap:2px;height:9px}.scx-gseg{flex:1;border-radius:99px;background:rgba(255,255,255,.75)}.scx-gseg.s1{background:#f9c3d2}.scx-gseg.s2{background:#f59db6}.scx-gseg.s3{background:#ef7099}.scx-gseg.s4{background:#d94b7d}.scx-gseg.s5{background:#b82e5e}.scx-gpill{flex:none;padding:1px 7px;border-radius:99px;border:1px solid #f6cfda;background:rgba(255,255,255,.75);font-size:9.5px}.scx-end{padding:12px;border:1px solid #f6cfda;border-top:3px solid #ff4f79;border-radius:10px;background:rgba(255,255,255,.55);font-size:12.5px;line-height:1.8;text-align:center}.scx-chev{margin-left:auto;font-size:11px;color:#bd8fa0}';
