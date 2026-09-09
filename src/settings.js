import * as config from './config.js';
import { refreshVisibility } from './orb.js';
import { openPanel } from './panel.js';

const DRAWER_ID = 'ruby_analyzer_ext_settings';

/**
 * 酒馆扩展设置栏（_EXTENSIONS 面板）中的 RUBY 抽屉：
 * 提供悬浮球显示开关与面板入口。ST 全局委托处理 .inline-drawer-toggle 折叠。
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
                <div class="ra-ext-tip">关闭后仍可用 <code>/ruby</code> 命令打开面板</div>
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

    // 面板保存 UI 配置后同步开关状态
    window.addEventListener('ruby:ui-changed', () => {
        const el = document.getElementById('ruby_ext_orb_toggle');
        if (el) el.checked = !config.getUi().orbHidden;
    });

    // 双击标题打开面板
    drawer.querySelector('.inline-drawer-header').addEventListener('dblclick', () => {
        openPanel();
    });
}
