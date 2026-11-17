import * as config from './config.js';
import * as engine from './engine.js';
import * as cardwriter from './cardwriter.js';
import { openPanel } from './panel.js';
import { badgeState } from './orb.js';

/**
 * 入口样式二选一（玩家面板可切）：
 * - 'orb'   悬浮球（默认，球负责入口与状态）
 * - 'qrbar' QR 栏——RUBY 以单个主按钮嵌入输入框上方的 QR 栏区域：
 *   状态点 + RUBY 字样，点击开面板（写卡会话激活时直达写卡页签）。
 *   任务快捷执行不在栏里，统一收进面板的「手动执行分析」区。
 * 本模块只在 qrbar 模式下可见；悬浮球的显隐由 orb.js 按 entryMode 联动。
 */

const BAR_ID = 'ruby_qr_bar';

let barEl = null;
let placementObserver = null;

function entryMode() {
    const mode = String(config.getUi()?.entryMode || 'orb').toLowerCase();
    return mode === 'qrbar' ? 'qrbar' : 'orb';
}

function sendForm() {
    return document.querySelector('#send_form');
}

/** 把按钮插到 QR 栏之后（存在时），否则插到输入区最上方 */
function placeBar() {
    if (!barEl) return;
    const form = sendForm();
    if (!form) return;
    const qr = document.querySelector('#qr--bar');
    if (qr && qr.parentElement === form && qr.nextElementSibling !== barEl) {
        qr.insertAdjacentElement('afterend', barEl);
    } else if (!qr && barEl.parentElement !== form) {
        form.insertBefore(barEl, form.firstChild);
    }
}

function refreshState() {
    if (!barEl) return;
    const dot = barEl.querySelector('.ruby-qr-dot');
    if (dot) dot.dataset.state = badgeState(engine.getEngineState());
    const cw = cardwriter.getState();
    const main = barEl.querySelector('.ruby-qr-main');
    if (main) {
        main.title = cw.active
            ? `RUBY写卡会话 · 当前步骤 ${cw.stepId || '—'}（点击打开写卡面板）`
            : '打开 RUBY 面板';
    }
}

function refreshVisibility() {
    if (!barEl) return;
    barEl.classList.toggle('hidden', entryMode() !== 'qrbar');
}

export function refreshQrBar() {
    refreshVisibility();
    placeBar();
    refreshState();
}

export function ensureQrBar() {
    if (barEl) {
        refreshQrBar();
        return;
    }
    const form = sendForm();
    if (!form) {
        // 输入区尚未挂载：等 DOM 稳定后再试（酒馆前端逐步渲染）
        setTimeout(ensureQrBar, 1000);
        return;
    }

    barEl = document.createElement('div');
    barEl.id = BAR_ID;
    barEl.innerHTML = `
        <button class="ruby-qr-main" type="button"><span class="ruby-qr-dot" data-state="idle"></span>RUBY</button>
    `;
    placeBar();

    barEl.querySelector('.ruby-qr-main')?.addEventListener('click', () => {
        // 写卡会话激活时直达写卡页签（与悬浮球点击一致）
        openPanel(cardwriter.getState().active ? 'cardwriter' : undefined);
    });

    // QR 栏刷新/酒馆重排 send_form 子节点时，重新对位（事件驱动，不轮询）
    placementObserver = new MutationObserver(() => placeBar());
    placementObserver.observe(form, { childList: true });

    window.addEventListener('ruby:ui-changed', refreshQrBar);
    engine.onStateChange(refreshState);
    cardwriter.onStateChange(refreshState);

    refreshQrBar();
}
