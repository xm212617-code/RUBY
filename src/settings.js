import * as config from './config.js';
import { refreshVisibility } from './orb.js';
import { openPanel } from './panel.js';

const DRAWER_ID = 'ruby_analyzer_ext_settings';

// ---------- 黑夜模式主题 ----------
// 主题基调：给 body / html 挂 .ruby-dark 类，全部覆盖样式集中在 style.css。

/** 当前是否黑夜模式：ui.darkMode 显式为 true/false 时以用户选择为准，否则跟随系统外观 */
export function isDarkMode() {
    const ui = config.getUi();
    if (ui && (ui.darkMode === true || ui.darkMode === false)) return ui.darkMode;
    try {
        return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch {
        return false;
    }
}

/** 应用主题：切换 body.ruby-dark 类（全部组件样式由此驱动） */
export function applyTheme() {
    const dark = isDarkMode();
    document.body.classList.toggle('ruby-dark', dark);
    document.documentElement.classList.toggle('ruby-dark', dark);
}

/** 启动主题：立即应用 + 监听 UI 配置变化；未手动设置时跟随系统外观实时切换 */
export function initTheme() {
    applyTheme();
    window.addEventListener('ruby:ui-changed', applyTheme);
    try {
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const onSystemChange = () => {
            const ui = config.getUi();
            if (ui && (ui.darkMode === true || ui.darkMode === false)) return;
            applyTheme();
        };
        if (typeof media.addEventListener === 'function') media.addEventListener('change', onSystemChange);
        else if (typeof media.addListener === 'function') media.addListener(onSystemChange);
    } catch { /* 旧浏览器忽略 */ }
}

/**
 * 酒馆扩展设置栏（_EXTENSIONS 面板）中的 RUBY 抽屉：
 * 悬浮球显示开关 + 大小拉条 + 面板入口。ST 全局委托处理 .inline-drawer-toggle 折叠。
 */
export function initSettingsDrawer() {
    if (document.getElementById(DRAWER_ID)) return;
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;

    const drawer = document.createElement('div');
    drawer.className = 'extension_container';
    drawer.id = DRAWER_ID;
    drawer.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>RUBY 分析器</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input id="ruby_ext_orb_toggle" type="checkbox">
                    <span>显示悬浮球</span>
                </label>
                <div class="ra-ext-row">
                    <span>悬浮球大小 <span id="ruby_ext_orb_size_val">60</span>px</span>
                    <input id="ruby_ext_orb_size" type="range" min="32" max="60" step="2" style="flex:1;max-width:170px;">
                </div>
                <div class="ra-ext-tip">拉条向左缩小悬浮球（当前 60px 为最大）；关闭悬浮球后仍可用 <code>/ruby</code> 命令打开面板</div>
                <label class="checkbox_label">
                    <input id="ruby_ext_dark_toggle" type="checkbox">
                    <span>黑夜模式</span>
                </label>
                <div class="ra-ext-tip">默认跟随系统外观，手动切换后记住你的选择；面板右上角也有 🌙/☀️ 切换按钮</div>
            </div>
        </div>`;

    host.appendChild(drawer);

    const toggle = drawer.querySelector('#ruby_ext_orb_toggle');
    toggle.checked = !config.getUi().orbHidden;
    toggle.addEventListener('change', () => {
        config.saveUi({ orbHidden: !toggle.checked });
        refreshVisibility();
        window.dispatchEvent(new CustomEvent('ruby:ui-changed'));
    });

    // 大小拉条：即时预览，change 落盘
    const sizeInput = drawer.querySelector('#ruby_ext_orb_size');
    const sizeVal = drawer.querySelector('#ruby_ext_orb_size_val');
    const applySizeFromInput = () => {
        const size = config.clampOrbSize(sizeInput.value);
        sizeInput.value = size;
        sizeVal.textContent = size;
        config.saveUi({ orbSize: size });
        window.dispatchEvent(new CustomEvent('ruby:ui-changed'));
    };
    sizeInput.value = config.clampOrbSize(config.getUi().orbSize);
    sizeVal.textContent = sizeInput.value;
    sizeInput.addEventListener('input', applySizeFromInput);

    // 黑夜模式开关：勾选=强制黑夜，取消=强制白天（写入 ui.darkMode，不再跟随系统）
    const darkToggle = drawer.querySelector('#ruby_ext_dark_toggle');
    if (darkToggle) {
        darkToggle.checked = isDarkMode();
        darkToggle.addEventListener('change', () => {
            config.saveUi({ darkMode: !!darkToggle.checked });
            window.dispatchEvent(new CustomEvent('ruby:ui-changed'));
        });
    }

    // 面板保存 UI 配置后同步开关与拉条状态
    window.addEventListener('ruby:ui-changed', () => {
        const el = document.getElementById('ruby_ext_orb_toggle');
        if (el) el.checked = !config.getUi().orbHidden;
        const sz = document.getElementById('ruby_ext_orb_size');
        const szVal = document.getElementById('ruby_ext_orb_size_val');
        const size = config.clampOrbSize(config.getUi().orbSize);
        if (sz && String(sz.value) !== String(size)) {
            sz.value = size;
            if (szVal) szVal.textContent = size;
        }
    });

    // 双击标题打开面板
    drawer.querySelector('.inline-drawer-header').addEventListener('dblclick', () => {
        openPanel();
    });
}
