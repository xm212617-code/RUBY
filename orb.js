import * as config from './config.js';
import * as engine from './engine.js';
import * as cardwriter from './cardwriter.js';
import { openPanel } from './panel.js';
import { ORB_AVATAR_DATA_URI } from './orb-avatar.js';

const ORB_ID = 'ruby_analyzer_orb';
const DRAG_THRESHOLD = 6;
const ORB_DEFAULT_SIZE = 60;
// 贴边吸附：距屏幕边小于该值松手即吸附；吸附后按比例只露出一小条，点击弹回
const SNAP_THRESHOLD = 32;
const SNAP_PEEK_RATIO = 0.42;
const SNAP_PEEK_MIN = 18;

function getOrbSize() {
    return config.clampOrbSize(config.getUi()?.orbSize ?? ORB_DEFAULT_SIZE);
}

/** 贴边吸附是否开启（默认开启） */
function isSnapEnabled() {
    return config.getUi()?.orbSnap !== false;
}

/** 读取持久化的贴边状态（兼容旧数据：非数组一律视为未贴边） */
function getDockedEdges() {
    const dock = config.getUi()?.orbDock;
    return Array.isArray(dock) && dock.length > 0 ? dock : null;
}

/** 按设置应用悬浮球尺寸（徽章与描边按比例缩放） */
function applySize(orb) {
    const size = getOrbSize();
    orb.style.width = `${size}px`;
    orb.style.height = `${size}px`;
    const badge = orb.querySelector('.ruby-orb-badge');
    if (badge) {
        const badgeSize = Math.max(14, Math.round(size * 0.37));
        const border = size < 44 ? 2 : 3;
        badge.style.width = `${badgeSize}px`;
        badge.style.height = `${badgeSize}px`;
        badge.style.borderWidth = `${border}px`;
        const svg = badge.querySelector('svg');
        if (svg) svg.style.width = svg.style.height = `${Math.max(8, Math.round(badgeSize * 0.5))}px`;
    }
}

const BADGE_ICONS = {
    idle: '<svg viewBox="0 0 24 24" fill="#14161f"><circle cx="12" cy="12" r="5"/></svg>',
    armed: '<svg viewBox="0 0 24 24" fill="none" stroke="#14161f" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5.5 5.5L20 6.5"/></svg>',
    working: '<svg viewBox="0 0 24 24" fill="#fff"><circle cx="12" cy="12" r="6"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    cardwriting: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
};

let dragState = null;
let bubbleEl = null;
let bubbleTimer = null;
let lastBubbleStep = null;

function defaultPosition() {
    const size = getOrbSize();
    return {
        x: Math.max(12, window.innerWidth - size - 24),
        y: Math.min(window.innerHeight - 180, Math.max(120, window.innerHeight * 0.55)),
    };
}

function applyPosition(orb, pos) {
    const pad = getOrbSize() + 8;
    orb.style.left = `${Math.max(4, Math.min(window.innerWidth - pad, pos.x))}px`;
    orb.style.top = `${Math.max(4, Math.min(window.innerHeight - pad, pos.y))}px`;
}

// ---------- 贴边吸附 ----------

function setPos(orb, pos) {
    orb.style.left = `${pos.x}px`;
    orb.style.top = `${pos.y}px`;
}

/** 贴边后露出屏幕的像素（小尺寸球保底，保证露出的部分仍可点按/拖动） */
function peekSize() {
    return Math.max(SNAP_PEEK_MIN, Math.round(getOrbSize() * SNAP_PEEK_RATIO));
}

/** 拖动位置 → 待吸附的边（'left'/'right'/'top'/'bottom'，可组合成角落） */
function snapEdgesOf(pos) {
    const size = getOrbSize();
    const edges = [];
    if (pos.x <= SNAP_THRESHOLD) edges.push('left');
    else if (pos.x + size >= window.innerWidth - SNAP_THRESHOLD) edges.push('right');
    if (pos.y <= SNAP_THRESHOLD) edges.push('top');
    else if (pos.y + size >= window.innerHeight - SNAP_THRESHOLD) edges.push('bottom');
    return edges;
}

/** 贴边位置：被钉住的轴滑出屏幕只露 peek，自由轴沿用拖放位置并钳制在屏内 */
function dockedPos(dock, freeX, freeY) {
    const size = getOrbSize();
    const peek = peekSize();
    let x = freeX;
    let y = freeY;
    if (dock.includes('left')) x = peek - size;
    if (dock.includes('right')) x = window.innerWidth - peek;
    if (dock.includes('top')) y = peek - size;
    if (dock.includes('bottom')) y = window.innerHeight - peek;
    if (!dock.includes('left') && !dock.includes('right')) x = Math.max(8, Math.min(window.innerWidth - size - 8, x));
    if (!dock.includes('top') && !dock.includes('bottom')) y = Math.max(8, Math.min(window.innerHeight - size - 8, y));
    return { x, y };
}

