import * as config from './config.js';
import * as engine from './engine.js';
import * as cardwriter from './cardwriter.js';
import * as scheduler from './scheduler.js';
import { openPanel } from './panel.js';
import { badgeState } from './orb.js';

/**
 * 入口样式二选一（玩家面板可切）：
 * - 'orb'   悬浮球（默认，球负责入口与状态）
 * - 'qrbar' QR 栏——RUBY 以一行快捷按钮嵌入输入框上方的 QR 栏区域，
 *   主按钮开面板，随行携带任务快捷执行按钮（与玩家面板"手动执行分析"同源）
 * 本模块只在 qrbar 模式下可见；悬浮球的显隐由 orb.js 按 entryMode 联动。
 */

const BAR_ID = 'ruby_qr_bar';
const REFRESH_EVENT = 'ruby:qrbar-refresh';

let barEl = null;
let placementObserver = null;

function entryMode() {
    const mode = String(config.getUi()?.entryMode || 'orb').toLowerCase();
    return mode === 'qrbar' ? 'qrbar' : 'orb';
}

function sendForm() {
    return document.querySelector('#send_form');
}

/** 把按钮行插到 QR 栏之后（存在时），否则插到输入区最上方 */
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

function h(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 任务快捷按钮与玩家面板"手动执行分析"完全同源（同一套启用/绑定过滤） */
function renderTaskButtons() {
    const buttons = [];
    let preset = null;
    let identity = null;
    try {
        const { data } = config.resolveConfig();
        preset = config.getActivePreset(data);
        identity = config.getCharacterIdentity();
    } catch { /* 配置未就绪则只显示主按钮 */ return buttons; }
    if (!preset || !identity) return buttons;

    if (preset.startupTask?.enabled && scheduler.taskMatchesCharacter(preset.startupTask, identity)) {
        buttons.push(`<button class="ruby-qr-btn is-startup" data-run="startup" title="手动执行：${h(preset.startupTask.displayName || '开局分析')}">${h(preset.startupTask.displayName || '开局分析')}</button>`);
    }
    for (const task of preset.tasks || []) {
        if (task.enabled && scheduler.taskMatchesCharacter(task, identity)) {
            buttons.push(`<button class="ruby-qr-btn is-task" data-run="task" data-id="${task.id}" title="手动执行：${h(task.displayName || `任务#${task.id}`)}">${h(task.displayName || `任务#${task.id}`)}</button>`);
        }
    }
    if (buttons.length > 1) {
        buttons.push('<button class="ruby-qr-btn is-all" data-run="all" title="按顺序手动执行全部启用的任务">▶ 全部执行</button>');
    }
    const dirEnabled = !!preset.director?.enabled;
    buttons.push(`<button class="ruby-qr-btn is-director" data-run="director" ${dirEnabled ? '' : 'disabled title="导演模式未启用——到创作者版面的导演面板开启后可用"'} title="${dirEnabled ? '让导演按当前正文重新排期并执行' : '导演模式未启用'}">🎬 导演</button>`);
    return buttons;
}

function rebuild() {
    if (!barEl) return;
    const state = badgeState(engine.getEngineState());
    const dot = barEl.querySelector('.ruby-qr-dot');
    if (dot) dot.dataset.state = state;
    const cw = cardwriter.getState();
    const main = barEl.querySelector('.ruby-qr-main');
    if (main) {
        main.title = cw.active
            ? 'RUBY写卡会话进行中——点击打开写卡面板'
            : '打开 RUBY 面板';
    }
    const wrap = barEl.querySelector('.ruby-qr-tasks');
    if (wrap) {
        wrap.innerHTML = renderTaskButtons().join('');
        wrap.querySelectorAll('[data-run]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const kind = btn.dataset.run;
                const id = parseInt(btn.dataset.id, 10);
                try {
                    await engine.forceRun(kind, id, { pureManual: !!config.getUi().pureManualRun });
                } catch (e) {
                    window.toastr?.error?.(e.message || '执行失败', '', { timeOut: 6000 });
                }
            });
        });
    }
}

function refreshVisibility() {
    if (!barEl) return;
    barEl.classList.toggle('hidden', entryMode() !== 'qrbar');
}

export function refreshQrBar() {
    refreshVisibility();
    placeBar();
    rebuild();
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
        <span class="ruby-qr-sep"></span>
        <span class="ruby-qr-tasks"></span>
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
    window.addEventListener(REFRESH_EVENT, refreshQrBar);
    window.addEventListener('ruby:config-changed', () => rebuild());
    engine.onStateChange(() => {
        const dot = barEl?.querySelector('.ruby-qr-dot');
        if (dot) dot.dataset.state = badgeState(engine.getEngineState());
    });
    cardwriter.onStateChange(() => {
        const dot = barEl?.querySelector('.ruby-qr-dot');
        if (dot) dot.dataset.state = badgeState(engine.getEngineState());
        rebuild();
    });

    refreshQrBar();
}
