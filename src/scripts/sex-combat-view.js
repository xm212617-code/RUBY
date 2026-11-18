const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const num = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : 0));
const stage = (ex) => Math.max(1, Math.min(5, 1 + Math.floor(num(ex) / 20)));
const levels = [
    { floor: 100, name: '魅魔' }, { floor: 50, name: '老手' }, { floor: 25, name: '经验' },
    { floor: 10, name: '新手' }, { floor: 0, name: '处子' },
];

export function renderSexCombatContent(snapshot) {
    const state = snapshot?.state;
    if (!state) {
        const error = snapshot?.error ? `<p class="sc-error">${esc(snapshot.error)}</p>` : '';
        if (!snapshot?.configured) return `${error}<div class="sc-empty">通用性斗尚未在当前角色卡启用</div>`;
        if (!(snapshot?.scene?.active || snapshot?.scene?.triggered) || !snapshot?.scene?.valid) return `${error}<div class="sc-empty">未检测到有效的通用性斗启动场景</div>`;
        const names = Array.isArray(snapshot.scene.roster) ? snapshot.scene.roster : [];
        const waitingPairs = names.length ? names.map((name) => `<section class="sc-pair"><div class="sc-pair-title"><span>${esc(name)}</span><span>等待首轮申报</span></div><div class="sc-track"><div class="sc-user-progress" style="width:0%"></div><div class="sc-rival-progress" style="width:0%"></div></div><div class="sc-distances"><span>你距顶 —</span><span>P 点待首轮初始化</span><span>对手距顶 —</span></div><div class="sc-gauges">${gauge('你', 0)}${gauge(name, 0)}</div></section>`).join('') : '<div class="sc-empty">等待解析在场角色</div>';
        return `<div class="sc-board"><div class="sc-topline"><div><div class="sc-title">情潮战况</div><div class="sc-subtitle">${esc(snapshot.scene.value || 'NSFWH')} 场景已识别</div></div><div class="sc-round">0<small> / 10 轮</small></div></div>${error}<div class="sc-waiting">等待本楼有效行动报告；收到后初始化 P 点并开始结算。</div><div class="sc-pairs">${waitingPairs}</div><div class="sc-fatigue"><span>疲软倒计时</span><div class="sc-fatigue-track"><div class="sc-fatigue-fill" style="width:0%"></div></div><b>0/10</b></div><div class="sc-level-legend">未登记角色默认经验 ${num(snapshot.defaultExperience, 0, 100)} · ${esc(levels.find((item) => item.floor <= num(snapshot.defaultExperience, 0, 100))?.name || '处子')}</div></div>`;
    }
    const user = state.user || {};
    const userP = num(state.p);
    const userPos = num(user.pos);
    const userDistance = Math.max(0, userP - userPos);
    const userEx = num(user.ex);
    const opps = Array.isArray(state.opps) ? state.opps : [];
    const active = opps.filter((opponent) => !opponent.exited);
    const pairBars = active.length ? active.map((opponent) => {
        const p = num(opponent.p, 0, 100);
        const position = num(opponent.pos, 0, 100);
        const distance = Math.max(0, position - p);
        const rivalEx = num(opponent.ex);
        const userMarker = Math.max(0, Math.min(100, userP));
        const rivalMarker = Math.max(0, Math.min(100, p));
        return `<section class="sc-pair"><div class="sc-pair-title"><span>${esc(opponent.name || '对手')} · ${esc(levelName(snapshot, opponent.name, opponent.lv))}</span><span>对手距顶 ${distance}</span></div><div class="sc-track"><div class="sc-user-progress" style="width:${userPos}%"></div><div class="sc-rival-progress" style="width:${100 - position}%"></div><i class="sc-p-mark" style="left:${userMarker}%"></i>${p !== userP ? `<i class="sc-p-mark sc-rival-p" style="left:${rivalMarker}%"></i>` : ''}<i class="sc-pointer sc-user-pointer" style="left:${userPos}%">♥</i><i class="sc-pointer sc-rival-pointer" style="left:${position}%">♥</i></div><div class="sc-distances"><span>你距顶 ${userDistance}</span><span>P ${userP}${p !== userP ? ` / ${p}` : ''}</span><span>对手距顶 ${distance}</span></div><div class="sc-gauges">${gauge('你', userEx)}${gauge(opponent.name || '对手', rivalEx)}</div></section>`;
    }).join('') : '<div class="sc-empty">当前没有仍在场的对手</div>';
    const round = num(state.round, 0, 10);
    const waiting = round === 0 && Number(state.lastSettledFloor) < Number(state.startFloor)
        ? '<div class="sc-waiting">NSFWH 场景已识别，等待本楼有效行动报告；当前为 0 / 10 轮。</div>'
        : '';
    const ending = state.ended ? `<div class="sc-ending">${esc(endingName(state.ended.type))}${state.ended.names?.length ? `：${state.ended.names.map(esc).join('、')}` : ''}</div>` : '';
    const error = snapshot.error ? `<div class="sc-error">${esc(snapshot.error)}</div>` : '';
    const result = Array.isArray(state.results) && state.results.length ? `<div class="sc-round-result">${state.results.map(esc).join('　·　')}</div>` : '';
    const usersLevel = levelName(snapshot, 'user', user.lv);
    return `<div class="sc-board"><div class="sc-topline"><div><div class="sc-title">情潮战况</div><div class="sc-subtitle">user · ${esc(usersLevel)} · 兴奋阶段 ${stage(userEx)}</div></div><div class="sc-round ${round >= 9 && !state.ended ? 'danger' : ''}">${round}<small> / 10 轮</small></div></div>${error}${ending}${waiting}<div class="sc-pairs">${pairBars}</div><div class="sc-fatigue"><span>疲软倒计时</span><div class="sc-fatigue-track"><div class="sc-fatigue-fill ${round >= 9 ? 'danger' : round >= 7 ? 'warning' : ''}" style="width:${round * 10}%"></div></div><b>${round}/10</b></div>${result}<div class="sc-level-legend">处子 0 · 新手 10 · 经验 25 · 老手 50 · 魅魔 100　｜　user累计 ${num(snapshot.levels?.user, 0, 100)}</div></div>`;
}