/** 弹出位置：贴边球回到完全可见（沿钉住的轴回到屏内边缘） */
function popoutPos(dock, curX, curY) {
    const size = getOrbSize();
    let x = curX;
    let y = curY;
    if (dock.includes('left')) x = 8;
    if (dock.includes('right')) x = window.innerWidth - size - 8;
    if (dock.includes('top')) y = 8;
    if (dock.includes('bottom')) y = window.innerHeight - size - 8;
    return {
        x: Math.max(8, Math.min(window.innerWidth - size - 8, x)),
        y: Math.max(8, Math.min(window.innerHeight - size - 8, y)),
    };
}

let glideTimer = null;

/** 带动画滑到目标位置（贴边收起 / 弹出），结束后摘除过渡类避免影响拖动跟手 */
function glideTo(orb, pos) {
    orb.classList.add('docking');
    setPos(orb, pos);
    clearTimeout(glideTimer);
    glideTimer = setTimeout(() => orb.classList.remove('docking'), 340);
}

/** 按持久化的贴边状态无动画重摆位置（初始化 / resize / 尺寸变化）。
 * 初始化时 style 尚未赋值，parseFloat 得 NaN——必须回退到持久化坐标或默认位置，
 * 否则 "NaNpx" 赋值被浏览器忽略，自由轴落到 static 位置（视口外），悬浮球会消失。 */
function reapplyDock(orb) {
    const dock = getDockedEdges();
    if (!dock) return false;
    orb.classList.remove('docking');
    const px = parseFloat(orb.style.left);
    const py = parseFloat(orb.style.top);
    const ui = config.getUi();
    const def = defaultPosition();
    setPos(orb, dockedPos(
        dock,
        Number.isFinite(px) ? px : (Number.isFinite(ui.orbX) ? ui.orbX : def.x),
        Number.isFinite(py) ? py : (Number.isFinite(ui.orbY) ? ui.orbY : def.y),
    ));
    return true;
}

function badgeState(engineState) {
    const cw = cardwriter.getState();
    if (cw.active && cw.busy) return 'cardwriting';
    if (engineState.running) return 'working';
    if (engineState.lastError || cw.lastError) return 'error';
    if (cw.active) return 'cardwriting';
    if (engineState.armed) return 'armed';
    return 'idle';
}

function setStatus(orb, engineState) {
    const badge = orb.querySelector('.ruby-orb-badge');
    if (!badge) return;
    const cw = cardwriter.getState();
    const state = badgeState(engineState);
    badge.dataset.state = state;
    badge.innerHTML = BADGE_ICONS[state] || BADGE_ICONS.idle;
    if (cw.active && cw.busy) {
        orb.title = `RUBY写卡中… ${cw.stepId || ''}（正在处理完成标记/切换步骤）`;
    } else if (cw.active) {
        orb.title = `RUBY写卡会话 · 当前步骤 ${cw.stepId || '—'} ${cw.stepName || ''}（点击打开写卡面板）`;
    } else if (engineState.running) {
        orb.title = `RUBY 分析中… ${engineState.charName}`;
    } else if (engineState.lastError || cw.lastError) {
        orb.title = `RUBY 错误：${engineState.lastError || cw.lastError}`;
    } else if (engineState.armed) {
        const pos = engineState.cycleLength > 0 ? `${engineState.position}/${engineState.cycleLength}` : '-';
        orb.title = `RUBY 运行中 · ${engineState.charName} · AI回复 ${engineState.aiCount} · 周期位置 ${pos}（点击打开面板）`;
    } else {
        orb.title = 'RUBY 待机（无角色、未配置任务或未绑定角色卡）— 点击打开面板';
    }
}

// ---------- 写卡步骤说明气泡 ----------

