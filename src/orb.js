import * as config from './config.js';
import * as engine from './engine.js';
import * as cardwriter from './cardwriter.js';
import { openPanel } from './panel.js';
import { ORB_AVATAR_DATA_URI } from './orb-avatar.js';

const ORB_ID = 'ruby_analyzer_orb';
const DRAG_THRESHOLD = 6;
const ORB_DEFAULT_SIZE = 60;

function getOrbSize() {
    return config.clampOrbSize(config.getUi()?.orbSize ?? ORB_DEFAULT_SIZE);
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
    const step = cardwriter.getStep(stepId);
    if (!step || !step.guide) return;
    hideStepBubble();
    const orb = document.getElementById(ORB_ID);
    if (!orb) return;

    bubbleEl = document.createElement('div');
    bubbleEl.id = 'ruby_cw_bubble';
    bubbleEl.innerHTML = `
        <span class="cw-bubble-close">✕</span>
        <div class="cw-bubble-title">${stepId === 'Overview' ? '🏁' : '✍️'} ${stepId === 'Overview' ? '' : stepId + ' · '}${step.name}</div>
        <div class="cw-bubble-body">${guideToHtml(step.guide)}</div>`;
    document.body.appendChild(bubbleEl);

    const orbRect = orb.getBoundingClientRect();
    const bubbleRect = bubbleEl.getBoundingClientRect();
    let left = orbRect.right + 12;
    let top = orbRect.top - 8;
    if (left + bubbleRect.width > window.innerWidth - 10) {
        left = Math.max(10, orbRect.left - bubbleRect.width - 12);
    }
    if (top + bubbleRect.height > window.innerHeight - 10) {
        top = Math.max(10, window.innerHeight - bubbleRect.height - 10);
    }
    bubbleEl.style.left = `${left}px`;
    bubbleEl.style.top = `${top}px`;
    bubbleEl.style.display = 'block';

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
    applyPosition(orb, (Number.isFinite(ui.orbX) && Number.isFinite(ui.orbY)) ? { x: ui.orbX, y: ui.orbY } : defaultPosition());
    refreshVisibility();

    orb.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        dragState = {
            startX: e.clientX,
            startY: e.clientY,
            originX: parseFloat(orb.style.left),
            originY: parseFloat(orb.style.top),
            moved: false,
        };
        try { orb.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
    });

    orb.addEventListener('pointermove', (e) => {
        if (!dragState) return;
        const dx = e.clientX - dragState.startX;
        const dy = e.clientY - dragState.startY;
        if (!dragState.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        dragState.moved = true;
        applyPosition(orb, { x: dragState.originX + dx, y: dragState.originY + dy });
    });

    orb.addEventListener('pointerup', (e) => {
        if (!dragState) return;
        const moved = dragState.moved;
        const pos = { x: parseFloat(orb.style.left), y: parseFloat(orb.style.top) };
        dragState = null;
        try { orb.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        if (moved) {
            config.saveUi({ orbX: pos.x, orbY: pos.y });
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
        dragState = null;
    });

    window.addEventListener('resize', () => {
        const el = document.getElementById(ORB_ID);
        if (el) applyPosition(el, { x: parseFloat(el.style.left), y: parseFloat(el.style.top) });
        hideStepBubble();
    });

    // 面板保存 UI 配置时事件驱动刷新（替代轮询）：显隐 + 尺寸
    window.addEventListener('ruby:ui-changed', () => {
        const el = document.getElementById(ORB_ID);
        if (el) applySize(el);
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
        // 步骤切换时弹出说明气泡（可关闭，60秒自动收起）
        if (s.active && s.stepId && s.stepId !== lastBubbleStep) {
            lastBubbleStep = s.stepId;
            showStepBubble(s.stepId);
        }
    });
}
