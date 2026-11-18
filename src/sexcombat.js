import { ctx, log, warn, st, q } from './env.js';
import * as config from './config.js';
import * as worldbook from './worldbook.js';

const K = { state:'通用性斗_当局', report:'通用性斗_战况', rule:'通用性斗_场景判断', open:'通用性斗_开局', stage:'通用性斗_阶段状态', exp:'通用性斗_经验总档', lp:'通用性斗_等级_' };
const L = [
  {n:'处子',min:0,f:0,c:5},{n:'新手',min:12,f:10,c:4},{n:'经验',min:25,f:25,c:3},{n:'老手',min:37,f:50,c:2},{n:'魅魔',min:50,f:100,c:1},
];
const H = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
const S5 = ['平静','微热','急促','激越','燃尽'];
const d = n => 1 + Math.floor(Math.random() * n);
const dice = (c, f) => { let s = 0; for (let i = 0; i < c; i++) s += d(f); return s; };
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;');

let SC = { state:null, exp:{}, lastFloor:-1, lastSig:'', booted:false, ready:false, panel:null, bound:false, domObs:null, promptHook:null, textgenHook:null, mainApiIsOpenai:null };

// ── 脚本库配置 ──
// 本机设置 = 运行时层（启停按角色、运行态经验）；角色卡 = 创作者配置层（sceneTag / chars 底账）
// 面板「💾 保存」→ saveToCard 写入角色卡；start/refresh 时从卡水合（卡为准）
function cfg() {
  const s = config.getSettings(); if (!s) return {};
  s.scripts = s.scripts || {};
  s.scripts.sexcombat = s.scripts.sexcombat || { enabled:false, trigger:'nsfwh', sceneTag:'SceneInfo', defaultLevel:10, userName:'user', initialLevels:{}, positions:{} };
  const c = s.scripts.sexcombat;
  // 触发词允许清空（''=不启用性斗触发），只在从未设置时给默认值
  c.trigger = (c.trigger === undefined || c.trigger === null) ? 'nsfwh' : String(c.trigger);
  c.sceneTag = String(c.sceneTag || '').replace(/[<>\s]/g, '') || 'SceneInfo';
  if (c.ruleEnabled === undefined) c.ruleEnabled = true;
  c.ruleWhere = ['head', 'tail', 'anchor'].includes(c.ruleWhere) ? c.ruleWhere : 'tail';
  c.ruleAnchor = String(c.ruleAnchor || '').replace(/[<>]/g, '').trim();
  c.scWhere = ['head', 'tail', 'anchor'].includes(c.scWhere) ? c.scWhere : 'anchor';
  c.scAnchor = String(c.scAnchor || '').replace(/[<>]/g, '').trim();
  if (!c.userName) c.userName = 'user';
  if (c.defaultLevel === undefined) c.defaultLevel = 10;
  c.initialLevels = c.initialLevels || {};
  return c;
}
function cardCfg() {
  try {
    const r = config.resolveConfig();
    return (r?.data?.scripts?.sexcombat && typeof r.data.scripts.sexcombat === 'object') ? r.data.scripts.sexcombat : null;
  } catch { return null; }
}
// 从角色卡水合创作者配置（触发词 / sceneTag / 场景判断注入设置 / chars 底账，卡为准）
function hydrateCfg() {
  const cc = cardCfg(); if (!cc) return false;
  const c = cfg();
  let touched = false;
  const tag = String(cc.sceneTag || '').replace(/[<>\s]/g, '');
  if (tag && tag !== c.sceneTag) { c.sceneTag = tag; touched = true; }
  if (cc.trigger !== undefined && cc.trigger !== null) {
    const t = String(cc.trigger);
    if (t !== c.trigger) { c.trigger = t; touched = true; }
  }
  if (cc.ruleEnabled !== undefined && !!cc.ruleEnabled !== !!c.ruleEnabled) { c.ruleEnabled = !!cc.ruleEnabled; touched = true; }
  if (cc.ruleWhere && cc.ruleWhere !== c.ruleWhere) { c.ruleWhere = String(cc.ruleWhere); touched = true; }
  if (cc.ruleAnchor !== undefined && String(cc.ruleAnchor) !== c.ruleAnchor) { c.ruleAnchor = String(cc.ruleAnchor || '').replace(/[<>]/g, '').trim(); touched = true; }
  if (cc.scWhere && cc.scWhere !== c.scWhere) { c.scWhere = String(cc.scWhere); touched = true; }
  if (cc.scAnchor !== undefined && String(cc.scAnchor) !== c.scAnchor) { c.scAnchor = String(cc.scAnchor || '').replace(/[<>]/g, '').trim(); touched = true; }
  if (cc.chars && typeof cc.chars === 'object') {
    c.initialLevels = { ...cc.chars }; touched = true;
    Object.keys(cc.chars).forEach((n) => { if (SC.exp[n] === undefined) SC.exp[n] = parseInt(cc.chars[n], 10) || 0; });
  }
  return touched;
}
// 💾 保存：把 UI 配置（触发词 / sceneTag / 场景判断注入 / chars）写入角色卡 + 本机层
export function saveToCard(patch = {}) {
  const c = cfg();
  const tag = String(patch.sceneTag ?? c.sceneTag ?? '').replace(/[<>\s]/g, '');
  if (tag) c.sceneTag = tag;
  if (patch.trigger !== undefined) c.trigger = String(patch.trigger);
  if (patch.ruleEnabled !== undefined) c.ruleEnabled = !!patch.ruleEnabled;
  if (patch.ruleWhere !== undefined) c.ruleWhere = ['head', 'tail', 'anchor'].includes(patch.ruleWhere) ? patch.ruleWhere : 'tail';
  if (patch.ruleAnchor !== undefined) c.ruleAnchor = String(patch.ruleAnchor || '').replace(/[<>]/g, '').trim();
  if (patch.scWhere !== undefined) c.scWhere = ['head', 'tail', 'anchor'].includes(patch.scWhere) ? patch.scWhere : 'anchor';
  if (patch.scAnchor !== undefined) c.scAnchor = String(patch.scAnchor || '').replace(/[<>]/g, '').trim();
  if (patch.chars && typeof patch.chars === 'object') {
    c.initialLevels = {};
    Object.keys(patch.chars).forEach((n) => {
      const v = parseInt(patch.chars[n], 10);
      if (String(n).trim() && Number.isFinite(v)) c.initialLevels[String(n).trim()] = v;
    });
  }
  config.persist();
  try {
    const r = config.resolveConfig();
    if (r?.data) {
      r.data.scripts = r.data.scripts || {};
      r.data.scripts.sexcombat = {
        ...(r.data.scripts.sexcombat || {}),
        enabled: !!isEnabled(),
        trigger: c.trigger,
        sceneTag: c.sceneTag,
        ruleEnabled: !!c.ruleEnabled,
        ruleWhere: c.ruleWhere,
        ruleAnchor: c.ruleAnchor,
        scWhere: c.scWhere,
        scAnchor: c.scAnchor,
        chars: { ...c.initialLevels },
      };
      config.saveConfigData(r.data);
      config.flushCardPersistNow();
    }
  } catch (e) { warn('[性斗] 写卡失败:', e?.message || e); }
  if (SC.booted) { safe(ensureRule); safe(syncBlocks); }
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
async function run(cmd) { return String(await st(cmd) ?? ''); }
async function readE(key, book) {
  const raw = await run('/ruby read key=' + q(key) + ' json=true book=' + (book || 'chat'));
  try { return JSON.parse(raw); } catch { return null; }
}
async function writeE(key, content, o = {}) {
  const v = '_sx_' + Date.now().toString(36) + Math.floor(Math.random() * 999);
  await run('/setvar key=' + v + ' ' + q(content));
  const pos = o.pos ?? o.position ?? 1;
  const ord = o.ord ?? o.order ?? 210;
  let cmd = '/ruby RPC~write~key=' + key + '~var=' + v + '~book=' + (o.book || 'chat') + '~position=' + pos + '~order=' + ord + (o.constant !== undefined ? '~constant=' + (o.constant ? 'true' : 'false') : '') + (o.depth !== undefined ? '~depth=' + o.depth : '');
  if (o.comment) cmd += '~comment=' + o.comment;
  await run(cmd);
}

// ── 隐藏正则 ──
function uid() { return (crypto?.randomUUID?.() || 'sx-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)); }
function ensureRe() {
  const c = ctx(); if (!c) return;
  const es = c.extensionSettings || window.extension_settings; if (!es) return;
  es.regex = Array.isArray(es.regex) ? es.regex : [];
  // placement 必须是数组（ST 引擎按 script.placement.includes(placement) 判定）；
  // 2 = AI_OUTPUT——正情潮 XML / report 只出现在 AI 输出里。写成数字会被正则扩展的
  // migrateSettings 清空 placement，导致注入正则完全失效。
  const want = [
    // 情潮XML = 引擎注入到正文的指导块——只对显示隐藏（promptOnly 必须为 false），
    // AI 要靠下一层历史读到这些块；report 才是显示+提示词双隐藏（骰子数据不给 AI 复盘）
    {scriptName:'通用性斗·隐藏情潮XML',findRegex:'<情潮[^>]*>[\\s\\S]*?<\\/情潮[^>]*>',replaceString:'',placement:[2],markdownOnly:true,promptOnly:false,runOnEdit:true,minDepth:null,maxDepth:null,disabled:false},
    {scriptName:'通用性斗·隐藏report',findRegex:'<report>([\\s\\S]*?)<\\/report>',replaceString:'',placement:[2],markdownOnly:true,promptOnly:true,runOnEdit:true,minDepth:null,maxDepth:null,disabled:false},
  ];
  let a = 0;
  for (const w of want) {
    const have = es.regex.find(x => x.scriptName === w.scriptName);
    if (!have) { es.regex.push({ id: uid(), trimStrings: [], substituteRegex: 0, ...w }); a++; }
    else {
      // 修正旧版遗留（数字 placement 被迁移清空、情潮脚本 promptOnly 误开）
      if (!Array.isArray(have.placement) || !have.placement.includes(2)) { have.placement = [2]; a++; }
      if (!have.id) { have.id = uid(); a++; }
      if (w.scriptName === '通用性斗·隐藏情潮XML' && have.promptOnly !== false) { have.promptOnly = false; a++; }
    }
  }
  if (a) { if (typeof c.saveSettingsDebounced === 'function') c.saveSettingsDebounced(); log('[性斗] 隐藏正则 ×' + a); }
}

// ── RUBY 代行隐藏（不依赖正则扩展，双保险） ──
// 第一层：原生正则扩展脚本（ensureRe，环境正常时生效）；
// 第二层：显示层 MutationObserver 洗 DOM + 提示词层官方事件钩剥离——正则扩展被禁用/未生效也能隐藏。
const HIDE_RES = () => ([
  /<情潮[\s\S]*?<\/情潮[^>]*>/g,
  /&lt;情潮[\s\S]*?&lt;\/情潮[^>]*>/g,
  /<report>[\s\S]*?<\/report>/gi,
  /&lt;report&gt;[\s\S]*?&lt;\/report&gt;/gi,
]);
function stripXml(s) { let o = String(s ?? ''); for (const re of HIDE_RES()) o = o.replace(re, ''); return o; }

// 显示层（对齐县城范式）：#chat 挂 MutationObserver——
// ① 洗掉情潮 XML / report；② 把每层 AI 输出的 <SceneInfo> 块整体替换为场景卡（+最新楼战况面板）。
// 观察回调一律去抖（流式输出每 token 都突变，直接处理会打架+卡死）。
function ensureDomHide() {
  if (SC.domObs) return;
  const chatEl = document.getElementById('chat');
  if (!chatEl) { setTimeout(ensureDomHide, 1000); return; }
  let passTimer = 0;
  SC.domObs = new MutationObserver(() => {
    if (!SC.booted) return;
    if (passTimer) return;
    passTimer = setTimeout(() => { passTimer = 0; safe(domPass); }, 150);
  });
  SC.domObs.observe(chatEl, { childList: true, subtree: true, characterData: true });
  safe(domPass); // 启动即扫一遍已渲染楼层（含启用前的旧楼层）
  log('[性斗] 显示层渲染已挂载（SceneInfo → 场景卡/战况面板）');
}

// ── 正文渲染（RUBY 代行，对齐县城 regex 替换范式）──
// 每层 AI 输出的 <sceneTag> 块在显示层整体替换为场景卡（地点/时间/类型/在场角色）；
// 最新一层 AI 楼额外挂战况面板（签名判等，状态变了才重绘）；非最新楼的战况面板移除。
function replaceSceneBlocks(html, isLatest) {
  const tag = scTag();
  const te = tagReEsc(tag);
  const card = (inner) => sceneCardHTML(inner, isLatest);
  let out = html.replace(new RegExp('<' + te + '[^>]*>([\\s\\S]*?)<\\/' + te + '>', 'gi'), (m, inner) => card(inner));
  out = out.replace(new RegExp('&lt;' + te + '[^&]*&gt;([\\s\\S]*?)&lt;\\/' + te + '&gt;', 'gi'), (m, inner) => card(inner));
  return out;
}
function sceneCardHTML(text, isLatest) {
  const s = String(text || '');
  const g = (re) => { const m = s.match(re); return m ? m[1].trim() : ''; };
  const loc = g(/地点\s*[：:]\s*([^\n]+)/);
  const time = g(/时间\s*[：:]\s*([^\n]+)/);
  const type = g(/场景类型\s*[：:]\s*([^\n]+)/);
  const chars = [];
  const cm = s.match(/在场角色\s*[：:]\s*([\s\S]*?)(?=\n\s*\n|\n\s*<|$)/i);
  if (cm) cm[1].split(/\r?\n/).forEach((l) => {
    let t = l.trim().replace(/^[-•*·—]\s*/, '');
    if (!t || /^[^|]{0,8}[：:]/.test(t)) return;
    const n = (t.includes('|') ? t.split('|')[0] : t.split(/[、，,]/)[0]).trim();
    if (n && n !== uName() && !chars.includes(n)) chars.push(esc(n));
  });
  const chips = [];
  if (time) chips.push(esc(time));
  if (loc) chips.push(esc(loc));
  if (type) chips.push('<span class="scx-type">' + esc(type) + '</span>');
  return '<div class="scx-scene">' +
    (chips.length ? '<div class="scx-scene-meta">' + chips.map((c) => '<span class="scx-chip2">' + c + '</span>').join('') + '</div>' : '') +
    (chars.length ? '<div class="scx-scene-cast">' + chars.map((n) => '<span class="scx-chip2 cast">' + n + '</span>').join('') + '</div>' : '') +
    (isLatest ? battlePanelHTML() : '') +
    '</div>';
}
// 战况面板外壳：签名判等（数据指纹不变绝不重绘——防观察器自激死循环）
function battlePanelHTML() {
  const s = SC.state;
  if (!s || s.cleared) return '';
  return '<div class="scx-inline scx-live" data-scx-sig="' + esc(scxSig(s)) + '"><div class="scx-inline-head">' + H + ' 情潮战况</div><div class="scx-inline-body">' + panelInner(s) + '</div></div>';
}
function scxSig(s) {
  if (!s) return '';
  const ended = s.ended ? [s.ended.type, ...(s.ended.names || [])].join(',') : '';
  return [s.round, s.p, s.user.pos, s.user.ex, ended, ...s.opps.map(o => [o.name, o.pos, o.ex, o.present].join(':'))].join('|');
}
function domPass() {
  const chatEl = document.getElementById('chat'); if (!chatEl) return;
  const s = SC.state;
  // 最新一层 AI 楼（战况面板挂这里）
  let target = null;
  if (s && !s.cleared) {
    const mess = chatEl.querySelectorAll('.mes');
    for (let i = mess.length - 1; i >= 0; i--) {
      const el = mess[i];
      if (el.getAttribute('is_user') === 'true' || el.getAttribute('is_system') === 'true') continue;
      const t = el.querySelector('.mes_text');
      if (t) { target = t; break; }
    }
  }
  for (const t of chatEl.querySelectorAll('.mes_text')) {
    const html = t.innerHTML; if (!html) continue;
    const out = replaceSceneBlocks(stripXml(html), t === target);
    if (out !== html) t.innerHTML = out;
  }
  // 非最新楼的战况面板移除（场景卡保留）
  chatEl.querySelectorAll('.mes_text .scx-inline.scx-live').forEach((el) => {
    if (el.closest('.mes_text') !== target) el.remove();
  });
  // 最新楼战况面板：签名变了才刷新内容
  if (target) {
    const panel = target.querySelector('.scx-inline.scx-live');
    if (panel) {
      const sig = scxSig(s);
      if (panel.dataset.scxSig !== sig) {
        panel.dataset.scxSig = sig;
        const body = panel.querySelector('.scx-inline-body');
        if (body) body.innerHTML = panelInner(s);
      }
    }
  }
}

// 提示词层：
// - chat completion 通道：剥 assistant 历史（主聊天上轮申报不会泄露给 AI）；RUBY 自身分析载荷的
//   聊天正文在 user 消息里、破限在 system/assistant 首条——均不受影响；
//   世界书注入的情潮开局/阶段走独立消息，不在 assistant 历史里，不会被误删。
// - 文本补全通道：final prompt 是单串（含世界书条目），只剥 <report> 块——情潮 XML 必须保留（引擎指导靠它）。
function ensurePromptHide() {
  const c = ctx(); if (!c?.eventSource || !c?.eventTypes) return;
  const mainIsOpenai = c.mainApi === 'openai';
  if (mainIsOpenai && !SC.promptHook) {
    SC.promptHook = (generateData) => {
      if (!SC.booted || !Array.isArray(generateData?.messages)) return;
      for (const m of generateData.messages) {
        if (m?.role !== 'assistant') continue;
        if (typeof m.content === 'string') { const s = stripXml(m.content); if (s !== m.content) m.content = s; }
        else if (Array.isArray(m.content)) m.content.forEach((p) => { if (typeof p?.text === 'string') p.text = stripXml(p.text); });
      }
    };
    c.eventSource.on(c.eventTypes.CHAT_COMPLETION_SETTINGS_READY, SC.promptHook);
    log('[性斗] RUBY 代行隐藏已挂载（提示词层 · chat completion）');
  }
  if (!mainIsOpenai && !SC.textgenHook) {
    SC.textgenHook = (generateData) => {
      if (!SC.booted || typeof generateData?.prompt !== 'string') return;
      const s = generateData.prompt.replace(/<report>[\s\S]*?<\/report>/gi, '');
      if (s !== generateData.prompt) generateData.prompt = s;
    };
    c.eventSource.on(c.eventTypes.GENERATE_AFTER_DATA, SC.textgenHook);
    log('[性斗] RUBY 代行隐藏已挂载（提示词层 · 文本补全）');
  }
  SC.mainApiIsOpenai = mainIsOpenai;
}

// ── 场景判断条目（纯格式注入；触发词从配置读，清空=不启用性斗触发） ──
function scTag() { return cfg().sceneTag || 'SceneInfo'; }
function tagReEsc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function trigRe() {
  const t = String(cfg().trigger || '').trim();
  return t ? new RegExp(t, 'i') : null;
}
// 场景判断条目——只做纯格式：场景块 + 触发词定义。
// report 协议/数值权威/不应期纪律属战斗期内容，由情潮开局/收场等动态注入承担，不在此常驻条目里。
function ruleT() {
  const tag = scTag();
  const t = String(cfg().trigger || '').trim();
  const T = t.toUpperCase();
  const lines = [
    '<' + tag + '>',
    '地点：具体地点',
    '时间：YYYY年MM月DD日 周X 时段 HH:MM',
    '场景类型：SFW / NSFW' + (T ? ' / ' + T : ''),
    '在场角色：',
    '- 角色名|状态',
    '</' + tag + '>',
    '每层回复末尾必须输出上述 <' + tag + '> 块（放正文最后）。',
  ];
  if (T) {
    lines.push(
      T + '=真正发生性行为（性器相接即算）。',
      '场景类型为 ' + T + ' 时，正文末尾 <' + tag + '> 之后附 <report>（其余楼层禁止输出 <report>）。',
      '<report> 协议（' + T + ' 楼必附）：',
      '<report>',
      '角色名:',
      '  单向: 0-3（次数）',
      '  双向: 0-2（次数）',
      '</report>',
      '数值权威：进展与结果以战况通报为准，照数值写，不粉饰不翻转。',
      '不应期纪律：已到顶角色进入不应期——敏感度大幅钝化，性刺激不引发反应；禁止继续主动性行为。',
    );
  }
  return lines.join('\n');
}
// ── 状态 ──
function rollP(lo, hi) { if (hi <= lo) return lo; return Math.round(lo + (hi - lo) * ((d(100) + d(100)) / 2) / 100); }
function st0() { return { active:true, startFloor:0, lastSettledFloor:-1, round:0, p:50, scanFloor:1, user:{pos:0,ex:0}, opps:[], ended:null, endedFloor:0, cleared:false }; }
function stageOf(e) { return Math.max(0, Math.min(5, Math.ceil(e / 20))); }
function newB(fl, chars) {
  const uLv = lvI(expOf(uName()));
  const maxOLv = Math.max(...chars.map(n => lvI(expOf(n))), uLv);
  SC.state = st0();
  Object.assign(SC.state, { startFloor:fl, scanFloor:fl+1, p:rollP(lvD(uLv).min, lvD(maxOLv).min), opps:chars.map(n => ({name:n, pos:100, ex:0, exited:false, present:true})) });
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
// ── 识别：触发词必须出现在场景块（类型判断）里；角色名宽松抓取，其余格式不关注 ──
function pScene(mes) {
  const m = String(mes || '');
  const tag = tagReEsc(scTag());
  const blockM = m.match(new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
  const hard = !!blockM && !!trigRe()?.test(blockM[1]); // 触发词一定在场景块内（场景类型字段）
  const chars = [];
  const push = (n) => {
    n = String(n || '').trim().replace(/^[-•*·—]\s*/, '');
    if (!n || n.length > 20 || chars.includes(n) || n === uName()) return;
    if (/^(无|暂无|无人|none)$/i.test(n)) return;
    chars.push(n);
  };
  // ① 场景块存在时，宽松抓“在场角色”区：有无杠前缀、有无状态列都无所谓
  if (blockM) {
    const cm = blockM[1].match(/在场角色\s*[：:]\s*([\s\S]*?)(?=\n\s*\n|\n\s*<|$)/i);
    if (cm) cm[1].split(/\r?\n/).forEach((l) => {
      let t = l.trim();
      if (!t) return;
      t = t.replace(/^[-•*·—]\s*/, '');
      if (/^[^|]{0,8}[：:]/.test(t)) return;   // 跳过“地点：/时间：”等标签行
      if (t.includes('|')) { push(t.split('|')[0]); return; }
      t.split(/[、，,]/).forEach(push);          // 无状态列：一行多人（顿号/逗号分隔）
    });
  }
  // ② 底账登记的角色名字出现在正文里也算在场——场景块漏写角色区照样开局
  const il = cfg().initialLevels || {};
  Object.keys(il).forEach((n) => { if (n && n !== uName() && m.includes(n)) push(n); });
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
  return '【情潮战况】\n高潮条：' + u + ' 距顶' + uD + '｜' + op + '\n从容：' + cal + ' 更从容（以此最新战况为准）';
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
  const parts = [stageT(uName(), s.user.ex)];
  s.opps.forEach(o => { if (!o.exited && o.present !== false) parts.push(stageT(o.name, o.ex)); });
  return parts.filter(Boolean).join('\n');
}
function d1T(n) { return '<情潮指南 类型="不应期" 角色="' + n + '">\n扮演指导：' + n + '已进入不应期——敏感度大幅钝化，性刺激不引发反应。写：不应期身体事实、余韵。不写：性刺激引发的反应。\n</情潮指南>'; }
function d2T(n) { return '<情潮指南 类型="user高潮后反应" 角色="' + n + '">\n扮演指导：' + n + '还没到顶，悬在半途。反应按性格：假高潮（破绽可见）/嘲讽/失望/宽慰/照顾；催促=他还动着时她推他，他射了她才接话。\n</情潮指南>'; }
function bOpp(n) { return '<情潮收场 类型="对手高潮" 角色="' + n + '">\n写作指导：' + n + '已高潮进入不应期——写其后状态与余韵。禁止继续主动性行为。\n</情潮收场>'; }
function bUser(n) { return '<情潮收场 类型="user高潮">写作指导：' + uName() + '已高潮进入不应期——禁止再写性行为。' + n + '的反应按人设：假高潮/嘲讽/安慰/口头认下。\n</情潮收场>'; }
function bFl() { return '<情潮收场 类型="疲软收场">写作指导：双方均进入不应期——性行为无法继续。写疲软与收束。无人到顶。禁止继续性行为。\n</情潮收场>'; }
function bWin() { return '<情潮收场 类型="user胜利终局">写作指导：在场对手全部高潮进入不应期——写' + uName() + '的从容，由其决定如何对待众人。\n</情潮收场>'; }

// ── 持久化 ──
// 对齐县城范式：世界书 = 数据（绿灯：当局/经验/等级）+ 两类蓝灯
// （类型判断指令 @D0 自愈 + 战况通报随战斗每层刷新——战况/阶段/收场指导合一，不再拆多条）；
// 正文 = 渲染（SceneInfo 块替换为场景卡+战况面板，见 domPass）。
function persist() {
  const s = SC.state; if (!s) return;
  writeE(K.state, JSON.stringify(s), { constant: false, comment: '当局' });
  const expL = Object.keys(SC.exp).map(n => '  ' + n + ': ' + SC.exp[n]).join('\n');
  writeE(K.exp, expL, { constant: false, comment: '经验总档' });
  s.opps.forEach(o => writeE(K.lp + o.name, '等级: ' + L[lvI(o.name)].n + '\n经验: ' + expOf(o.name), { constant: false, comment: '等级' }));
  writeE(K.lp + uName(), '等级: ' + L[lvI(uName())].n + '\n经验: ' + expOf(uName()), { constant: false, comment: '等级' });
  if (s.cleared) {
    // 清场：战况通报清空（类型判断指令条目保留——下一局开局判定仍靠它）；旧版条目退役清理
    writeE(K.report, '', { constant: false });
    writeE(K.open, '', { constant: false });
    writeE(K.stage, '', { constant: false });
    clearEndEntries(s);
  } else {
    let text;
    if (!s.ended) {
      text = battleT();
      const st = stageTAll();
      if (st) text += '\n\n' + st;
    } else {
      const e = s.ended;
      if (e.type === 'opp') text = (e.names || []).map(n => bOpp(n)).join('\n\n');
      else if (e.type === 'user') text = bUser((s.opps.find(o => o.present !== false) || {}).name || '对手');
      else if (e.type === 'flaccid') text = bFl();
      else text = bWin();
    }
    writeE(K.report, text, { constant: true, ord: 900, comment: '战况通报' });
  }
}

// 收场条目按当局 ended 类型清空（旧版遗留清理，停用用）
function clearEndEntries(s) {
  const e = s?.ended; if (!e) return;
  if (e.type === 'opp') (e.names || []).forEach((n, i) => writeE('通用性斗_收场_' + (n || i), '', { constant: false }));
  else if (e.type === 'user') writeE('通用性斗_收场_user', '', { constant: false });
  else if (e.type === 'flaccid') writeE('通用性斗_收场_疲软', '', { constant: false });
  else writeE('通用性斗_收场_胜利', '', { constant: false });
}

// ── 类型判断蓝灯条目（常驻指令，自愈：消失/被清/内容过期/被禁用 → 立即注回） ──
async function ensureRule() {
  const c = ctx();
  const wantPos = cfg().ruleWhere === 'head' ? 1 : 4;
  if (cfg().ruleEnabled === false) {
    const rec = await readE(K.rule);
    if (rec && String(rec.content || '').trim()) await writeE(K.rule, '', { constant: false, comment: '场景判断' });
    return;
  }
  const want = ruleT();
  const rec = await readE(K.rule);
  const cur = rec && rec.content !== undefined ? String(rec.content) : '';
  if (!cur.trim() || cur.trim() !== want.trim()) {
    // 位置映射：正文前=角色后（对话前）；正文后/自定义XML之后=@D0（正文之后）
    await writeE(K.rule, want, { constant: true, pos: wantPos, depth: wantPos === 4 ? 0 : undefined, ord: 999, comment: '场景判断' });
    return;
  }
  if (!rec) return;
  // 字段级自愈：内容正确但位置/深度/order/蓝灯/禁用是错误时代残留 → 逐项修正
  const file = q(rec.book || 'chat');
  const fixes = [];
  if (rec.constant !== true) fixes.push(['constant', 1]);
  if (parseInt(rec.position, 10) !== wantPos) fixes.push(['position', wantPos]);
  if (wantPos === 4 && parseInt(rec.depth, 10) !== 0) fixes.push(['depth', 0]);
  if (parseInt(rec.order, 10) !== 999) fixes.push(['order', 999]);
  for (const [field, value] of fixes) {
    try { await st(`/setentryfield file=${file} uid=${rec.uid} field=${field} ${value}`); } catch { /* 修正失败下次再试 */ }
  }
  if (fixes.length) log('[性斗] 场景判断条目字段自愈 ×' + fixes.length);
  // 条目在但被手动禁用 → 重新点亮
  if (rec.disabled && rec.uid !== undefined && c) {
    try { await st('/setentryfield file=' + file + ' uid=' + rec.uid + ' field=disable 0'); } catch { /* 点亮失败下次再试 */ }
  }
}
// ── 正文注入（三位置，随格式保护机制）：战局标签（战况/开局/阶段/收场）写进最新一层 AI 消息正文 ──
// 'head'=正文前 | 'tail'=正文后 | 'anchor'=自定义XML之后（战局标签在类型判断启用时锚=类型判断块）
// 显示被隐藏正则/DOM代行洗掉；AI 经下一层历史读到（提示词层只剥 report，不剥引擎注入块）。
function findScxAnchorLine(lines, tags) {
  for (const tag of tags) {
    const t = tagReEsc(tag); if (!t) continue;
    const closeRe = new RegExp('^\\s*<\\/' + t + '\\s*>\\s*$', 'i');
    const openRe = new RegExp('^\\s*<' + t + '[\\s>/]', 'i');
    for (let i = 0; i < lines.length; i++) if (closeRe.test(lines[i])) return i + 1;
    for (let i = 0; i < lines.length; i++) if (openRe.test(lines[i])) return i + 1;
  }
  return -1;
}
function stripScxBlocks(mes, applied) {
  let out = String(mes || '');
  for (const b of applied) { const t = String(b || '').trim(); if (t) out = out.split(t).join(''); }
  return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '');
}
function applyScxBlocks(mes, blocks) {
  const heads = [], tails = [], anchored = [];
  for (const b of blocks) {
    if (!b?.text) continue;
    if (b.where === 'head') heads.push(b.text);
    else if (b.where === 'tail') tails.push(b.text);
    else anchored.push(b);
  }
  let lines = mes.split('\n');
  const offMap = {};
  for (const b of anchored) {
    const idx = findScxAnchorLine(lines, b.anchorTags || []);
    if (idx < 0) { tails.push(b.text); continue; }
    const key = (b.anchorTags || []).join(',');
    const at = idx + (offMap[key] || 0);
    const bl = b.text.split('\n');
    lines.splice(at, 0, ...bl, '');
    offMap[key] = (offMap[key] || 0) + bl.length + 1;
  }
  let out = lines.join('\n');
  if (heads.length) out = heads.join('\n') + '\n\n' + out;
  if (tails.length) out = out + '\n\n' + tails.join('\n');
  return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '');
}
function buildScxBlocks() {
  // 战局内容已回归世界书蓝灯条目（persist），正文不再注入 XML 块——返回空，
  // syncBlocks 仅据此剥除旧版本行注入的残留块。
  return [];
}
// 同步到最新一层 AI 消息：先剥本插件此前注入的旧块（按记录文本），再按当前状态重插——幂等
async function syncBlocks() {
  const c = ctx(); if (!c?.chat?.length) return;
  const idx = c.chat.length - 1;
  const m = c.chat[idx];
  if (!m || m.is_user || m.is_system) return;
  const mes = String(m.mes || ''); if (!mes.trim()) return;
  m.extra ||= {};
  const applied = Array.isArray(m.extra.rubyScxBlocks) ? m.extra.rubyScxBlocks : [];
  let out = stripScxBlocks(mes, applied);
  const blocks = buildScxBlocks();
  if (blocks.length) {
    out = applyScxBlocks(out, blocks);
    m.extra.rubyScxBlocks = blocks.map(b => b.text);
  } else if (applied.length) {
    delete m.extra.rubyScxBlocks;
  }
  if (out !== mes) {
    m.mes = out;
    try { if (typeof c.updateMessageBlock === 'function') c.updateMessageBlock(idx, m); } catch { /* 渲染失败不影响数据 */ }
    try { if (typeof c.saveChat === 'function') c.saveChat(); } catch { /* 保存失败下次事件重对齐 */ }
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
      log('[性斗] 清场 @楼' + last); SC.state.cleared = true; await persist(); SC.state = null; domPass(); await safe(syncBlocks); return;
    }
    let scan = SC.state?.active ? Math.max(SC.state.scanFloor || SC.state.startFloor, SC.state.startFloor, SC.state.lastSettledFloor + 1) : last;
    const TRr = trigRe();
    for (let f = Math.min(scan, last); f <= last; f++) {
      const msg = c.chat[f]; if (!msg || msg.is_user) continue;
      const m = msg.mes || '';
      const rep = pRep(m);
      if (SC.state?.active && !SC.state.ended && rep && f !== SC.state.lastSettledFloor) {
        const scF = pScene(m);
        const inR = scF.chars.some(n => SC.state.opps.some(o => o.name === n && !o.exited)) || Object.keys(rep).some(n => n !== uName() && SC.state.opps.some(o => o.name === n && !o.exited));
        if (scF.chars.length && !inR) restart(f, scF.chars); else syncR(scF.chars);
        log('[性斗] 结算 @楼' + f); settle(rep, f, c); if (SC.state.ended) break;
      } else if (!SC.state?.active && TRr && TRr.test(m)) {
        const sc = pScene(m);
        if (sc.hard && sc.chars.length) { log('[性斗] 开局 @楼' + f, '角色：' + sc.chars.join('、')); newB(f, sc.chars); const r0 = pRep(m); if (r0) settle(r0, f, c); if (SC.state.ended) break; }
        else if (TRr.test(m)) { log('[性斗] 触发词已命中但未开局 @楼' + f, sc.hard ? '（未识别到在场角色：场景块缺在场角色区，且底账未登记任何出场角色）' : '（触发词不在场景块的场景类型里）'); }
      } else if (SC.state?.active && !SC.state.ended && TRr && TRr.test(m)) {
        const scF = pScene(m);
        if (scF.hard && scF.chars.length && !scF.chars.some(n => SC.state.opps.some(o => o.name === n && !o.exited))) restart(f, scF.chars); else syncR(scF.chars);
      }
    }
    if (SC.state) SC.state.scanFloor = Math.max(SC.state.scanFloor || SC.state.startFloor, last + 1);
    persist();
    await safe(ensureRule);
    await safe(syncBlocks);
  } catch (e) { warn('[性斗] tick 失败:', e?.message || e); } finally { domPass(); }
}
function restart(fl, chars) { log('[性斗] 换人重开 @楼' + fl); newB(fl, chars); }

// ── 面板 ──
// 面板内层 HTML：正文内情潮面板共用
function panelInner(s) {
  if (!s) return '';
  if (s.ended) {
    const n = s.ended.names?.join('、') || '对方';
    const t = s.ended.type === 'user' ? '再怎么努力也忍不住——高潮将至。' + n + '技高一筹。' : s.ended.type === 'opp' ? n + '已到顶——高潮将至。' + uName() + '技高一筹。' : s.ended.type === 'flaccid' ? '疲软将至——谁也没赢。' : '全胜。';
    return '<div class="scx-end">' + esc(t) + '</div>';
  }
  const uD = Math.max(0, s.p - s.user.pos);
  let bars = '';
  s.opps.forEach(o => {
    let sg = ''; for (let i = 0; i < 5; i++) sg += '<div class="scx-gseg' + (i < stageOf(o.ex) ? ' s' + stageOf(o.ex) : '') + '"></div>';
    let usg = ''; for (let i = 0; i < 5; i++) usg += '<div class="scx-gseg' + (i < stageOf(s.user.ex) ? ' s' + stageOf(s.user.ex) : '') + '"></div>';
    bars += '<div class="scx-opprow' + (o.present === false ? ' gone' : '') + '"><div class="scx-oppname">' + esc(o.name) + '·' + L[lvI(o.name)].n + (o.present === false ? '·未在场' : '') + '</div>' +
      '<div class="scx-climax"><div class="scx-pheart" style="left:' + s.p + '%">' + H + '</div><div class="scx-pline" style="left:' + s.p + '%"></div>' +
      '<div class="scx-track"><div class="scx-trail user" style="width:' + s.user.pos + '%"></div><div class="scx-trail opp" style="width:' + (100 - o.pos) + '%"></div>' +
      '<div class="scx-ptr user" style="left:' + s.user.pos + '%">' + H + '</div><div class="scx-ptr opp" style="left:' + o.pos + '%">' + H + '</div></div></div>' +
      '<div class="scx-grow"><div class="scx-glabel"><span class="scx-gdot opp"></span>兴奋</div><div class="scx-gsegs">' + sg + '</div><div class="scx-gpill">' + S5[Math.max(0, stageOf(o.ex) - 1)] + '</div></div>' +
      '<div class="scx-grow"><div class="scx-glabel"><span class="scx-gdot user"></span>兴奋</div><div class="scx-gsegs">' + usg + '</div><div class="scx-gpill">' + S5[Math.max(0, stageOf(s.user.ex) - 1)] + '</div></div>';
  });
  return '<div class="scx-namerow"><div class="scx-chip"><span class="scx-av user">你</span><span>' + esc(uName()) + '<small class="scx-lv">' + L[lvI(expOf(uName()))].n + '</small></span></div>' +
    '<div class="scx-chip"><span class="scx-av opp">彼</span><span>' + esc(s.opps.map(o => o.name).join('、')) + '</span></div></div>' + bars +
    '<div class="scx-fatigue"><span class="scx-ftag">疲软</span><div class="scx-ftrack"><div class="scx-ffill" style="width:' + s.round * 10 + '%"></div></div><span class="scx-fnum">' + s.round + '/10</span></div>';
}
function bindEvents() {
  const c = ctx(); if (!c?.eventSource || !c?.eventTypes) { setTimeout(bindEvents, 1000); return; }
  if (SC.bound) return; SC.bound = true;
  c.eventSource.on(c.eventTypes.GENERATION_ENDED, tick);
  c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => { SC.lastFloor = -1; tick(); });
  c.eventSource.on(c.eventTypes.MESSAGE_RECEIVED, (_id, type) => { if (type === 'first_message') tick(); });
  c.eventSource.on(c.eventTypes.MESSAGE_EDITED, () => { safe(syncBlocks); });
  c.eventSource.on(c.eventTypes.MESSAGE_SWIPED, () => { SC.lastFloor = -1; tick(); });
  log('[性斗] 事件绑定完成');
}

// ── 启停 ──
async function start() {
  if (SC.booted) return; SC.booted = true;
  ensureRe(); ensureDomHide(); ensurePromptHide(); bindEvents();
  hydrateCfg();
  await ensureRule();
  // 退役条目清理：开局/阶段状态（并入战况通报）与旧版收场条目
  for (const k of [K.open, K.stage]) writeE(k, '', { constant: false });
  try {
    const legacyEnds = await worldbook.readChatBookEntries('通用性斗_收场', { all: true });
    (legacyEnds || []).forEach(r => writeE(r.keys?.[0] || ('通用性斗_收场_' + r.uid), '', { constant: false }));
  } catch { /* 清理失败不影响主流程 */ }
  const rec = await readE(K.state);
  const body = rec?.content ? String(rec.content) : '';
  const jm = body.match(/\{[\s\S]*\}/);
  if (jm) { try { SC.state = JSON.parse(jm[0]); } catch {} }
  if (SC.state && SC.state.cleared) SC.state = null; // 已清场的陈旧状态直接丢弃，不再逐层空写
  const expR = await readE(K.exp);
  const eb = expR?.content ? String(expR.content) : '';
  eb.split(/\r?\n/).forEach(l => { const m = l.trim().match(/^([^:：]+)[:：]\s*(\d+)\s*$/); if (m) SC.exp[m[1].trim()] = parseInt(m[2], 10); });
  SC.ready = true;
  log('[性斗] 已启动');
  tick();
}
async function stop() {
  for (const k of [K.report, K.rule, K.open, K.stage]) await writeE(k, '', { constant: false });
  try {
    const legacyEnds = await worldbook.readChatBookEntries('通用性斗_收场', { all: true });
    (legacyEnds || []).forEach(r => writeE(r.keys?.[0] || ('通用性斗_收场_' + r.uid), '', { constant: false }));
  } catch { /* 清理失败不影响主流程 */ }
  await writeE(K.state, '', { constant: false });
  SC.exp = {}; SC.state = null; SC.booted = false; SC.ready = false; domPass();
  log('[性斗] 已停用');
}

// ── 库 API ──
export function levelNameFor(e) { return L[lvI(parseInt(e, 10) || 0)].n; }
export function getLevels() { const o = {}; Object.keys(cfg().initialLevels).forEach(n => { o[n] = cfg().initialLevels[n]; }); Object.keys(SC.exp).forEach(n => { o[n] = SC.exp[n]; }); return o; }
// 创作者底账（不含战斗运行态经验）——内置脚本 UI 列表与保存写卡用
export function getBaseLevels() { return { ...cfg().initialLevels }; }
export function setInitLevel(n, e) { const c = cfg(); c.initialLevels = c.initialLevels || {}; c.initialLevels[n] = parseInt(e, 10) || 0; SC.exp[n] = parseInt(e, 10) || 0; config.persist(); }
export function removeInitLevel(n) { delete cfg().initialLevels[n]; delete SC.exp[n]; (async () => { await writeE(K.lp + n, '', { constant: false }); })(); config.persist(); }
export function entryWrite(key, content, opts) { return writeE(key, content, opts); }
export async function entryRead(key, book) { return readE(key, book); }
export function getScriptCfg() { return cfg(); }
export function saveScriptCfg() { config.persist(); if (SC.booted) { safe(ensureRule); safe(syncBlocks); } }
export function getStatus() { const k = cardKey(); return { supported: !!k, enabled: isEnabled(), cardName: k ? (config.getCharacterIdentity()?.name || '') : '' }; }
async function safe(fn) { try { await fn(); } catch (e) { warn('[性斗] 失败:', e?.message || e); } }
export async function toggle() { const v = !isEnabled(); setEnabled(v); if (v) await safe(start); else await safe(stop); return isEnabled(); }

// 换卡/重进自动恢复：CHAT_CHANGED 后按当前卡配置重新武装（卡内创作者配置水合为准）
function refresh() {
  hydrateCfg();
  if (SC.booted) ensurePromptHide(); // 主API可能在运行中切换，补挂对应通道的提示词钩
  if (isEnabled()) { if (!SC.booted) safe(start); } else if (SC.booted) safe(stop);
}
export function init() {
  const c = ctx(); if (!c?.eventSource || !c?.eventTypes) { setTimeout(init, 1000); return; }
  c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => { SC.lastFloor = -1; refresh(); });
  refresh();
}