function gauge(name, experience) {
    const value = num(experience);
    return `<div class="sc-gauge"><div class="sc-gauge-label"><span>${esc(name)}兴奋</span><b>${value}/100 · 阶段${stage(value)}</b></div><div class="sc-gauge-track"><div class="sc-gauge-fill" style="width:${value}%"></div></div></div>`;
}

function levelName(snapshot, name, current) {
    const saved = snapshot?.levels?.[name];
    const total = Number.isFinite(Number(saved)) ? Number(saved) : levels[Math.max(0, Math.min(4, Number(current) || 0))].floor;
    return levels.find((level) => total >= level.floor)?.name || '处子';
}

function endingName(type) {
    return ({ user: '用户到达高潮点', opp: '对手到达高潮点', userWin: '全部对手退出', flaccid: '疲软终局', departed: '场景结束' })[type] || '本局结束';
}

export function buildSexCombatDocument(_config = {}) {
    const styles = `:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;padding:10px;background:transparent;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#26332c}.sc-board{--line:#c5d3c4;--muted:#76867a;max-width:900px;margin:0 auto;padding:14px;border:1px solid var(--line);border-radius:14px;background:linear-gradient(145deg,#fdfcf4,#f4f6ed);box-shadow:0 10px 28px #182c221c}.sc-topline{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.sc-title{font-size:16px;font-weight:850;letter-spacing:.12em;color:#244a37}.sc-subtitle,.sc-level-legend,.sc-distances{font-size:11px;color:var(--muted)}.sc-round{font-size:21px;font-weight:800;color:#315d49}.sc-round small{font-size:11px;font-weight:600}.sc-round.danger{color:#b84149}.sc-pairs{display:grid;gap:11px}.sc-pair{padding:10px 11px;border:1px solid var(--line);border-radius:10px;background:#ffffffd9}.sc-pair-title,.sc-gauge-label,.sc-distances,.sc-fatigue{display:flex;justify-content:space-between;align-items:center;gap:8px}.sc-pair-title{font-weight:750;margin-bottom:8px}.sc-track{height:21px;position:relative;overflow:hidden;border-radius:99px;background:linear-gradient(90deg,#f6e8e9,#edf2e9)}.sc-user-progress,.sc-rival-progress{position:absolute;top:0;bottom:0;border-radius:99px;opacity:.62}.sc-user-progress{left:0;background:linear-gradient(90deg,#e89b9c,#c95763)}.sc-rival-progress{right:0;background:linear-gradient(270deg,#9ab2dc,#6588bd)}.sc-p-mark{position:absolute;z-index:2;top:0;bottom:0;border-left:2px dashed #d19c47}.sc-rival-p{border-color:#6689b8}.sc-pointer{position:absolute;z-index:3;top:50%;font-style:normal;font-size:15px;line-height:1;transform:translate(-50%,-50%);text-shadow:0 1px 2px white}.sc-user-pointer{color:#c44756}.sc-rival-pointer{color:#5178b1}.sc-distances{margin-top:5px}.sc-gauges{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:8px}.sc-gauge{min-width:0;padding:7px 8px;border:1px solid #e0e7dc;border-radius:8px;background:#fbfcf8}.sc-gauge-label{font-size:11px;margin-bottom:5px}.sc-gauge-label b{font-size:10px;color:var(--muted)}.sc-gauge-track,.sc-fatigue-track{height:7px;overflow:hidden;border-radius:99px;background:#e9eee5}.sc-gauge-fill{height:100%;border-radius:inherit;background:linear-gradient(90deg,#a6d0b2,#4f8b69);transition:width .25s}.sc-fatigue{margin-top:11px;padding:8px 9px;border:1px solid #e5ddd2;border-radius:8px;background:#fff}.sc-fatigue-track{flex:1}.sc-fatigue-fill{height:100%;background:#78aa83;transition:width .25s}.sc-fatigue-fill.warning{background:#d2a147}.sc-fatigue-fill.danger{background:#c34f56}.sc-ending,.sc-error,.sc-empty,.sc-round-result,.sc-waiting{padding:8px 10px;border-radius:8px;background:#ffffffd9;margin-bottom:8px}.sc-waiting{border-left:3px solid #698ab6;color:#526f94}.sc-ending{border-left:3px solid #b7783c;font-weight:750}.sc-error{color:#943d43;border:1px solid #e3b8b8}.sc-empty{text-align:center;color:var(--muted)}.sc-level-legend{margin-top:9px;text-align:center}@media(max-width:560px){body{padding:6px}.sc-board{padding:9px}.sc-gauges{grid-template-columns:1fr}.sc-pointer{font-size:13px}}`;
    const script = `(function(){const nonce=Math.random().toString(36).slice(2)+Date.now().toString(36);function ask(){try{parent.postMessage({type:'ruby-sex-combat-view-request',nonce:nonce},'*')}catch(e){}}window.addEventListener('message',function(event){const data=event.data;if(!data||data.type!=='ruby-sex-combat-view-state'||data.nonce!==nonce)return;const node=document.querySelector('.sc-root');if(node)node.innerHTML=data.html||''});ask();setInterval(ask,1000)})();`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style></head><body><div class="sc-root" data-ruby-sex-combat="true">${renderSexCombatContent(null)}</div><script>${script.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}
