import * as config from './config.js';
import { refreshVisibility } from './orb.js';
import { openPanel } from './panel.js';
import { ctx, warn, h } from './env.js';

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
                <div class="ra-ext-divider"></div>
                <div class="ra-cb-section">
                    <div class="ra-cb-head">
                        <b>📖 生成的角色分析聊天书</b>
                        <button id="ruby_ext_cb_refresh" class="ra-cb-refresh" title="刷新列表">🔄</button>
                    </div>
                    <div class="ra-ext-tip">游玩时角色分析器写入的聊天世界书自动登记在此，按角色卡分组（默认收起）。点击书名打开对应世界书；✕ 仅从列表移除（不删除世界书）。</div>
                    <div id="ruby_ext_cb_list" class="ra-cb-list"></div>
                </div>
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

    // 生成的角色分析聊天书：渲染 + 手动刷新 + 引擎登记后自动刷新
    renderGeneratedChatBooks();
    drawer.querySelector('#ruby_ext_cb_refresh')?.addEventListener('click', () => renderGeneratedChatBooks());
    window.addEventListener('ruby:chatbooks-changed', () => renderGeneratedChatBooks());
}

// ---------- 生成的角色分析聊天书：列表渲染与交互 ----------

// 记住用户展开的角色分组，跨重渲染保留（默认收起）
const expandedCbGroups = new Set();

/** 打开指定世界书：复刻 ST 官方「Chat Lore」选中逻辑（不改变激活状态） */
function openWorldBook(bookName) {
    if (!bookName) return;
    const jq = window.jQuery || window.$;
    try {
        if (jq) {
            if (!jq('#WorldInfo').is(':visible')) jq('#WIDrawerIcon').trigger('click');
            const names = ctx()?.getWorldInfoNames?.() || [];
            const index = names.indexOf(bookName);
            if (index >= 0) {
                jq('#world_editor_select').val(index).trigger('change');
                return;
            }
            // 回退：下拉项 value 是索引、text 才是书名，按 text 匹配
            const sel = jq('#world_editor_select');
            if (sel?.length) {
                const opt = sel.find('option').toArray().find((o) => o.textContent === bookName);
                if (opt) { sel.val(opt.value).trigger('change'); return; }
            }
        }
        window.toastr?.warning?.(`未在世界书列表中找到「${bookName}」（可能对应聊天未打开）`);
    } catch (e) {
        warn(`open world book failed: ${e?.message || e}`);
    }
}

/** 渲染登记簿：按角色卡分组，每组可折叠（默认收起），书名点击打开 */
function renderGeneratedChatBooks() {
    const list = document.getElementById('ruby_ext_cb_list');
    if (!list) return;

    const books = config.getGeneratedChatBooks();
    if (books.length === 0) {
        list.innerHTML = '<div class="ra-cb-empty">暂无已生成的分析聊天书（游玩时分析器写入后会自动登记）</div>';
        return;
    }

    // 按角色卡分组：avatar 为稳定键，name 用于展示
    const groups = new Map();
    for (const b of books) {
        const gKey = b.characterAvatar || b.characterName || '__unknown__';
        if (!groups.has(gKey)) {
            groups.set(gKey, { name: b.characterName || '未知角色', items: [] });
        }
        groups.get(gKey).items.push(b);
    }
    // 角色名排序；组内按更新时间倒序（最新在前）
    const sortedGroups = [...groups.entries()]
        .sort((a, b) => a[1].name.localeCompare(b[1].name, 'zh-Hans-CN'));

    list.innerHTML = sortedGroups.map(([gKey, g]) => {
        g.items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        const expanded = expandedCbGroups.has(gKey);
        const items = g.items.map((b, idx) => `
            <div class="ra-cb-item">
                <span class="ra-cb-idx">${idx + 1}.</span>
                <a class="ra-cb-link" data-book="${h(b.chatBookName)}" title="点击打开世界书">${h(b.chatBookName)}</a>
                <button class="ra-cb-remove" data-key="${h(b.key)}" title="从列表移除（不删除世界书）">✕</button>
            </div>`).join('');
        return `
        <div class="ra-cb-group ${expanded ? '' : 'collapsed'}" data-group="${h(gKey)}">
            <div class="ra-cb-group-header">
                <span class="ra-cb-arrow">${expanded ? '▼' : '▶'}</span>
                <span class="ra-cb-group-name">${h(g.name)}</span>
                <span class="ra-cb-group-count">${g.items.length}</span>
            </div>
            <div class="ra-cb-group-body">${items}</div>
        </div>`;
    }).join('');

    // 折叠/展开（保留状态）
    list.querySelectorAll('.ra-cb-group-header').forEach((head) => {
        head.addEventListener('click', () => {
            const group = head.closest('.ra-cb-group');
            if (!group) return;
            const gKey = group.dataset.group;
            const collapsed = group.classList.toggle('collapsed');
            head.querySelector('.ra-cb-arrow').textContent = collapsed ? '▶' : '▼';
            if (collapsed) expandedCbGroups.delete(gKey);
            else expandedCbGroups.add(gKey);
        });
    });
    // 打开世界书
    list.querySelectorAll('.ra-cb-link').forEach((link) => {
        link.addEventListener('click', () => openWorldBook(link.dataset.book));
    });
    // 从列表移除
    list.querySelectorAll('.ra-cb-remove').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const key = btn.dataset.key;
            if (!key) return;
            if (!window.confirm('从列表移除这条登记？（不会删除世界书本身）')) return;
            config.unregisterGeneratedChatBook(key);
            renderGeneratedChatBooks();
        });
    });
}
