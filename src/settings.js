import * as config from './config.js';
import { refreshVisibility } from './orb.js';
import { openPanel } from './panel.js';

const DRAWER_ID = 'ruby_analyzer_ext_settings';

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
