import * as config from './config.js';
import * as engine from './engine.js';
import { openPanel } from './panel.js';

const ORB_ID = 'ruby_analyzer_orb';
const DRAG_THRESHOLD = 6;

let dragState = null;

function defaultPosition() {
    return {
        x: Math.max(12, window.innerWidth - 84),
        y: Math.min(window.innerHeight - 180, Math.max(120, window.innerHeight * 0.55)),
    };
}

function applyPosition(orb, pos) {
    orb.style.left = `${Math.max(4, Math.min(window.innerWidth - 60, pos.x))}px`;
    orb.style.top = `${Math.max(4, Math.min(window.innerHeight - 60, pos.y))}px`;
}

function setStatus(orb, engineState) {
    const dot = orb.querySelector('.ruby-orb-dot');
    if (!dot) return;
    dot.classList.remove('idle', 'armed', 'working', 'error');
    if (engineState.running) {
        dot.classList.add('working');
        orb.title = `RUBY 分析中… ${engineState.charName}`;
    } else if (engineState.lastError) {
        dot.classList.add('error');
        orb.title = `RUBY 错误：${engineState.lastError}`;
    } else if (engineState.armed) {
        dot.classList.add('armed');
        const pos = engineState.cycleLength > 0 ? `${engineState.position}/${engineState.cycleLength}` : '-';
        orb.title = `RUBY 运行中 · ${engineState.charName} · AI回复 ${engineState.aiCount} · 周期位置 ${pos}（点击打开面板）`;
    } else {
        dot.classList.add('idle');
        orb.title = 'RUBY 待机（无角色或未配置任务）— 点击打开面板';
    }
}

export function ensureOrb() {
    if (document.getElementById(ORB_ID)) return;

    const orb = document.createElement('div');
    orb.id = ORB_ID;
    orb.innerHTML = `
        <span class="ruby-orb-dot idle"></span>
        <span class="ruby-orb-glyph">R</span>
    `;
    document.body.appendChild(orb);

    const ui = config.getUi();
    applyPosition(orb, (Number.isFinite(ui.orbX) && Number.isFinite(ui.orbY)) ? { x: ui.orbX, y: ui.orbY } : defaultPosition());

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
            openPanel();
        }
    });

    orb.addEventListener('pointercancel', () => {
        dragState = null;
    });

    window.addEventListener('resize', () => {
        const el = document.getElementById(ORB_ID);
        if (el) applyPosition(el, { x: parseFloat(el.style.left), y: parseFloat(el.style.top) });
    });

    setStatus(orb, engine.getEngineState());
    engine.onStateChange((engineState) => {
        const el = document.getElementById(ORB_ID);
        if (el) setStatus(el, engineState);
    });

    setInterval(() => {
        const el = document.getElementById(ORB_ID);
        if (!el) return;
        el.classList.toggle('hidden', !!config.getUi().orbHidden);
    }, 2000);
}