/** 源说明文本 → HTML：``` 围栏块转 <pre>（横向自动折行），普通行保留换行 */
function guideToHtml(guide) {
    const parts = String(guide || '').split(/```/);
    // 偶数索引 = 普通文本（含内建 HTML 标签），奇数索引 = 围栏块内容
    return parts.map((part, i) => {
        if (i % 2 === 1) {
            let body = part.replace(/^[a-zA-Z]*\r?\n/, '');
            body = body.replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
            return `<pre>${body.trim()}</pre>`;
        }
        return part.split(/\r?\n/).join('<br>');
    }).join('');
}

function showStepBubble(stepId) {
    // 先收起上一步的气泡：即使新步骤没有说明文本（Step5-8）也要确保旧气泡被关闭
    hideStepBubble();
    const step = cardwriter.getStep(stepId);
    if (!step || !step.guide) return;
    const orb = document.getElementById(ORB_ID);
    if (!orb) return;

    bubbleEl = document.createElement('div');
    bubbleEl.id = 'ruby_cw_bubble';
    bubbleEl.innerHTML = `
        <span class="cw-bubble-close">✕</span>
        <div class="cw-bubble-title">${stepId === 'Overview' ? '🏁' : '✍️'} ${stepId === 'Overview' ? '' : stepId + ' · '}${step.name}</div>
        <div class="cw-bubble-body">${guideToHtml(step.guide)}</div>`;
    // 先渲染但保持不可见，以便测量真实尺寸（display:none 下 getBoundingClientRect 全为 0，
    // 之前的边缘钳制因此从未生效，气泡显示后才会飞出屏幕）
    bubbleEl.style.display = 'block';
    bubbleEl.style.visibility = 'hidden';
    document.body.appendChild(bubbleEl);

    // 定位：优先悬浮球右侧，其次左侧、上方、下方；全程做视口边缘钳制，
    // 且避免覆盖悬浮球本身（否则气泡挡住球导致"卡死"）
    const MARGIN = 10;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const orbRect = orb.getBoundingClientRect();
    const bubbleRect = bubbleEl.getBoundingClientRect();
    const fits = (l, t) =>
        l >= MARGIN && t >= MARGIN &&
        l + bubbleRect.width <= vw - MARGIN &&
        t + bubbleRect.height <= vh - MARGIN;
    const overlapsOrb = (l, t) =>
        l < orbRect.right && l + bubbleRect.width > orbRect.left &&
        t < orbRect.bottom && t + bubbleRect.height > orbRect.top;

    const candidates = [
        { l: orbRect.right + 12, t: orbRect.top - 8 },              // 右侧
        { l: orbRect.left - bubbleRect.width - 12, t: orbRect.top - 8 }, // 左侧
        { l: orbRect.left, t: orbRect.top - bubbleRect.height - 12 },    // 上方
        { l: orbRect.left, t: orbRect.bottom + 12 },               // 下方
    ];
    let pos = candidates.find((p) => fits(p.l, p.t) && !overlapsOrb(p.l, p.t));
    if (!pos) pos = candidates.find((p) => fits(p.l, p.t));
    if (!pos) {
        // 视口太小放不下：四角钳制，保证完全在屏幕内
        pos = {
            l: Math.max(MARGIN, Math.min(vw - bubbleRect.width - MARGIN, orbRect.right + 12)),
            t: Math.max(MARGIN, Math.min(vh - bubbleRect.height - MARGIN, orbRect.top - 8)),
        };
        // 仍覆盖悬浮球时向上避开
        if (overlapsOrb(pos.l, pos.t)) {
            const above = pos.t - bubbleRect.height - 12;
            if (above >= MARGIN) pos.t = above;
        }
    }
    bubbleEl.style.left = `${pos.l}px`;
    bubbleEl.style.top = `${pos.t}px`;
    bubbleEl.style.visibility = 'visible';

    // details 展开/收起后高度变化：重新钳制在视口内（捕获 toggle，它不冒泡）
    bubbleEl.addEventListener('toggle', () => {
        const r = bubbleEl?.getBoundingClientRect();
        if (!r) return;
        if (r.bottom > vh - MARGIN) bubbleEl.style.top = `${Math.max(MARGIN, vh - r.height - MARGIN)}px`;
        if (r.right > vw - MARGIN) bubbleEl.style.left = `${Math.max(MARGIN, vw - r.width - MARGIN)}px`;
    }, true);

    // 安全设定：点击气泡任意位置关闭（✕按钮同样有效），防误触与遮挡。
    // 例外：展开/收起 details、拖动选中文本时不关。
    bubbleEl.addEventListener('click', (e) => {
        if (e.target.closest?.('details, details > *, a')) return;
        if (String(window.getSelection?.() || '') !== '') return;
        e.stopPropagation();
        hideStepBubble();
    });
    bubbleEl.querySelector('.cw-bubble-close')?.addEventListener('click', hideStepBubble);
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(hideStepBubble, 60000);
}

function hideStepBubble() {
    clearTimeout(bubbleTimer);
    bubbleTimer = null;
    if (bubbleEl) {
        bubbleEl.remove();
        bubbleEl = null;
    }
}

/** 按当前 UI 配置刷新悬浮球显隐（面板保存 / 扩展栏开关均调用） */
export function refreshVisibility() {
    const el = document.getElementById(ORB_ID);
    if (el) el.classList.toggle('hidden', !!config.getUi().orbHidden);
}

export function ensureOrb() {
    if (document.getElementById(ORB_ID)) return;

    const orb = document.createElement('div');
    orb.id = ORB_ID;
    orb.innerHTML = `
        <span class="ruby-orb-avatar" style="background-image:url('${ORB_AVATAR_DATA_URI}')"></span>
        <span class="ruby-orb-badge" data-state="idle">${BADGE_ICONS.idle}</span>
    `;
    document.body.appendChild(orb);
    applySize(orb);

    const ui = config.getUi();
    if (!reapplyDock(orb)) {
        applyPosition(orb, (Number.isFinite(ui.orbX) && Number.isFinite(ui.orbY)) ? { x: ui.orbX, y: ui.orbY } : defaultPosition());
    }
    refreshVisibility();

    orb.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        let originX = parseFloat(orb.style.left);
        let originY = parseFloat(orb.style.top);
        const dock = getDockedEdges();
        // 贴边态：先无动画弹回完全可见位置，再从这里开始拖动/响应点击
        if (dock) {
            const p = popoutPos(dock, originX, originY);
            orb.classList.remove('docking');
            setPos(orb, p);
            originX = p.x;
            originY = p.y;
        }
        dragState = {
            startX: e.clientX,
            startY: e.clientY,
            originX,
            originY,
            moved: false,
            wasDocked: !!dock,
        };
        try { orb.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
    });

    orb.addEventListener('pointermove', (e) => {
        if (!dragState) return;
        const dx = e.clientX - dragState.startX;
        const dy = e.clientY - dragState.startY;
        if (!dragState.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        if (!dragState.moved) {
            dragState.moved = true;
            hideStepBubble(); // 拖动时收起说明气泡，避免残影与遮挡
        }
        applyPosition(orb, { x: dragState.originX + dx, y: dragState.originY + dy });
        // 拖动中进入吸附范围：给一圈绿色光环提示"松手即贴边"
        const inRange = isSnapEnabled() && snapEdgesOf({ x: parseFloat(orb.style.left), y: parseFloat(orb.style.top) }).length > 0;
        orb.classList.toggle('snap-hint', inRange);
    });

    orb.addEventListener('pointerup', (e) => {
        if (!dragState) return;
        const moved = dragState.moved;
        const wasDocked = dragState.wasDocked;
        const pos = { x: parseFloat(orb.style.left), y: parseFloat(orb.style.top) };
        dragState = null;
        orb.classList.remove('snap-hint');
        try { orb.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        if (moved) {
            const edges = isSnapEnabled() ? snapEdgesOf(pos) : [];
            if (edges.length > 0) {
                const target = dockedPos(edges, pos.x, pos.y);
                glideTo(orb, target);
                config.saveUi({ orbX: target.x, orbY: target.y, orbDock: edges });
            } else {
                config.saveUi({ orbX: pos.x, orbY: pos.y, orbDock: null });
            }
        } else if (wasDocked) {
            // 贴边态点击 = 弹回完全可见（pointerdown 已就位，这里落盘；不开面板防误触）
            config.saveUi({ orbX: pos.x, orbY: pos.y, orbDock: null });
        } else {
            // 写卡会话激活时点击直达写卡页签，否则开主面板
            if (cardwriter.getState().active) {
                openPanel('cardwriter');
            } else {
                openPanel();
            }
        }
    });

    orb.addEventListener('pointercancel', () => {
        // pointercancel 时系统接管指针：贴边弹出途中被打断也要落盘，避免重启回到旧贴边位
        if (dragState?.wasDocked && !dragState.moved) {
            config.saveUi({ orbX: parseFloat(orb.style.left), orbY: parseFloat(orb.style.top), orbDock: null });
        }
        dragState = null;
        orb.classList.remove('snap-hint');
    });

    window.addEventListener('resize', () => {
        const el = document.getElementById(ORB_ID);
        if (el && !reapplyDock(el)) {
            applyPosition(el, { x: parseFloat(el.style.left), y: parseFloat(el.style.top) });
        }
        hideStepBubble();
    });

    // 面板保存 UI 配置时事件驱动刷新（替代轮询）：显隐 + 尺寸（贴边态下尺寸变化需按新尺寸重摆）
    window.addEventListener('ruby:ui-changed', () => {
        const el = document.getElementById(ORB_ID);
        if (el) {
            applySize(el);
            reapplyDock(el);
        }
        refreshVisibility();
    });

    setStatus(orb, engine.getEngineState());
    engine.onStateChange((engineState) => {
        const el = document.getElementById(ORB_ID);
        if (el) setStatus(el, engineState);
    });
    cardwriter.onStateChange((s) => {
        const el = document.getElementById(ORB_ID);
        if (el) setStatus(el, engine.getEngineState());
        // 步骤切换时弹出说明气泡（可关闭，60秒自动收起）；会话结束/空闲时收起气泡并复位标记
        if (!s.active || !s.stepId) {
            lastBubbleStep = null;
            hideStepBubble();
            return;
        }
        if (s.stepId !== lastBubbleStep) {
            lastBubbleStep = s.stepId;
            showStepBubble(s.stepId);
        }
    });
}
