import { ctx, log, h } from './env.js';
import * as config from './config.js';
import * as scheduler from './scheduler.js';
import * as jailbreak from './jailbreak.js';
import * as engine from './engine.js';
import * as ai from './ai.js';
import * as worldbook from './worldbook.js';
import { countAiReplies } from './reader.js';

const PANEL_ID = 'ra_panel';
const UI_STATE_KEY = 'ruby_analyzer_ui_state';

const $ = (id) => document.getElementById(id);
const on = (el, ev, cb) => el && el.addEventListener(ev, cb);

const ui = {
    mode: 'player',
    playerSub: 'main',
    creatorSub: 'refs',
    editingPresetId: null,
    refs: [],
    tasks: [],
    nextTaskId: 1,
    tags: [],
    jailbreakItems: [],
    scannedKeys: [],
    scanMode: false,
    refAddedCollapsed: true,
    expandedTasks: new Set(),
    collapsedJb: new Set(),
    importedTemplateName: '',
};

let panelBuilt = false;
let interactionsBound = false;

const hashString = (input) => {
    let hash = 2166136261;
    const str = String(input || '');
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(36);
};

const buildAutoVarName = (entryKey, usedSet = new Set()) => {
    const key = String(entryKey || '').trim();
    let base = key.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!base) base = 'item';
    const hash = hashString(key).slice(0, 6);
    let candidate = `ref_${base}_${hash}`;
    let idx = 2;
    while (usedSet.has(candidate)) {
        candidate = `ref_${base}_${hash}_${idx++}`;
    }
    usedSet.add(candidate);
    return candidate;
};

const normalizeKeyword = (s) => String(s || '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');

const isKeywordSimilar = (a, b) => {
    const na = normalizeKeyword(a);
    const nb = normalizeKeyword(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.length >= 2 && nb.length >= 2) {
        return na.includes(nb) || nb.includes(na);
    }
    return false;
};

function saveUIState() {
    const state = {
        mode: ui.mode,
        playerSub: ui.playerSub,
        creatorSub: ui.creatorSub,
    };
    try { localStorage.setItem(UI_STATE_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
}

function loadUIState() {
    try {
        const saved = localStorage.getItem(UI_STATE_KEY);
        return saved ? JSON.parse(saved) : null;
    } catch { return null; }
}

function withConfigData(mutator) {
    const { data } = config.resolveConfig();
    mutator(data);
    config.saveConfigData(data);
    config.flushCardPersistNow().catch(() => { /* flush 内部已上报错误 */ });
}

function getEditingPreset(data) {
    const cfgData = data || config.resolveConfig().data;
    const preset = cfgData.presets.find((p) => p.id === ui.editingPresetId);
    return preset || config.getActivePreset(cfgData);
}

function activePositionsOf(task) {
    const raw = Array.isArray(task.cyclePositions) && task.cyclePositions.length > 0
        ? task.cyclePositions
        : (task.cyclePosition || task.triggerFloor ? [task.cyclePosition || task.triggerFloor] : []);
    return raw.filter((n) => n > 0);
}

export function openPanel() {
    buildPanel();
    const root = $(PANEL_ID);
    if (!root) return;
    refreshAll();
    root.style.display = 'flex';
}

function closePanel() {
    const root = $(PANEL_ID);
    if (root) root.style.display = 'none';
}

function refreshAll() {
    const { data, layer, source } = config.resolveConfig();
    if (!ui.editingPresetId || !data.presets.some((p) => p.id === ui.editingPresetId)) {
        ui.editingPresetId = data.activePresetId || data.presets[0]?.id;
    }
    renderStatus(layer, source);
    renderPresetDisplay(data, layer);
    renderManualButtons(data, layer);
    renderSchedule(data, layer);
    checkEntryStatus(data);
    renderPresetList(data);
    loadApiTab(data);
    ui.jailbreakItems = jailbreak.getJailbreakItems(data);
    renderJailbreakItems();
    ui.tags = [...(data.customContentTags || [])];
    renderTagsList();
    renderSchemeTabs();
    loadSchemeToUI(ui.editingPresetId);
    ui.refs = getEditingPreset(data).referencePool ? [...getEditingPreset(data).referencePool] : [];
    renderRefPool();
    renderBindingTab(layer);
    renderPresetSummary();
}

function buildPanel() {
    if (panelBuilt && $(PANEL_ID)) return;
    if ($(PANEL_ID)) $(PANEL_ID).remove();

    const root = document.createElement('div');
    root.id = PANEL_ID;
    root.innerHTML = buildShellHtml();
    document.body.appendChild(root);
    panelBuilt = true;

    wireTabs(root);
    wireGlobalInteractions();
    wirePlayerSections();
    wireJailbreakControls();
    wireTagControls();
    wireRefPoolControls();
    wireTaskControls();
    wireBindingControls();
    wirePresetIoControls();

    on($('ra_close'), 'click', closePanel);
    root.querySelector('.ra-mask')?.addEventListener('click', closePanel);
}

function buildShellHtml() {
    return `
    <div class="ra-mask"></div>
    <div class="card">
        <div class="title-bar">
            <div>
                <h1>◆ RUBY 角色分析系统 ◆</h1>
                <div class="subtitle">Ruby Universal Bot Yield - 独立分析扩展</div>
            </div>
            <button id="ra_close" class="close-btn">✕ 关闭</button>
        </div>

        <div class="mode-tabs">
            <div class="mode-tab player active" data-mode="player">🎮 玩家版面</div>
            <div class="mode-tab creator" data-mode="creator">🛠️ 创作者版面</div>
        </div>

        <div class="body">
            <div class="panel-content active" data-panel="player">
                <div class="sub-tabs">
                    <div class="sub-tab active" data-sub="main">📊 主面板</div>
                    <div class="sub-tab" data-sub="presets">🎯 配置方案</div>
                    <div class="sub-tab" data-sub="api">⚙️ API设置</div>
                    <div class="sub-tab" data-sub="jailbreak">🧩 自定义破限</div>
                    <div class="sub-tab" data-sub="tags">🏷️ 正文标签</div>
                </div>

                <div class="sub-content active" data-subcontent="main" style="padding:16px;">
                    <div class="form-section">
                        <div class="form-header red">■ 系统状态</div>
                        <div class="form-body"><div id="ra_status" class="status-box">检查中...</div></div>
                    </div>
                    <div class="form-section">
                        <div class="form-header red">■ 当前配置方案</div>
                        <div class="form-body">
                            <div id="ra_current_preset" class="status-box" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;"></div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header red">■ 手动执行分析</div>
                        <div class="form-body">
                            <div id="ra_manual_buttons" style="display:flex;flex-wrap:wrap;gap:10px;"><span>加载中...</span></div>
                            <div class="tip">点击按钮可强制执行对应的分析任务，不受楼层限制；手动执行不会打断后台自动周期。</div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header red">■ 任务触发时间表</div>
                        <div class="form-body">
                            <div id="ra_schedule" class="status-box">暂无任务</div>
                            <div class="tip">⚠️ 楼层仅计算AI回复消息，用户消息不计入</div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header red">■ 条目状态检查</div>
                        <div class="form-body"><div id="ra_entries" class="status-box">检查中...</div></div>
                    </div>
                </div>

                <div class="sub-content" data-subcontent="presets" style="padding:16px;display:none;">
                    <div class="form-section">
                        <div class="form-header red">■ 可用配置方案</div>
                        <div class="form-body">
                            <div class="tip" style="margin-top:0;margin-bottom:16px;">
                                🎯 <strong>配置方案</strong>：创作者可以预设多套不同的任务配置，您可以根据需要切换。<br>
                                切换方案后，分析任务会按新方案的设定执行。
                            </div>
                            <div id="ra_preset_list" style="display:flex;flex-direction:column;gap:12px;"></div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header red">■ 当前方案详情</div>
                        <div class="form-body"><div id="ra_preset_detail" class="status-box"></div></div>
                    </div>
                </div>

                <div class="sub-content" data-subcontent="api" style="padding:16px;display:none;">
                    <div class="form-section">
                        <div class="form-header red">■ API 渠道</div>
                        <div class="form-body">
                            <div class="form-row">
                                <span class="form-label">渠道选择</span>
                                <select id="ra_api_provider" class="w200">
                                    <option value="main">酒馆主API（沿用当前连接）</option>
                                    <option value="custom">自定义 OpenAI 兼容端点</option>
                                </select>
                            </div>
                            <div class="form-row" id="ra_api_url_wrap">
                                <span class="form-label">API地址</span>
                                <input id="ra_api_url" class="w320" placeholder="https://api.openai.com/v1 或 https://api.deepseek.com/beta">
                            </div>
                            <div class="form-row" id="ra_api_key_wrap">
                                <span class="form-label">API密钥</span>
                                <input id="ra_api_key" class="w320" type="password" placeholder="仅保存在本地，绝不随角色卡导出">
                            </div>
                            <div class="form-row" id="ra_api_model_wrap">
                                <span class="form-label">模型名称</span>
                                <span class="form-value" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                                    <select id="ra_api_model_select" class="w250 hidden"></select>
                                    <input id="ra_api_model_text" class="w250" placeholder="如 deepseek-chat / gpt-4o-mini">
                                    <button id="ra_api_connect" class="btn outline small">连接/拉取模型</button>
                                </span>
                            </div>
                            <div class="form-row">
                                <span class="form-label">选项</span>
                                <span class="form-value" style="display:flex;gap:16px;flex-wrap:wrap;">
                                    <label class="inline" id="ra_api_stream_label" title="此开关仅控制自定义端点的请求方式；主API的流式与否由酒馆自身机制按当前后端决定，RUBY 不干预"><input type="checkbox" id="ra_api_stream" checked> 流式传输</label>
                                    <label class="inline"><input type="checkbox" id="ra_notify" checked> 分析进度提示</label>
                                    <label class="inline"><input type="checkbox" id="ra_orb_show" checked> 显示悬浮球</label>
                                </span>
                            </div>
                            <div class="tip" style="margin-top:8px;">
                                💡 <strong>主API</strong>：通过酒馆原生 <code>generateRaw</code> 走当前连接的模型，仅借用通道——<u>不注入预设的提示词</u>（主提示词/越狱/角色卡/聊天记录一概不进上下文），发送的只有 RUBY 自己组装的破限消息与任务提示词，与酒馆自身静默提示词同一机制；RUBY 生成参数会按官方事件钩子覆写到本次请求。<br>
                                💡 <strong>自定义端点</strong>：OpenAI 兼容接口（DeepSeek、OpenRouter、GLM 等），通过酒馆官方 <code>ChatCompletionService</code> 请求服务发出。地址填到版本段即可（如 <code>/v1</code>、<code>/beta</code>），由酒馆服务端拼接 <code>/chat/completions</code> 并转发。<br>
                                🔒 两条通道均为酒馆原生请求形态、异步后台执行；密钥只保存在本机扩展设置中，不进入角色卡、世界书或配置模板。
                            </div>
                        </div>
                    </div>

                    <div class="form-section">
                        <div class="form-header red">■ 生成参数</div>
                        <div class="form-body">
                            <div class="tip" style="margin-top:0;margin-bottom:10px;">
                                💡 <strong>默认不发送任何生成参数</strong>：主API沿用酒馆当前预设的采样设置，自定义端点沿用服务商默认值。<br>
                                有自定义需求时勾选下方开关；<u>留空的参数依然不会发送</u>。
                            </div>
                            <div class="form-row">
                                <span class="form-label">参数开关</span>
                                <label class="inline"><input type="checkbox" id="ra_gen_enable"> 启用自定义生成参数</label>
                            </div>
                            <div class="form-row"><span class="form-label">Temperature</span><input id="ra_gen_temp" class="w100" type="number" step="0.01" min="0" max="2" placeholder="不发送"></div>
                            <div class="form-row"><span class="form-label">Top P</span><input id="ra_gen_top_p" class="w100" type="number" step="0.01" min="0.01" max="1" placeholder="不发送"></div>
                            <div class="form-row"><span class="form-label">Top K</span><input id="ra_gen_top_k" class="w100" type="number" step="1" min="1" placeholder="不发送"></div>
                            <div class="form-row"><span class="form-label">存在惩罚</span><input id="ra_gen_pp" class="w100" type="number" step="0.01" min="-2" max="2" placeholder="不发送"></div>
                            <div class="form-row"><span class="form-label">频率惩罚</span><input id="ra_gen_fp" class="w100" type="number" step="0.01" min="-2" max="2" placeholder="不发送"></div>
                            <div class="form-row">
                                <span class="form-label">推理力度</span>
                                <select id="ra_gen_effort" class="w150">
                                    <option value="">不发送</option>
                                    <option value="low">low</option>
                                    <option value="medium">medium</option>
                                    <option value="high">high</option>
                                </select>
                            </div>
                            <div class="btn-row" style="border-top:none;padding-top:0;">
                                <button id="ra_gen_reset" class="btn outline small">清空参数（恢复默认）</button>
                            </div>
                        </div>
                    </div>

                    <div class="tip">💡 生成参数随当前配置层（角色卡内嵌/全局暂存）保存；API凭据只保存在本地。</div>
                    <div class="btn-row"><button id="ra_api_save" class="btn red">💾 保存API设置</button></div>
                </div>

                <div class="sub-content" data-subcontent="jailbreak" style="padding:16px;display:none;">
                    <div class="form-section">
                        <div class="form-header red">■ 自定义破限消息</div>
                        <div class="form-body">
                            <div class="tip" style="margin-top:0;margin-bottom:12px;">
                                💡 任务提示词会固定作为 <code>user</code> 消息发送。这里可以调整它前后的破限消息、消息角色和注入位置；<code>{{taskType}}</code> 会自动替换为当前任务名。
                            </div>
                            <div id="ra_jailbreak_items"></div>
                            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">
                                <button id="ra_jb_add" class="btn green small">➕ 添加文本</button>
                                <button id="ra_jb_reset" class="btn outline small">恢复默认</button>
                            </div>
                        </div>
                    </div>
                    <div class="btn-row"><button id="ra_jb_save" class="btn red">💾 保存破限设置</button></div>
                </div>

                <div class="sub-content" data-subcontent="tags" style="padding:16px;display:none;">
                    <div class="form-section">
                        <div class="form-header red">■ 自定义正文提取标签</div>
                        <div class="form-body">
                            <div class="form-row" style="border-bottom:none;">
                                <span class="form-label">添加标签</span>
                                <span class="form-value" style="display:flex;gap:8px;">
                                    <input id="ra_new_tag_input" class="w200" placeholder="输入标签名（如 story、novel）">
                                    <button id="ra_add_tag_btn" class="btn green small">➕ 添加</button>
                                </span>
                            </div>
                            <div id="ra_tags_list" style="display:flex;flex-wrap:wrap;gap:8px;min-height:40px;padding:10px;background:#f8f8f5;border:1px solid #999;border-radius:3px;margin-top:10px;"></div>
                            <div class="tip">💡 自定义标签会优先于默认标签（content、maintext 等）被匹配。添加后需点击"保存标签"生效。</div>
                        </div>
                    </div>
                    <div class="btn-row"><button id="ra_tags_save" class="btn red">💾 保存标签设置</button></div>
                </div>
            </div>

            <div class="panel-content" data-panel="creator">
                <div class="sub-tabs">
                    <div class="sub-tab active" data-sub="refs">📚 参考条目池</div>
                    <div class="sub-tab" data-sub="tasks">📋 任务配置</div>
                    <div class="sub-tab" data-sub="binding">🔗 角色绑定</div>
                    <div class="sub-tab" data-sub="preset">📦 导入导出</div>
                    <div class="sub-tab" data-sub="help">❓ 帮助</div>
                </div>

                <div class="sub-content active" data-subcontent="refs" style="padding:16px;">
                    <div class="form-section">
                        <div class="form-header blue">■ 参考条目池</div>
                        <div class="form-body">
                            <div class="tip" style="margin-top:0;margin-bottom:12px;">
                                点击"扫描角色世界书"后会列出所有可用关键词，分两组：<strong>已加入参考</strong>（可折叠）和<strong>未加入</strong>。勾选需要的条目并保存后，参考池仅保留勾选项，变量名将自动生成。<br><br>
                                <strong>📖 读取优先级：</strong>优先从<u>聊天世界书</u>读取最新版本，没有时回退到<u>角色世界书</u>读取原始版本。
                            </div>
                            <div id="ra_ref_pool_list"></div>
                            <div style="display:flex;gap:8px;align-items:center;margin-top:12px;padding-top:12px;border-top:1px dashed #999;">
                                <button id="ra_scan_refs_btn" class="btn green">🔍 扫描角色世界书</button>
                                <button id="ra_refs_save" class="btn blue">💾 保存参考池配置</button>
                            </div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header blue">■ 系统内置变量</div>
                        <div class="form-body">
                            <div class="status-box">
                                <div><code>{{recentMessages}}</code> → 每个任务独立记录已读楼层，下次只读未读的新楼层（含被隐藏的正文），每次最多20楼；单次正文上限<strong>20万字符</strong>，超出部分末尾截断抛弃</div>
                                <div><code>{{CHAR_NAME}}</code> → 上方配置的角色名称</div>
                                <div style="margin-top:8px;color:#333;">任务输出变量：{{task_任务ID_Output}}（如 {{task_1_Output}}）</div>
                            </div>
                            <div class="tip" style="margin-top:8px;">
                                💡 <strong>增量阅读机制</strong>：每个分析任务各自维护"已读书签"（存于聊天元数据）。<br>
                                每次触发时只读上次之后<u>新楼层</u>（含被酒馆隐藏的正文），读过的不重读，每次最多阅读最近20楼。<br>
                                ⚠️ 单次输入正文超过<strong>20万字符</strong>时停止，后续剩余正文直接抛弃（保留靠前部分）；上限只作用于对话正文——参考条目与历史分析输出完整保留，绝不因截断丢失。<br>
                                退出再进会从书签续读；新聊天时读最近20楼。各任务书签互不影响。
                            </div>
                        </div>
                    </div>
                </div>

                <div class="sub-content" data-subcontent="tasks" style="padding:0;display:none;">
                    <div id="ra_scheme_tabs" class="scheme-tabs"></div>
                    <div id="ra_scheme_area" class="tasks-flex" style="padding:16px;">
                        <div class="scheme-header">
                            <span style="font-size:14px;">📋</span>
                            <input id="ra_scheme_name_input" placeholder="方案名称" value="默认方案">
                            <div class="scheme-actions">
                                <button id="ra_scheme_activate_btn" title="设为玩家当前使用">🎯 激活</button>
                                <button id="ra_scheme_delete_btn" class="danger" title="删除此方案">🗑️ 删除</button>
                            </div>
                        </div>
                        <div class="cycle-sticky">
                            <div class="cycle-title-row">
                                <span class="cycle-icon">🔄</span>
                                <span class="cycle-title">周期分析时间线</span>
                                <span class="help-tip" data-tip="一条线表示一个周期。&#10;竖线=会触发分析的任务，&#10;位置=在周期的第几条AI回复触发。&#10;箭头指到头就回到位置1重新来">?</span>
                            </div>
                            <div id="ra_cycle_timeline" class="cycle-timeline"><div class="cycle-track"></div></div>
                            <div class="cycle-status-row">
                                <span id="ra_cycle_length_badge" class="cycle-length">周期长度：- 次AI回复</span>
                                <span id="ra_cycle_counter_badge" class="cycle-counter" title="当前AI回复楼层（从聊天记录现算）">AI回复：-</span>
                            </div>
                        </div>
                        <div class="cycle-fold collapsed">
                            <div class="cycle-fold-header" data-cycle-fold>
                                <span class="fold-arrow">▼</span>
                                <span>📊 周期详情与任务执行顺序</span>
                            </div>
                            <div class="cycle-fold-body">
                                <div class="cycle-info">
                                    <div class="cycle-trigger-info">
                                        💡 <strong>触发机制（事件驱动）</strong>：扩展在对话加载后自动进入后台监听，每条AI回复完成后由酒馆原生事件触发。<br>
                                        周期位置 = ((AI回复楼层 - 1) % 周期长度) + 1，纯函数现算，无需计数器变量。漏触发会自动累积补齐。
                                    </div>
                                    <div class="cycle-legend">
                                        <div class="cycle-legend-item"><span class="dot task"></span>分析任务</div>
                                        <div class="cycle-legend-item">🔁 周期循环</div>
                                    </div>
                                    <div id="ra_cycle_task_list" class="cycle-task-list"></div>
                                    <div class="cycle-note">
                                        💡 <strong>周期说明</strong>：周期长度 = 最后一个任务的周期位置。周期结束后，计数继续增长但位置回到1。<br>
                                        📊 每个任务的输出变量可被后续任务引用（周期性分析）。<br>
                                        ⚠️ 任务的"周期位置"表示在每个周期的第几次AI回复时触发（1-based）。<br>
                                        🔄 <strong>同位置多任务</strong>：多个任务在同一周期位置时，按顺序<u>分别发送API请求</u>独立执行，前面任务的输出可被后面任务引用。
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div class="task-scroll-area">
                            <div class="form-section">
                                <div class="form-header blue">■ 任务列表 <span style="font-weight:400;font-size:12px;opacity:0.8;">（动态添加，无数量限制）</span></div>
                                <div class="form-body">
                                    <div class="tip" style="margin-top:0;margin-bottom:12px;">
                                        <strong>周期位置</strong>：表示在每个周期的第几次AI回复时触发（支持多个，逗号分隔，如 5,10,15）。周期长度 = 所有任务里最大的那个数。<br>
                                        💡 <strong>额外关键词</strong>：可为输出条目添加额外触发词（如角色名），与输出条目关键词合并。<br>
                                        🔗 <strong>绑定角色</strong>：填写角色名（逗号分隔）后，任务只对这些角色生效；留空 = 对所有角色生效。
                                    </div>
                                    <div id="ra_task_slots"></div>
                                    <div id="ra_add_task_area" class="add-task-btn">➕ 添加新任务</div>
                                </div>
                            </div>
                        </div>
                        <div class="btn-row" style="margin-top:0;">
                            <button id="ra_tasks_reset" class="btn outline">🗑️ 清空所有任务</button>
                            <button id="ra_tasks_save" class="btn blue">💾 保存当前方案</button>
                        </div>
                    </div>
                </div>

                <div class="sub-content" data-subcontent="binding" style="padding:16px;display:none;">
                    <div class="form-section">
                        <div class="form-header blue">■ 当前角色绑定</div>
                        <div class="form-body">
                            <div id="ra_binding_status" class="status-box"></div>
                            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px;">
                                <button id="ra_bind_btn" class="btn green">📇 绑定配置到此角色卡</button>
                            </div>
                            <div class="tip" style="margin-top:12px;">
                                💡 <strong>卡片中心模型</strong>：RUBY 任务配置只随角色卡存在（写入卡内 <code>data.extensions</code> 字段）。打开角色卡后，导入模板或新建/修改任务会<strong>自动绑定并写入当前角色卡</strong>，导出/分享卡片即携带，其他环境导入即生效。<br>
                                💡 <strong>每个任务还可以单独限定角色</strong>：在任务配置卡片里填写"绑定角色"，留空则对所有角色生效。<br>
                                ⚠️ 未打开角色卡时配置只能暂存于全局层（不随卡导出），请打开角色卡后再配置；引擎只执行已绑定角色卡的配置。<br>
                                🔒 API密钥是全局本地的，与绑定无关，任何情况下都不会被导出或写入角色卡。
                            </div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header blue">■ 已绑定角色列表</div>
                        <div class="form-body"><div id="ra_bound_list" class="status-box"></div></div>
                    </div>
                </div>

                <div class="sub-content" data-subcontent="preset" style="padding:16px;display:none;">
                    <div class="form-section">
                        <div class="form-header blue">■ 配置模板导入导出</div>
                        <div class="form-body">
                            <div class="tip" style="margin-top:0;margin-bottom:16px;background:#e8f4e8;border-left-color:#2C5530;">
                                📦 <strong>即插即拔功能</strong>：将<strong>所有配置方案</strong>导出为模板文件，在其他角色或环境中快速导入复用。<br><br>
                                导出内容包括：所有配置方案（含各自的参考池/开局任务/分析任务）、自定义正文标签、破限设置、当前激活方案标记。<br>
                                <strong>不包含</strong>：API密钥等任何敏感信息。
                            </div>
                            <div id="ra_preset_summary" class="status-box" style="margin-bottom:16px;"></div>
                            <div style="display:flex;gap:12px;flex-wrap:wrap;">
                                <button id="ra_preset_export" class="btn green" style="flex:1;min-width:200px;">📤 导出配置模板</button>
                                <button id="ra_preset_import" class="btn blue" style="flex:1;min-width:200px;">📥 导入配置模板</button>
                            </div>
                            <input type="file" id="ra_preset_file_input" accept=".json" style="display:none;">
                            <div class="tip" style="margin-top:16px;">
                                ⚠️ 导入会写入<strong>当前角色卡</strong>并覆盖卡内已有方案（未打开角色卡时无法导入）；世界书条目（提示词、输出条目）需要在角色世界书中存在。
                            </div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header blue">■ 快速校验</div>
                        <div class="form-body">
                            <div class="tip" style="margin-top:0;margin-bottom:12px;">导入配置后，点击下方按钮检查所需的世界书条目是否存在。</div>
                            <button id="ra_preset_validate" class="btn outline" style="width:100%;">🔍 检查条目依赖</button>
                            <div id="ra_validate_result" class="status-box" style="margin-top:12px;display:none;"></div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header blue">■ 模板信息</div>
                        <div class="form-body"><div id="ra_template_info" class="status-box"><span style="color:#666;">未加载模板</span></div></div>
                    </div>
                </div>

                <div class="sub-content" data-subcontent="help" style="padding:16px;display:none;">
                    <div class="form-section">
                        <div class="form-header blue">■ 什么是参考条目池？</div>
                        <div class="form-body">
                            <div class="status-box">
                                参考条目池让你注册需要读取的世界书条目。每个条目分配一个变量名，在提示词中用 <code>{{变量名}}</code> 引用。<br><br>
                                <strong>示例：</strong><br>
                                • 关键词：角色_core → 变量名：coreContent<br>
                                • 关键词：美学指南 → 变量名：aesthetics<br><br>
                                然后在提示词中写：<br>
                                <code style="display:block;margin-top:8px;padding:8px;background:#e8e8e0;">参考人设：{{coreContent}}<br>美学标准：{{aesthetics}}</code>
                            </div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header blue">■ 什么是"引用其他任务输出"？</div>
                        <div class="form-body">
                            <div class="status-box">
                                任务之间可以相互引用结果。例如：<br><br>
                                • 任务1（思维链分析）在第10楼执行，输出保存到 {{task_1_Output}}<br>
                                • 任务2（SFW更新）在第20楼执行，可以勾选引用"任务1输出"<br>
                                • 任务2的提示词中写 {{task_1_Output}} 即可获取任务1的分析结果<br><br>
                                <strong>⚠️ 注意：</strong>被引用的任务必须先执行（周期位置更小）。任务也可以勾选引用"自己"（上次结果），实现跨周期累积。
                            </div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header blue">■ 楼层计算规则</div>
                        <div class="form-body">
                            <div class="status-box">
                                <strong>只计算AI回复消息</strong>，用户消息不计入楼层，被隐藏的AI正文也计入（分析需要完整剧情）。<br><br>
                                例如对话：<br>
                                用户: 你好 → 不计入<br>
                                AI: 你好呀 → 楼层1<br>
                                用户: 今天天气 → 不计入<br>
                                AI: 今天晴朗 → 楼层2<br><br>
                                任务设置周期位置=10，则每周期第10条AI回复时触发。
                            </div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header blue">■ 多角色支持 / 同位置多任务</div>
                        <div class="form-body">
                            <div class="status-box">
                                任务数量无限制，可以组合出任意调度方案：<br><br>
                                • 任务1：角色A - SFW分析（位置5）<br>
                                • 任务2：角色B - SFW分析（位置5）<br>
                                • 任务3：角色A - NSFW分析（位置10）<br>
                                • 任务4：角色B - NSFW分析（位置10）<br><br>
                                <strong>🔄 同位置多任务执行机制：</strong><br>
                                1. 按任务ID顺序<u>分别发送API请求</u>独立执行<br>
                                2. 前面任务的输出会即时更新，后面任务可直接引用<br>
                                3. 所有任务完成后统一保存到聊天世界书
                            </div>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="form-header blue">■ 安全说明</div>
                        <div class="form-body">
                            <div class="status-box">
                                🔒 API密钥只保存在本机扩展设置（settings.json），<u>绝不</u>写入角色卡、聊天世界书或导出模板。<br>
                                🔒 所有分析调用走酒馆官方请求通道（generateRaw / ChatCompletionService），由酒馆服务端转发出站，与正常聊天生成同形，无独立客户端特征；全程异步后台执行。<br>
                                🔒 更新通过酒馆扩展管理器的官方通道进行（manifest 已启用自动更新）。
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>`;
}

function wireTabs(root) {
    const saved = loadUIState();
    if (saved) {
        Object.assign(ui, { mode: saved.mode || 'player', playerSub: saved.playerSub || 'main', creatorSub: saved.creatorSub || 'refs' });
    }

    const applyMode = (mode) => {
        ui.mode = mode;
        root.querySelectorAll('.mode-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
        root.querySelectorAll('.panel-content').forEach((p) => p.classList.toggle('active', p.dataset.panel === mode));
        saveUIState();
    };

    const applySub = (panelEl, sub) => {
        if (!panelEl) return;
        panelEl.querySelectorAll('.sub-tab').forEach((t) => t.classList.toggle('active', t.dataset.sub === sub));
        panelEl.querySelectorAll('.sub-content').forEach((c) => {
            c.style.display = c.dataset.subcontent === sub ? 'block' : 'none';
        });
        if (panelEl.dataset.panel === 'creator') {
            const tasksContent = panelEl.querySelector('.sub-content[data-subcontent="tasks"]');
            if (tasksContent) {
                tasksContent.classList.toggle('tasks-fill', sub === 'tasks');
            }
        }
    };

    root.querySelectorAll('.mode-tab').forEach((tab) => {
        on(tab, 'click', () => {
            applyMode(tab.dataset.mode);
            const panelEl = root.querySelector(`.panel-content[data-panel="${tab.dataset.mode}"]`);
            applySub(panelEl, panelEl.querySelector('.sub-tab.active')?.dataset.sub || panelEl.querySelector('.sub-tab')?.dataset.sub);
            if (tab.dataset.mode === 'creator') requestAnimationFrame(() => renderCycleInfo());
            saveUIState();
        });
    });

    root.querySelectorAll('.sub-tab').forEach((tab) => {
        on(tab, 'click', () => {
            const panelEl = tab.closest('.panel-content');
            applySub(panelEl, tab.dataset.sub);
            if (panelEl.dataset.panel === 'player') ui.playerSub = tab.dataset.sub;
            else ui.creatorSub = tab.dataset.sub;
            if (tab.dataset.sub === 'tasks') requestAnimationFrame(() => renderCycleInfo());
            saveUIState();
        });
    });

    applyMode(ui.mode);
    applySub(root.querySelector('.panel-content[data-panel="player"]'), ui.playerSub);
    applySub(root.querySelector('.panel-content[data-panel="creator"]'), ui.creatorSub);
}

function wireGlobalInteractions() {
    if (interactionsBound) return;
    interactionsBound = true;

    document.addEventListener('click', (e) => {
        const refGroupHeader = e.target?.closest?.('.ref-group-header');
        if (refGroupHeader && !e.target.closest('.help-tip') && !e.target.closest('.ref-scan-cb')) {
            const group = refGroupHeader.closest('.ref-group');
            if (group) {
                e.preventDefault();
                group.classList.toggle('collapsed');
                if (refGroupHeader.dataset.refGroup === 'added') {
                    ui.refAddedCollapsed = group.classList.contains('collapsed');
                }
            }
            return;
        }
        const foldHeader = e.target?.closest?.('.cycle-fold-header');
        if (foldHeader) {
            e.preventDefault();
            foldHeader.closest('.cycle-fold')?.classList.toggle('collapsed');
            return;
        }
        const toggleBtn = e.target?.closest?.('.task-toggle-btn');
        if (toggleBtn) {
            e.preventDefault();
            const card = toggleBtn.closest('.task-card');
            if (!card) return;
            const id = parseInt(toggleBtn.dataset.id, 10);
            if (card.classList.contains('collapsed')) {
                card.classList.remove('collapsed');
                if (Number.isFinite(id)) ui.expandedTasks.add(id);
                toggleBtn.textContent = '▾ 配置';
            } else {
                card.classList.add('collapsed');
                if (Number.isFinite(id)) ui.expandedTasks.delete(id);
                toggleBtn.textContent = '▸ 配置';
            }
        }
    });

    const tipEl = document.createElement('div');
    tipEl.id = 'ra_help_tooltip';
    Object.assign(tipEl.style, {
        position: 'fixed', display: 'none', zIndex: '100000',
        background: '#333', color: '#fff', padding: '8px 12px', borderRadius: '6px',
        fontSize: '12px', lineHeight: '1.6', maxWidth: '260px', whiteSpace: 'pre-wrap',
        boxShadow: '0 4px 14px rgba(0,0,0,.4)', pointerEvents: 'none',
    });
    document.body.appendChild(tipEl);

    const showTip = (el) => {
        const txt = el.getAttribute('data-tip');
        if (!txt) return;
        tipEl.textContent = txt;
        tipEl.style.display = 'block';
        const r = el.getBoundingClientRect();
        let x = Math.round(r.left + r.width / 2 - tipEl.offsetWidth / 2);
        x = Math.max(8, Math.min(x, window.innerWidth - tipEl.offsetWidth - 8));
        let y = Math.round(r.top - tipEl.offsetHeight - 8);
        if (y < 8) y = Math.round(r.bottom + 8);
        tipEl.style.left = `${x}px`;
        tipEl.style.top = `${y}px`;
    };
    const hideTip = () => { tipEl.style.display = 'none'; };

    document.addEventListener('mouseover', (e) => {
        const el = e.target?.closest?.('.help-tip');
        if (el) showTip(el);
    });
    document.addEventListener('mouseout', (e) => {
        if (e.target?.closest?.('.help-tip')) hideTip();
    });
    document.addEventListener('touchstart', (e) => {
        const el = e.target?.closest?.('.help-tip');
        if (el) { e.preventDefault(); showTip(el); } else { hideTip(); }
    }, { passive: false });
}

function renderStatus(layer, source) {
    const el = $('ra_status');
    if (!el) return;
    const es = engine.getEngineState();
    const identity = config.getCharacterIdentity();
    const layerText = layer === 'character'
        ? (source === 'card' ? '角色卡内嵌配置 📇' : '角色绑定（本地旧版存储）')
        : '全局（未绑定角色卡 ⚠️）';

    if (!identity) {
        el.innerHTML = `
            <span class="status-warn">⚠ 未打开角色对话（或为群聊），引擎待机</span><br>
            <span class="status-warn">RUBY 配置保存在角色卡内——请打开角色卡后再配置任务，保存时自动绑定到当前卡</span>`;
        return;
    }

    const engineLine = es.armed
        ? `<span class="status-ok">🟢 后台监听运行中</span>`
        : (layer === 'character'
            ? '<span class="status-warn">🟡 待机：当前配置层没有启用的任务</span>'
            : '<span class="status-warn">🟡 待机：配置未绑定角色卡——保存修改将自动写入当前卡，或到"角色绑定"页立即绑定</span>');

    el.innerHTML = `
        <span class="status-ok">✓ 系统就绪</span>（配置层：${layerText} · ${h(identity.name)}）<br>
        ${engineLine}${es.running ? ' · <span style="color:#1E4B8E;">⚙️ 正在执行分析…</span>' : ''}<br>
        <span style="font-size:12px;color:#666;">AI回复：${es.aiCount} 层 · 周期位置：${es.position}/${es.cycleLength || '-'} ${es.lastRunSummary ? `· 上次执行：${h(es.lastRunSummary)}` : ''}</span>
        ${es.lastError ? `<br><span class="status-err">上次错误：${h(es.lastError)}</span>` : ''}`;
}

function renderPresetDisplay(data, layer) {
    const el = $('ra_current_preset');
    if (!el) return;
    const preset = config.getActivePreset(data);
    const taskCount = (preset.tasks || []).filter((t) => t.enabled).length;
    el.innerHTML = `
        <div style="flex:1;">
            <div style="font-weight:700;font-size:16px;color:#1E4B8E;">📌 ${h(preset.name || '默认方案')}</div>
            <div style="font-size:12px;color:#666;margin-top:4px;">${taskCount > 0 ? `${taskCount}个分析任务` : '暂无任务配置'}${layer !== 'character' ? ' · <span style="color:#8B4513;">⚠️ 未绑定角色卡</span>' : ''}</div>
        </div>
        <button class="btn outline small ra-switch-btn">🔄 切换方案</button>`;
    on(el.querySelector('.ra-switch-btn'), 'click', () => {
        const panelEl = document.querySelector('.panel-content[data-panel="player"]');
        panelEl?.querySelectorAll('.sub-tab').forEach((t) => t.classList.toggle('active', t.dataset.sub === 'presets'));
        panelEl?.querySelectorAll('.sub-content').forEach((c) => {
            c.style.display = c.dataset.subcontent === 'presets' ? 'block' : 'none';
        });
    });
}

function renderManualButtons(data, layer) {
    const el = $('ra_manual_buttons');
    if (!el) return;
    const preset = config.getActivePreset(data);
    const identity = config.getCharacterIdentity();

    if (!identity) {
        el.innerHTML = '<span style="color:#1a1a1a;font-size:14px;">请先打开角色对话</span>';
        return;
    }
    if (layer !== 'character') {
        el.innerHTML = '<span class="status-warn">⚠ 配置未绑定角色卡——到创作者版面"角色绑定"页绑定后执行（保存修改也会自动绑定到当前卡）</span>';
        return;
    }

    const buttons = [];
    if (preset.startupTask?.enabled) {
        buttons.push(`<button class="btn green" data-run="startup">${h(preset.startupTask.displayName || '开局分析')}</button>`);
    }
    for (const task of preset.tasks || []) {
        if (task.enabled && scheduler.taskMatchesCharacter(task, identity)) {
            buttons.push(`<button class="btn green" data-run="task" data-id="${task.id}">${h(task.displayName || `任务#${task.id}`)}</button>`);
        }
    }
    if (buttons.length > 1) {
        buttons.push(`<button class="btn blue" data-run="all">▶ 全部执行</button>`);
    }

    el.innerHTML = buttons.join('') || '<span style="color:#1a1a1a;font-size:14px;">暂无启用的任务</span>';
    el.querySelectorAll('[data-run]').forEach((btn) => {
        on(btn, 'click', async () => {
            const kind = btn.dataset.run;
            const id = parseInt(btn.dataset.id, 10);
            closePanel();
            try {
                await engine.forceRun(kind, id);
            } catch (e) {
                window.toastr?.error?.(e.message || '执行失败', '', { timeOut: 6000 });
            }
        });
    });
}

function renderSchedule(data, layer) {
    const el = $('ra_schedule');
    if (!el) return;
    const preset = config.getActivePreset(data);
    const identity = config.getCharacterIdentity();
    const lines = [];

    if (!identity) {
        el.innerHTML = '<span style="color:#1a1a1a;">请先打开角色对话</span>';
        return;
    }
    if (layer !== 'character') {
        el.innerHTML = '<span class="status-warn">⚠ 配置未绑定角色卡，任务不会自动执行——保存修改将自动绑定到当前角色卡</span>';
        return;
    }

    if (preset.startupTask?.enabled && scheduler.taskMatchesCharacter(preset.startupTask, identity)) {
        const positions = scheduler.startupPositions(preset.startupTask).join(',');
        lines.push(`<div>📌 位置<strong>${positions}</strong> → ${h(preset.startupTask.displayName || '开局分析')}</div>`);
    }
    const enabled = (preset.tasks || []).filter((t) => t.enabled && scheduler.taskMatchesCharacter(t, identity));
    enabled.sort((a, b) => (activePositionsOf(a)[0] || 0) - (activePositionsOf(b)[0] || 0));
    for (const task of enabled) {
        lines.push(`<div>📌 位置<strong>${activePositionsOf(task).join(',') || '?'}</strong> → ${h(task.displayName || `任务#${task.id}`)}</div>`);
    }
    el.innerHTML = lines.length ? lines.join('') : '<span style="color:#1a1a1a;">暂无任务配置</span>';
}

async function checkEntryStatus(data) {
    const el = $('ra_entries');
    if (!el) return;
    const preset = config.getActivePreset(data);
    const entries = [];
    for (const ref of preset.referencePool || []) {
        if (ref.entryKey) entries.push({ key: ref.entryKey, label: ref.label || ref.varName, type: '参考' });
    }
    for (const task of preset.tasks || []) {
        if (task.promptKey) entries.push({ key: task.promptKey, label: `${task.displayName || `任务#${task.id}`}提示词`, type: '提示词' });
    }

    if (entries.length === 0) {
        el.innerHTML = '<span style="color:#1a1a1a;">暂无配置条目</span>';
        return;
    }

    try {
        const charBook = await worldbook.getCharBookName();
        if (!charBook) {
            el.innerHTML = '<span class="status-warn">⚠ 未找到角色世界书</span>';
            return;
        }
        const results = [];
        for (const e of entries.slice(0, 12)) {
            const found = await worldbook.entryExists(charBook, e.key);
            results.push(`<span class="${found ? 'status-ok' : 'status-warn'}">${found ? '✓' : '⚠'} [${e.type}] ${h(e.label)}</span>`);
        }
        el.innerHTML = results.join('<br>')
            + (entries.length > 12 ? `<br><span style="color:#1a1a1a;">...还有${entries.length - 12}个</span>` : '')
            + '<div style="margin-top:8px;font-size:12px;color:#666;">💡 仅检查参考条目和提示词。输出条目会在分析执行时自动创建到聊天世界书，无需预先存在。</div>';
    } catch (e) {
        el.innerHTML = `<span class="status-err">检查失败：${h(e.message)}</span>`;
    }
}

function renderPresetList(data) {
    const el = $('ra_preset_list');
    if (!el) return;
    const presets = data.presets || [];
    const activeId = data.activePresetId;

    if (presets.length === 0) {
        el.innerHTML = '<span style="color:#666;">暂无配置方案</span>';
        return;
    }

    el.innerHTML = presets.map((preset) => {
        const isActive = preset.id === activeId;
        const taskCount = (preset.tasks || []).filter((t) => t.enabled).length;
        return `
        <div class="preset-card" data-id="${h(preset.id)}" style="padding:14px;background:${isActive ? 'linear-gradient(135deg,#e8f5e9 0%,#c8e6c9 100%)' : '#fff'};border:2px solid ${isActive ? '#2C5530' : '#999'};border-radius:6px;cursor:pointer;transition:all .2s;">
            <div style="display:flex;align-items:center;gap:10px;">
                <span style="font-size:20px;">${isActive ? '✅' : '⭕'}</span>
                <div style="flex:1;">
                    <div style="font-weight:700;font-size:15px;color:${isActive ? '#1A3A1E' : '#1a1a1a'};">${h(preset.name || '未命名方案')}</div>
                    <div style="font-size:12px;color:#666;margin-top:2px;">${preset.description ? h(preset.description) : ''}</div>
                    <div style="font-size:11px;color:#888;margin-top:4px;">${taskCount > 0 ? `📋 ${taskCount}个分析任务` : '⚠️ 暂无任务'}</div>
                </div>
                ${isActive ? '<span style="background:#2C5530;color:#fff;padding:4px 10px;border-radius:12px;font-size:11px;font-weight:600;">当前使用</span>' : '<span style="color:#1E4B8E;font-size:12px;">点击切换 →</span>'}
            </div>
        </div>`;
    }).join('');

    el.querySelectorAll('.preset-card').forEach((card) => {
        on(card, 'click', async () => {
            const presetId = card.dataset.id;
            if (presetId === data.activePresetId) return;
            const target = presets.find((p) => p.id === presetId);
            if (!window.confirm(`确定切换到"${target?.name || presetId}"方案吗？`)) return;
            withConfigData((d) => { d.activePresetId = presetId; });
            window.toastr?.success?.('已切换配置方案');
            engine.reinit();
            refreshAll();
        });
    });

    renderPresetDetail(data, activeId);
}

function renderPresetDetail(data, presetId) {
    const el = $('ra_preset_detail');
    if (!el) return;
    const preset = data.presets.find((p) => p.id === presetId);
    if (!preset) {
        el.innerHTML = '<span style="color:#666;">未找到方案</span>';
        return;
    }
    const enabled = (preset.tasks || []).filter((t) => t.enabled)
        .sort((a, b) => (activePositionsOf(a)[0] || 0) - (activePositionsOf(b)[0] || 0));
    let html = `<div style="font-weight:700;font-size:15px;margin-bottom:10px;">📋 ${h(preset.name)}</div>`;
    for (const task of enabled) {
        html += `<div style="padding:6px 0;border-bottom:1px dashed #ddd;">📌 位置${activePositionsOf(task).join(',') || '?'} → ${h(task.displayName || `任务#${task.id}`)}</div>`;
    }
    if (enabled.length === 0) html += '<div style="color:#666;padding:10px 0;">暂无任务配置</div>';
    el.innerHTML = html;
}

function loadApiTab(data) {
    const apiCfg = config.getApiConfig();
    const uiCfg = config.getUi();
    const providerSel = $('ra_api_provider');
    if (!providerSel) return;

    providerSel.value = apiCfg.provider === 'custom' ? 'custom' : 'main';
    $('ra_api_url').value = apiCfg.url || '';
    $('ra_api_key').value = apiCfg.key || '';
    $('ra_api_stream').checked = apiCfg.stream !== false;
    $('ra_notify').checked = uiCfg.notify !== false;
    $('ra_orb_show').checked = !uiCfg.orbHidden;

    const modelSelect = $('ra_api_model_select');
    const modelText = $('ra_api_model_text');
    if (Array.isArray(apiCfg.cache) && apiCfg.cache.length > 0) {
        modelSelect.innerHTML = apiCfg.cache.map((id) => `<option value="${h(id)}">${h(id)}</option>`).join('');
        if (apiCfg.model) modelSelect.value = apiCfg.model;
    }
    modelText.value = apiCfg.model || '';

    const gen = data.gen || {};
    $('ra_gen_temp').value = gen.temperature ?? '';
    $('ra_gen_top_p').value = gen.top_p ?? '';
    $('ra_gen_top_k').value = gen.top_k ?? '';
    $('ra_gen_pp').value = gen.presence_penalty ?? '';
    $('ra_gen_fp').value = gen.frequency_penalty ?? '';
    $('ra_gen_effort').value = gen.reasoning_effort || '';

    const genInputs = ['ra_gen_temp', 'ra_gen_top_p', 'ra_gen_top_k', 'ra_gen_pp', 'ra_gen_fp', 'ra_gen_effort'];
    const syncGenEnabled = () => {
        const enabled = !!$('ra_gen_enable').checked;
        genInputs.forEach((id) => { $(id).disabled = !enabled; });
    };
    $('ra_gen_enable').checked = gen.enabled === true;
    syncGenEnabled();
    $('ra_gen_enable').onchange = syncGenEnabled;

    const syncProviderUi = () => {
        const isCustom = providerSel.value === 'custom';
        $('ra_api_url_wrap').classList.toggle('hidden', !isCustom);
        $('ra_api_key_wrap').classList.toggle('hidden', !isCustom);
        $('ra_api_connect').classList.toggle('hidden', !isCustom);
        $('ra_api_stream_label')?.classList.toggle('hidden', !isCustom);
        const hasOptions = modelSelect.options.length > 0;
        modelSelect.classList.toggle('hidden', !isCustom || !hasOptions);
        modelText.classList.toggle('hidden', !isCustom || hasOptions);
    };
    syncProviderUi();
    providerSel.onchange = () => {
        syncProviderUi();
        if (providerSel.value === 'custom' && !$('ra_api_url').value.trim()) {
            $('ra_api_url').value = 'https://api.openai.com/v1';
        }
    };
    modelSelect.onchange = () => {
        const chosen = modelSelect.value || '';
        if (chosen) {
            config.saveApiConfig({ provider: providerSel.value, model: chosen });
            window.toastr?.success?.('已选择模型');
        }
    };
}

function wirePlayerSections() {
    on($('ra_api_connect'), 'click', async () => {
        const btn = $('ra_api_connect');
        try {
            const base = $('ra_api_url').value.trim();
            const key = $('ra_api_key').value.trim();
            if (!base) { window.toastr?.warning?.('请先填写 API 地址'); return; }
            if (!key) { window.toastr?.warning?.('请先填写 KEY'); return; }
            btn.disabled = true;
            btn.textContent = '连接中...';
            const models = await ai.fetchModelList(base, key);
            if (!models.length) { window.toastr?.warning?.('未获取到模型'); return; }
            const modelSelect = $('ra_api_model_select');
            modelSelect.innerHTML = models.map((id) => `<option value="${h(id)}">${h(id)}</option>`).join('');
            config.saveApiConfig({ provider: 'custom', url: base, key, cache: models, model: models[0] });
            modelSelect.value = models[0];
            modelSelect.classList.remove('hidden');
            $('ra_api_model_text').classList.add('hidden');
            window.toastr?.success?.(`获取成功：${models.length} 个模型`);
        } catch (e) {
            window.toastr?.error?.(e.message || '连接失败');
        } finally {
            btn.disabled = false;
            btn.textContent = '连接/拉取模型';
        }
    });

    on($('ra_gen_reset'), 'click', () => {
        ['ra_gen_temp', 'ra_gen_top_p', 'ra_gen_top_k', 'ra_gen_pp', 'ra_gen_fp'].forEach((id) => {
            const el = $(id);
            if (el) el.value = '';
        });
        $('ra_gen_effort').value = '';
        $('ra_gen_enable').checked = false;
        $('ra_gen_enable').onchange?.();
        window.toastr?.success?.('已清空，恢复默认（不发送生成参数，跟随酒馆/服务商设置）');
    });

    on($('ra_api_save'), 'click', () => {
        try {
            const providerSel = $('ra_api_provider');
            const modelSelect = $('ra_api_model_select');
            const isCustom = providerSel.value === 'custom';
            const hasSelectOptions = modelSelect.options.length > 0 && !modelSelect.classList.contains('hidden');
            const modelValue = isCustom ? (hasSelectOptions ? modelSelect.value : $('ra_api_model_text').value.trim()) : '';

            config.saveApiConfig({
                provider: providerSel.value,
                url: $('ra_api_url').value.trim(),
                key: $('ra_api_key').value.trim(),
                model: modelValue,
                stream: !!$('ra_api_stream').checked,
            });
            config.saveUi({
                notify: !!$('ra_notify').checked,
                orbHidden: !$('ra_orb_show').checked,
            });
            window.dispatchEvent(new CustomEvent('ruby:ui-changed'));

            const num = (id) => {
                const v = parseFloat($(id)?.value);
                return Number.isFinite(v) ? v : undefined;
            };
            withConfigData((d) => {
                d.gen = {
                    enabled: !!$('ra_gen_enable').checked,
                    temperature: num('ra_gen_temp'),
                    top_p: num('ra_gen_top_p'),
                    top_k: num('ra_gen_top_k'),
                    presence_penalty: num('ra_gen_pp'),
                    frequency_penalty: num('ra_gen_fp'),
                    reasoning_effort: $('ra_gen_effort').value || undefined,
                };
            });
            window.toastr?.success?.('API设置已保存');
        } catch (e) {
            window.toastr?.error?.('保存失败: ' + e.message);
        }
    });
}

function collectJailbreakFromUI() {
    const container = $('ra_jailbreak_items');
    if (!container) return [];
    return [...container.querySelectorAll('.jailbreak-item[data-id]')].map((card, idx) => jailbreak.normalizeJailbreakItem({
        id: card.dataset.id,
        enabled: !!card.querySelector('.jb-enabled')?.checked,
        position: card.querySelector('.jb-position')?.value || 'beforeUser',
        role: card.querySelector('.jb-role')?.value || 'system',
        content: card.querySelector('.jb-content')?.value || '',
    }, idx));
}

function renderJailbreakItems() {
    const container = $('ra_jailbreak_items');
    if (!container) return;
    if (ui.jailbreakItems.length === 0) ui.jailbreakItems = jailbreak.cloneDefaultItems();

    const positionLabel = (pos) => (pos === 'beforeUser' ? '任务提示词前' : pos === 'afterUser' ? '任务提示词后' : '尾部追加');
    container.innerHTML = ui.jailbreakItems.map((item, idx) => {
        const collapsed = ui.collapsedJb.has(item.id);
        const summary = item.content.trim()
            ? item.content.trim().replace(/\s+/g, ' ').slice(0, 36)
            : '空文本';
        return `
        <div class="jailbreak-item ${collapsed ? 'collapsed' : ''}" data-id="${h(item.id)}">
            <div class="jailbreak-head" title="点击展开或折叠">
                <button type="button" class="btn outline small jb-toggle">${collapsed ? '展开' : '折叠'}</button>
                <label class="inline"><input type="checkbox" class="jb-enabled" ${item.enabled ? 'checked' : ''}> 启用</label>
                <span class="jb-title">段落 ${idx + 1}</span>
                <select class="jb-position w150">
                    <option value="beforeUser" ${item.position === 'beforeUser' ? 'selected' : ''}>任务提示词前</option>
                    <option value="afterUser" ${item.position === 'afterUser' ? 'selected' : ''}>任务提示词后</option>
                    <option value="tail" ${item.position === 'tail' ? 'selected' : ''}>尾部追加</option>
                </select>
                <select class="jb-role w120">
                    <option value="system" ${item.role === 'system' ? 'selected' : ''}>system</option>
                    <option value="assistant" ${item.role === 'assistant' ? 'selected' : ''}>assistant</option>
                    <option value="user" ${item.role === 'user' ? 'selected' : ''}>user</option>
                </select>
                <span class="jailbreak-summary">${positionLabel(item.position)} / ${h(item.role)} / ${h(summary)}</span>
                <span class="jailbreak-actions">
                    <button type="button" class="btn outline small jb-up" ${idx === 0 ? 'disabled' : ''}>上移</button>
                    <button type="button" class="btn outline small jb-down" ${idx === ui.jailbreakItems.length - 1 ? 'disabled' : ''}>下移</button>
                    <button type="button" class="btn red small jb-delete">删除</button>
                </span>
            </div>
            <div class="jailbreak-body">
                <textarea class="jb-content" placeholder="填写破限文本；可用 {{taskType}} 表示当前任务名">${h(item.content)}</textarea>
            </div>
        </div>`;
    }).join('');

    const syncFromDom = () => { ui.jailbreakItems = collectJailbreakFromUI(); };
    container.querySelectorAll('.jb-enabled,.jb-position,.jb-role,.jb-content').forEach((el) => {
        on(el, 'change', syncFromDom);
        on(el, 'input', syncFromDom);
    });

    const toggleCard = (card) => {
        const id = card.dataset.id;
        const willCollapse = !card.classList.contains('collapsed');
        card.classList.toggle('collapsed', willCollapse);
        if (willCollapse) ui.collapsedJb.add(id);
        else ui.collapsedJb.delete(id);
        card.querySelector('.jb-toggle').textContent = willCollapse ? '展开' : '折叠';
    };

    container.querySelectorAll('.jailbreak-head').forEach((head) => {
        on(head, 'click', (e) => {
            if (e.target?.closest?.('select,input,button,label,.inline,.jailbreak-actions')) return;
            toggleCard(head.closest('.jailbreak-item'));
        });
    });
    container.querySelectorAll('.jb-toggle').forEach((btn) => {
        on(btn, 'click', (e) => {
            e.stopPropagation();
            toggleCard(btn.closest('.jailbreak-item'));
        });
    });
    container.querySelectorAll('.jb-up').forEach((btn) => {
        on(btn, 'click', () => {
            ui.jailbreakItems = collectJailbreakFromUI();
            const idx = [...container.querySelectorAll('.jailbreak-item')].indexOf(btn.closest('.jailbreak-item'));
            if (idx > 0) {
                [ui.jailbreakItems[idx - 1], ui.jailbreakItems[idx]] = [ui.jailbreakItems[idx], ui.jailbreakItems[idx - 1]];
                renderJailbreakItems();
            }
        });
    });
    container.querySelectorAll('.jb-down').forEach((btn) => {
        on(btn, 'click', () => {
            ui.jailbreakItems = collectJailbreakFromUI();
            const idx = [...container.querySelectorAll('.jailbreak-item')].indexOf(btn.closest('.jailbreak-item'));
            if (idx >= 0 && idx < ui.jailbreakItems.length - 1) {
                [ui.jailbreakItems[idx], ui.jailbreakItems[idx + 1]] = [ui.jailbreakItems[idx + 1], ui.jailbreakItems[idx]];
                renderJailbreakItems();
            }
        });
    });
    container.querySelectorAll('.jb-delete').forEach((btn) => {
        on(btn, 'click', () => {
            ui.jailbreakItems = collectJailbreakFromUI();
            const idx = [...container.querySelectorAll('.jailbreak-item')].indexOf(btn.closest('.jailbreak-item'));
            if (idx >= 0) {
                ui.jailbreakItems.splice(idx, 1);
                renderJailbreakItems();
            }
        });
    });
}

function wireJailbreakControls() {
    on($('ra_jb_add'), 'click', () => {
        ui.jailbreakItems = collectJailbreakFromUI();
        const id = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        ui.jailbreakItems.push(jailbreak.normalizeJailbreakItem({ id, enabled: true, position: 'beforeUser', role: 'system', content: '' }, ui.jailbreakItems.length));
        ui.collapsedJb.delete(id);
        renderJailbreakItems();
    });

    on($('ra_jb_reset'), 'click', () => {
        if (!window.confirm('确定恢复默认破限配置吗？当前未保存的修改会被覆盖。')) return;
        ui.jailbreakItems = jailbreak.cloneDefaultItems();
        ui.collapsedJb.clear();
        renderJailbreakItems();
        window.toastr?.success?.('已恢复默认破限配置，请点击保存生效');
    });

    on($('ra_jb_save'), 'click', () => {
        ui.jailbreakItems = collectJailbreakFromUI();
        withConfigData((d) => {
            d.jailbreak = { items: ui.jailbreakItems };
        });
        window.toastr?.success?.('破限设置已保存');
    });
}

function renderTagsList() {
    const el = $('ra_tags_list');
    if (!el) return;
    if (ui.tags.length === 0) {
        el.innerHTML = '<span style="color:#1a1a1a;font-size:14px;">暂无自定义标签</span>';
        return;
    }
    el.innerHTML = ui.tags.map((tag, idx) => `
        <span class="custom-tag">&lt;${h(tag)}&gt;<button data-idx="${idx}" title="删除">✕</button></span>
    `).join('');
    el.querySelectorAll('.custom-tag button').forEach((btn) => {
        on(btn, 'click', () => {
            const idx = parseInt(btn.dataset.idx, 10);
            if (!isNaN(idx) && idx >= 0 && idx < ui.tags.length) {
                const removed = ui.tags.splice(idx, 1)[0];
                renderTagsList();
                window.toastr?.info?.(`已移除标签: <${removed}>`);
            }
        });
    });
}

function wireTagControls() {
    const addTag = () => {
        const tag = $('ra_new_tag_input')?.value.trim().toLowerCase();
        if (!tag) { window.toastr?.warning?.('请输入标签名'); return; }
        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(tag)) {
            window.toastr?.warning?.('标签名只能包含字母、数字、下划线和连字符');
            return;
        }
        if (ui.tags.includes(tag)) { window.toastr?.warning?.('标签已存在'); return; }
        ui.tags.push(tag);
        $('ra_new_tag_input').value = '';
        renderTagsList();
        window.toastr?.success?.(`已添加标签: <${tag}>`);
    };
    on($('ra_add_tag_btn'), 'click', addTag);
    on($('ra_new_tag_input'), 'keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addTag(); }
    });
    on($('ra_tags_save'), 'click', () => {
        withConfigData((d) => { d.customContentTags = [...ui.tags]; });
        window.toastr?.success?.('标签设置已保存');
    });
}

async function scanRefEntries() {
    const charBook = await worldbook.getCharBookName();
    if (!charBook) throw new Error('未找到角色世界书');
    return worldbook.scanBookKeys(charBook);
}

async function ensureScannedKeys() {
    if (!Array.isArray(ui.scannedKeys) || ui.scannedKeys.length === 0) {
        ui.scannedKeys = await scanRefEntries();
    }
    return ui.scannedKeys;
}

function promptSelectableKeys(allKeys) {
    const refNormSet = new Set((ui.refs || []).map((ref) => normalizeKeyword(ref?.entryKey || '')).filter(Boolean));
    return (Array.isArray(allKeys) ? allKeys : []).filter((key) => !refNormSet.has(normalizeKeyword(key)));
}

function renderRefPool() {
    const container = $('ra_ref_pool_list');
    if (!container) return;

    if (!ui.scanMode) {
        if (!ui.refs.length) {
            container.innerHTML = '<div style="color:#1a1a1a;font-size:14px;padding:12px;background:#f8f8f5;border:1px dashed #999;">暂无参考条目，点击下方"扫描角色世界书"添加</div>';
            return;
        }
        container.innerHTML = `
        <div class="ref-group ${ui.refAddedCollapsed ? 'collapsed' : ''}">
            <div class="ref-group-header" data-ref-group="added">
                <span class="fold-arrow">▼</span>
                <span>✅ 已加入参考</span>
                <span class="ref-group-count">${ui.refs.length}</span>
                <span class="help-tip" data-tip="已经选进参考池的条目。&#10;点这一行展开查看/收起。&#10;要增删就点扫描，在扫描列表里勾选">?</span>
            </div>
            <div class="ref-group-body">
                ${ui.refs.map((ref) => `<div class="ref-item"><span style="color:#1a1a1a;font-size:14px;font-weight:600;">${h(ref.entryKey || '')}</span></div>`).join('')}
            </div>
        </div>`;
        return;
    }

    if (!Array.isArray(ui.scannedKeys) || ui.scannedKeys.length === 0) {
        container.innerHTML = '<div style="color:#1a1a1a;font-size:14px;padding:12px;background:#f8f8f5;border:1px dashed #999;">暂无扫描结果，请点击"扫描角色世界书"</div>';
        return;
    }

    const addedList = ui.refs.map((ref) => ({
        key: String(ref.entryKey || ''),
        inScan: ui.scannedKeys.includes(ref.entryKey),
    }));
    const addedKeySet = new Set(addedList.map((x) => x.key));
    const newKeys = ui.scannedKeys.filter((k) => !addedKeySet.has(k));

    const renderItem = (entryKey, checked, extra = '') => `
        <label class="ref-item" style="cursor:pointer;">
            <input type="checkbox" class="ref-scan-cb" data-key="${h(entryKey)}" ${checked ? 'checked' : ''}>
            <span style="color:#1a1a1a;font-size:14px;font-weight:600;">${h(entryKey)}</span>
            ${extra}
        </label>`;

    container.innerHTML = `
        <div class="ref-group ${ui.refAddedCollapsed ? 'collapsed' : ''}">
            <div class="ref-group-header" data-ref-group="added">
                <span class="fold-arrow">▼</span>
                <span>✅ 已加入参考</span>
                <span class="ref-group-count">${addedList.length}</span>
            </div>
            <div class="ref-group-body">
                ${addedList.length > 0
                    ? addedList.map((x) => renderItem(x.key, true, x.inScan ? '' : '<span style="font-size:11px;color:#8B4513;background:#fff3cd;border:1px solid #ffc107;border-radius:3px;padding:0 5px;margin-left:6px;">⚠ 扫描未找到</span>')).join('')
                    : '<div class="ref-group-empty">暂无已加入条目</div>'}
            </div>
        </div>
        <div class="ref-group">
            <div class="ref-group-header" data-ref-group="new">
                <span class="fold-arrow">▼</span>
                <span>🆕 未加入（扫描结果）</span>
                <span class="ref-group-count new">${newKeys.length}</span>
            </div>
            <div class="ref-group-body">
                ${newKeys.length > 0
                    ? newKeys.map((k) => renderItem(k, false)).join('')
                    : '<div class="ref-group-empty">扫描到的条目都已加入参考池</div>'}
            </div>
        </div>`;
}

function wireRefPoolControls() {
    on($('ra_scan_refs_btn'), 'click', async () => {
        try {
            window.toastr?.info?.('🔍 正在扫描角色世界书条目...');
            ui.scannedKeys = await scanRefEntries();
            ui.scanMode = true;
            renderRefPool();
            window.toastr?.success?.(`✅ 扫描完成，共 ${ui.scannedKeys.length} 个关键词`);
        } catch (e) {
            window.toastr?.error?.(`扫描失败: ${e.message}`);
        }
    });

    on($('ra_refs_save'), 'click', async () => {
        try {
            if (ui.scanMode) {
                const checkedKeys = [...document.querySelectorAll('.ref-scan-cb:checked')]
                    .map((cb) => String(cb.dataset.key || '').trim())
                    .filter(Boolean);

                const usedVarNames = new Set();
                const oldByKey = new Map((ui.refs || []).map((ref) => [String(ref.entryKey || ''), ref]));

                const nextRefs = checkedKeys.map((entryKey) => {
                    const old = oldByKey.get(entryKey);
                    const varName = (old?.varName && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(old.varName))
                        ? (usedVarNames.add(old.varName), old.varName)
                        : buildAutoVarName(entryKey, usedVarNames);
                    return {
                        entryKey,
                        varName,
                        label: (old?.label && String(old.label).trim()) ? String(old.label).trim() : entryKey,
                    };
                });

                ui.tasks = collectTasksFromUI();
                ui.refs = nextRefs;
                ui.scanMode = false;
                renderRefPool();
                renderTaskSlots();
            }
            await saveCurrentSchemeFromUI();
            config.flushCardPersistNow().catch(() => { /* flush 内部已上报错误 */ });
            window.toastr?.success?.(`✅ 已保存 ${ui.refs.length} 个参考条目（仅保留勾选项）`);
        } catch (e) {
            window.toastr?.error?.('保存失败: ' + e.message);
        }
    });
}

function collectTasksFromUI() {
    const tasks = [];
    document.querySelectorAll('.task-card[data-id]').forEach((card) => {
        const id = parseInt(card.dataset.id, 10);
        if (isNaN(id)) return;

        const useRefs = [...card.querySelectorAll(`.ref-cb[data-id="${id}"]:checked`)].map((cb) => cb.dataset.var);
        const useOutputs = [...card.querySelectorAll(`.output-cb[data-id="${id}"]:checked`)].map((cb) => cb.dataset.var);

        const insertPosition = parseInt(card.querySelector(`.task-position[data-id="${id}"]`)?.value, 10) || 0;
        const depth = parseInt(card.querySelector(`.task-depth[data-id="${id}"]`)?.value, 10) || 4;
        const order = parseInt(card.querySelector(`.task-order[data-id="${id}"]`)?.value, 10) || 100;

        const cyclePosRaw = (card.querySelector(`.task-floor[data-id="${id}"]`)?.value || '')
            .split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0);
        const firstPos = cyclePosRaw.length > 0 ? cyclePosRaw[0] : 0;

        const characters = (card.querySelector(`.task-characters[data-id="${id}"]`)?.value || '')
            .split(/[,，]/).map((s) => s.trim()).filter(Boolean);

        tasks.push(config.normalizeTask({
            id,
            enabled: !!card.querySelector(`.task-enabled[data-id="${id}"]`)?.checked,
            displayName: card.querySelector(`.task-name[data-id="${id}"]`)?.value || '',
            cyclePositions: cyclePosRaw,
            cyclePosition: firstPos,
            triggerFloor: firstPos,
            promptKey: card.querySelector(`.task-prompt-select[data-id="${id}"]`)?.value || '',
            outputKey: card.querySelector(`.task-output[data-id="${id}"]`)?.value || '',
            extraKeys: card.querySelector(`.task-extrakeys[data-id="${id}"]`)?.value || '',
            outputVarName: `task_${id}_Output`,
            outputConstant: !!card.querySelector(`.task-const[data-id="${id}"]`)?.checked,
            outputDisable: card.querySelector(`.task-hide[data-id="${id}"]`)?.checked ? 1 : 0,
            selective: !!card.querySelector(`.task-sel[data-id="${id}"]`)?.checked,
            keywordScanEnabled: !!card.querySelector(`.task-keyword-scan-enabled[data-id="${id}"]`)?.checked,
            keywordScanKeywords: [...card.querySelectorAll(`.task-keyword-scan-input[data-id="${id}"]`)].map((input) => input.value.trim()).filter(Boolean),
            noRecursion: !!card.querySelector(`.task-no-recursion[data-id="${id}"]`)?.checked,
            position: insertPosition,
            depth,
            order,
            characters,
            useReferences: useRefs,
            useOutputs: useOutputs,
        }));
    });

    const refKeyByVar = new Map((ui.refs || []).map((r) => [String(r.varName || ''), String(r.entryKey || '').trim()]));
    const outputKeyByVar = new Map(tasks.map((t) => [String(t.outputVarName || `task_${t.id}_Output`), String(t.outputKey || '').trim()]));

    for (const t of tasks) {
        const selectedRefKeys = (Array.isArray(t.useReferences) ? t.useReferences : [])
            .map((varName) => refKeyByVar.get(String(varName || '')) || '')
            .filter(Boolean);
        const selfOutputVar = String(t.outputVarName || `task_${t.id}_Output`);
        t.useOutputs = (Array.isArray(t.useOutputs) ? t.useOutputs : []).filter((varName) => {
            if (String(varName || '') === selfOutputVar) return true;
            const outKey = outputKeyByVar.get(String(varName || ''));
            if (!outKey) return true;
            return !selectedRefKeys.some((refKey) => isKeywordSimilar(refKey, outKey));
        });
    }
    return tasks;
}

function renderKeywordScanRows(task) {
    const keywords = Array.isArray(task.keywordScanKeywords) ? task.keywordScanKeywords.map(String) : [];
    if (keywords.length === 0) {
        return '<div style="font-size:12px;color:#666;padding:6px 0;">未填写关键词：命中周期时默认发送分析</div>';
    }
    return keywords.map((keyword, idx) => `
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
            <input class="task-keyword-scan-input w250" data-id="${task.id}" value="${h(keyword)}" placeholder="输入正文关键词">
            <button type="button" class="btn outline small task-keyword-remove" data-id="${task.id}" data-index="${idx}">删除</button>
        </div>
    `).join('');
}

function renderTaskSlots() {
    const container = $('ra_task_slots');
    if (!container) return;

    if (ui.tasks.length === 0) {
        container.innerHTML = '<div class="empty-tasks">暂无任务，点击下方"添加新任务"按钮创建</div>';
        return;
    }

    const promptOptions = promptSelectableKeys(ui.scannedKeys || []);
    const promptOptionSet = new Set(promptOptions.map((k) => String(k)));
    const refNormSet = new Set((ui.refs || []).map((ref) => normalizeKeyword(ref?.entryKey || '')).filter(Boolean));

    container.innerHTML = ui.tasks.map((task) => {
        const positions = activePositionsOf(task);
        const positionsStr = positions.join(',') || '';
        const currentPrompt = String(task.promptKey || '').trim();
        const currentAllowed = !!currentPrompt && !refNormSet.has(normalizeKeyword(currentPrompt));
        let promptOptionsHtml = '<option value="">请选择关键词（先扫描）</option>';
        if (currentAllowed && !promptOptionSet.has(currentPrompt)) {
            promptOptionsHtml += `<option value="${h(currentPrompt)}" selected>${h(currentPrompt)}（当前）</option>`;
        }
        promptOptionsHtml += promptOptions.map((k) => `<option value="${h(k)}" ${currentPrompt === k ? 'selected' : ''}>${h(k)}</option>`).join('');

        return `
        <div class="task-card ${task.enabled ? '' : 'disabled'} ${ui.expandedTasks.has(task.id) ? '' : 'collapsed'}" data-id="${task.id}">
            <div class="task-card-header">
                <button type="button" class="task-toggle-btn" data-id="${task.id}" title="展开/收起此任务的详细配置">${ui.expandedTasks.has(task.id) ? '▾' : '▸'} 配置</button>
                <label class="inline"><input type="checkbox" class="task-enabled" data-id="${task.id}" ${task.enabled ? 'checked' : ''}> 启用</label>
                <span class="task-card-title">#${task.id}</span>
                <input class="task-name w120" data-id="${task.id}" value="${h(task.displayName || '')}" placeholder="任务名称">
                <label class="inline" title="在周期的第几次AI回复时触发（支持多个，逗号分隔，如 5,10,15）">周期位置<input class="task-floor w120" data-id="${task.id}" value="${h(positionsStr)}" placeholder="5,10,15"></label>
                <button type="button" class="task-delete-btn" data-id="${task.id}">✕ 删除</button>
            </div>
            <div class="task-card-body">
                <div class="form-row">
                    <span class="form-label">提示词条目</span>
                    <span class="form-value" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                        <select class="task-prompt-select w250" data-id="${task.id}">${promptOptionsHtml}</select>
                        <button type="button" class="btn outline small task-scan-prompt" data-id="${task.id}">🔍 扫描关键词</button>
                    </span>
                </div>
                <div class="form-row">
                    <span class="form-label">输出条目</span>
                    <input class="task-output w250" data-id="${task.id}" value="${h(task.outputKey || '')}" placeholder="世界书关键词">
                </div>
                <div class="tip" style="margin-top:0;padding:6px 8px;font-size:11px;">
                    这是分析结果写入的聊天世界书条目名称，不要与"提示词条目"重复。
                </div>
                <div class="form-row" style="background:#e8f4e8;padding:8px 10px;border-radius:3px;">
                    <span class="form-label">📤 输出变量</span>
                    <code style="font-size:14px;font-weight:700;color:#1E4B8E;">{{task_${task.id}_Output}}</code>
                    <span style="font-size:12px;color:#666;margin-left:8px;">← 其他任务可用此变量引用本任务输出</span>
                </div>
                <div class="form-row">
                    <span class="form-label">额外关键词</span>
                    <input class="task-extrakeys w250" data-id="${task.id}" value="${h(task.extraKeys || '')}" placeholder="角色名等，逗号分隔">
                </div>
                <div class="form-row">
                    <span class="form-label">绑定角色</span>
                    <input class="task-characters w250" data-id="${task.id}" value="${h((task.characters || []).join(','))}" placeholder="角色名，逗号分隔；留空=全部角色">
                </div>
                <div class="form-row">
                    <span class="form-label">正文扫描</span>
                    <span class="form-value" style="display:flex;flex-direction:column;gap:8px;align-items:flex-start;">
                        <label class="inline"><input type="checkbox" class="task-keyword-scan-enabled" data-id="${task.id}" ${task.keywordScanEnabled ? 'checked' : ''}> 使用关键词扫描机制</label>
                        <div class="task-keyword-scan-wrap ${task.keywordScanEnabled ? '' : 'hidden'}" data-id="${task.id}" style="width:100%;">
                            <div class="task-keyword-scan-list" data-id="${task.id}">${renderKeywordScanRows(task)}</div>
                            <button type="button" class="btn outline small task-keyword-add" data-id="${task.id}">添加关键词</button>
                            <div class="tip" style="margin-top:6px;padding:6px 8px;font-size:11px;">
                                勾选后会在发送API前扫描正文；未填写关键词时，命中周期就照常分析；填写多个关键词时，命中任意一个才发送。
                            </div>
                        </div>
                    </span>
                </div>
                <div class="form-row">
                    <span class="form-label">输出属性</span>
                    <span class="form-value" style="display:flex;gap:12px;flex-wrap:wrap;">
                        <label class="inline"><input type="checkbox" class="task-const output-mode-radio" data-id="${task.id}" data-group="task_${task.id}" ${task.outputConstant ? 'checked' : ''}> 🔵 蓝灯</label>
                        <label class="inline"><input type="checkbox" class="task-sel output-mode-radio" data-id="${task.id}" data-group="task_${task.id}" ${task.selective ? 'checked' : ''}> 🟢 绿灯</label>
                        <label class="inline"><input type="checkbox" class="task-hide output-mode-radio" data-id="${task.id}" data-group="task_${task.id}" ${task.outputDisable ? 'checked' : ''}> ⚫ 禁用条目</label>
                        <span style="border-left:1px solid #999;padding-left:12px;margin-left:4px;">
                            <label class="inline"><input type="checkbox" class="task-no-recursion" data-id="${task.id}" ${task.noRecursion ? 'checked' : ''}> 🚫 不可递归</label>
                        </span>
                    </span>
                </div>
                <div class="tip" style="margin-top:4px;margin-bottom:8px;padding:6px 8px;font-size:11px;">
                    🔵蓝灯=始终激活 | 🟢绿灯=关键词触发 | ⚫禁用条目=不注入故事 | 🚫不可递归=禁止递归触发
                </div>
                <div class="form-row">
                    <span class="form-label">📍 插入位置</span>
                    <span class="form-value" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                        <select class="task-position w150" data-id="${task.id}">
                            <option value="0" ${(task.position ?? 0) === 0 ? 'selected' : ''}>角色设定之前</option>
                            <option value="1" ${task.position === 1 ? 'selected' : ''}>角色设定之后</option>
                            <option value="4" ${task.position === 4 ? 'selected' : ''}>深度定位 @D</option>
                        </select>
                        <span class="task-depth-wrap ${task.position === 4 ? '' : 'hidden'}" data-id="${task.id}">
                            <label class="inline">深度<input class="task-depth w100" data-id="${task.id}" type="number" min="0" max="999" value="${task.depth ?? 4}" placeholder="4"></label>
                        </span>
                        <label class="inline">顺序<input class="task-order w100" data-id="${task.id}" type="number" min="0" max="9999" value="${task.order ?? 100}" placeholder="100"></label>
                    </span>
                </div>
                <div class="form-row">
                    <span class="form-label">引用参考池</span>
                    <div class="checkbox-group task-refs" data-id="${task.id}"></div>
                </div>
                <div class="form-row">
                    <span class="form-label">引用任务输出</span>
                    <div class="checkbox-group task-outputs" data-id="${task.id}"></div>
                </div>
            </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.task-enabled').forEach((cb) => {
        on(cb, 'change', () => {
            const id = parseInt(cb.dataset.id, 10);
            const card = container.querySelector(`.task-card[data-id="${id}"]`);
            if (card) card.classList.toggle('disabled', !cb.checked);
            renderCycleInfo();
        });
    });

    container.querySelectorAll('.task-delete-btn').forEach((btn) => {
        on(btn, 'click', () => {
            const id = parseInt(btn.dataset.id, 10);
            const idx = ui.tasks.findIndex((t) => t.id === id);
            if (idx >= 0) {
                const name = ui.tasks[idx].displayName || `任务#${id}`;
                if (window.confirm(`确定删除 "${name}" 吗？`)) {
                    ui.tasks = collectTasksFromUI();
                    const delIdx = ui.tasks.findIndex((t) => t.id === id);
                    if (delIdx >= 0) ui.tasks.splice(delIdx, 1);
                    renderTaskSlots();
                    renderCycleInfo();
                    window.toastr?.info?.(`已删除 ${name}`);
                }
            }
        });
    });

    container.querySelectorAll('.task-scan-prompt').forEach((btn) => {
        on(btn, 'click', async () => {
            const id = parseInt(btn.dataset.id, 10);
            if (isNaN(id)) return;
            const sel = container.querySelector(`.task-prompt-select[data-id="${id}"]`);
            if (!sel) return;
            try {
                const oldText = btn.textContent;
                btn.disabled = true;
                btn.textContent = '扫描中...';
                const keys = await ensureScannedKeys();
                const availableKeys = promptSelectableKeys(keys);
                const task = ui.tasks.find((t) => t.id === id);
                const current = String(task?.promptKey || sel.value || '').trim();
                sel.innerHTML = '<option value="">请选择关键词...</option>' + availableKeys.map((k) => `<option value="${h(k)}">${h(k)}</option>`).join('');
                sel.value = (current && availableKeys.includes(current)) ? current : '';
                sel.disabled = availableKeys.length === 0;
                btn.textContent = oldText;
            } catch (e) {
                window.toastr?.error?.(`扫描失败: ${e.message}`);
                btn.textContent = '🔍 扫描关键词';
            } finally {
                btn.disabled = false;
            }
        });
    });

    container.querySelectorAll('.task-floor').forEach((input) => {
        on(input, 'input', renderCycleInfo);
    });
    container.querySelectorAll('.task-name').forEach((input) => {
        on(input, 'input', renderCycleInfo);
    });
    container.querySelectorAll('.task-position').forEach((sel) => {
        on(sel, 'change', () => {
            const depthWrap = container.querySelector(`.task-depth-wrap[data-id="${sel.dataset.id}"]`);
            if (depthWrap) depthWrap.classList.toggle('hidden', sel.value !== '4');
        });
    });
    container.querySelectorAll('.output-mode-radio').forEach((cb) => {
        on(cb, 'change', () => {
            if (!cb.checked) return;
            const group = cb.dataset.group;
            if (!group) return;
            container.querySelectorAll(`.output-mode-radio[data-group="${group}"]`).forEach((other) => {
                if (other !== cb) other.checked = false;
            });
        });
    });
    container.querySelectorAll('.task-keyword-scan-enabled').forEach((cb) => {
        on(cb, 'change', () => {
            const id = parseInt(cb.dataset.id, 10);
            const task = ui.tasks.find((t) => t.id === id);
            if (task) task.keywordScanEnabled = cb.checked;
            const wrap = container.querySelector(`.task-keyword-scan-wrap[data-id="${id}"]`);
            if (wrap) wrap.classList.toggle('hidden', !cb.checked);
        });
    });
    container.querySelectorAll('.task-keyword-add').forEach((btn) => {
        on(btn, 'click', () => {
            const id = parseInt(btn.dataset.id, 10);
            ui.tasks = collectTasksFromUI();
            const task = ui.tasks.find((t) => t.id === id);
            if (!task) return;
            task.keywordScanEnabled = true;
            task.keywordScanKeywords = [...(task.keywordScanKeywords || []).map(String), ''];
            renderTaskSlots();
        });
    });
    container.querySelectorAll('.task-keyword-remove').forEach((btn) => {
        on(btn, 'click', () => {
            const id = parseInt(btn.dataset.id, 10);
            const index = parseInt(btn.dataset.index, 10);
            ui.tasks = collectTasksFromUI();
            const task = ui.tasks.find((t) => t.id === id);
            if (!task || isNaN(index)) return;
            task.keywordScanKeywords = (task.keywordScanKeywords || []).filter((_, i) => i !== index);
            renderTaskSlots();
        });
    });
    container.querySelectorAll('.task-keyword-scan-input').forEach((input) => {
        on(input, 'input', () => {
            const id = parseInt(input.dataset.id, 10);
            const task = ui.tasks.find((t) => t.id === id);
            if (!task) return;
            task.keywordScanKeywords = [...container.querySelectorAll(`.task-keyword-scan-input[data-id="${id}"]`)].map((el) => el.value);
        });
    });

    updateRefCheckboxes();
}

function updateRefCheckboxes() {
    document.querySelectorAll('.task-refs').forEach((el) => {
        const id = parseInt(el.dataset.id, 10);
        const task = ui.tasks.find((t) => t.id === id);
        const used = task?.useReferences || [];
        el.innerHTML = ui.refs.map((ref) => {
            const checked = used.includes(ref.varName) ? 'checked' : '';
            return `<label><input type="checkbox" class="ref-cb" data-id="${id}" data-var="${h(ref.varName)}" ${checked}> ${h(ref.label || ref.varName)}</label>`;
        }).join('') || '<span style="color:#555;font-size:13px;">无</span>';
    });

    const outputVars = ui.tasks.map((t) => ({ varName: t.outputVarName || `task_${t.id}_Output`, label: t.displayName || `任务#${t.id}`, id: t.id }));
    document.querySelectorAll('.task-outputs').forEach((el) => {
        const currentId = parseInt(el.dataset.id, 10);
        const task = ui.tasks.find((t) => t.id === currentId);
        const used = task?.useOutputs || [];
        el.innerHTML = outputVars.map((o) => {
            const isSelf = o.id === currentId;
            const checked = used.includes(o.varName) ? 'checked' : '';
            const label = isSelf ? `${h(o.label)} (上次结果)` : h(o.label);
            const style = isSelf ? 'background:#e8f5e9;border-color:#4caf50;' : '';
            return `<label style="${style}"><input type="checkbox" class="output-cb" data-id="${currentId}" data-var="${h(o.varName)}" ${checked}> ${label}</label>`;
        }).join('') || '<span style="color:#555;font-size:13px;">无</span>';
    });
}

function renderCycleInfo() {
    const lengthBadge = $('ra_cycle_length_badge');
    const counterBadge = $('ra_cycle_counter_badge');
    const timeline = $('ra_cycle_timeline');
    const taskList = $('ra_cycle_task_list');
    if (!lengthBadge || !timeline || !taskList) return;

    const c = ctx();
    const currentCounter = c ? countAiReplies(c.chat) : 0;

    const tasksFromUI = [];
    document.querySelectorAll('.task-card[data-id]').forEach((card) => {
        const taskId = parseInt(card.dataset.id, 10);
        if (isNaN(taskId)) return;
        const enabled = !!card.querySelector(`.task-enabled[data-id="${taskId}"]`)?.checked;
        const name = card.querySelector(`.task-name[data-id="${taskId}"]`)?.value || `任务#${taskId}`;
        const positionsRaw = (card.querySelector(`.task-floor[data-id="${taskId}"]`)?.value || '')
            .split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0);
        if (enabled && positionsRaw.length > 0) {
            tasksFromUI.push({ id: taskId, name, positions: positionsRaw });
        }
    });

    if (tasksFromUI.length === 0) {
        lengthBadge.textContent = '周期长度：未配置任务';
        counterBadge.textContent = `AI回复：${currentCounter}`;
        timeline.innerHTML = `
            <div class="cycle-track"><div class="cycle-axis"></div></div>
            <div style="text-align:center;padding:16px;color:#666;position:relative;z-index:1;">请添加分析任务</div>`;
        taskList.innerHTML = '';
        return;
    }

    let maxPosition = 0;
    for (const task of tasksFromUI) {
        const taskMax = Math.max(...task.positions);
        if (taskMax > maxPosition) maxPosition = taskMax;
    }
    const currentPosition = maxPosition > 0 ? ((currentCounter % maxPosition) || maxPosition) : 0;

    lengthBadge.textContent = `周期长度：${maxPosition} 次AI回复`;
    counterBadge.textContent = `AI回复：${currentCounter} (位置${currentPosition})`;
    counterBadge.title = '当前AI回复楼层数（从聊天记录现算，无需重置）';

    const allEvents = tasksFromUI
        .map((task) => ({
            position: Math.min(...task.positions),
            positionsDisplay: task.positions.join(','),
            name: task.name,
            allPositions: task.positions,
        }))
        .sort((a, b) => a.position - b.position);

    let prevLeftPercent = -100;
    allEvents.forEach((event) => {
        const leftPercent = 10 + (event.position / maxPosition) * 80;
        const gap = leftPercent - prevLeftPercent;
        if (gap >= 20) event._level = 'l1';
        else if (gap >= 11) event._level = 'l2';
        else event._level = 'l3';
        prevLeftPercent = leftPercent;
    });
    for (let i = 1; i < allEvents.length; i++) {
        if (allEvents[i]._level === 'l3' && allEvents[i - 1]._level === 'l3' && i % 2 === 0) {
            allEvents[i]._level = 'l2';
        }
    }

    let trackHtml = '<div class="cycle-track"><div class="cycle-axis"></div>';
    allEvents.forEach((event) => {
        const leftPercent = 10 + (event.position / maxPosition) * 80;
        trackHtml += `
            <div class="cycle-marker ${event._level || 'l1'}" style="left:${leftPercent}%;">
                <span class="marker-line task"></span>
                <span class="marker-dot task"></span>
                <span class="marker-floor">位置${event.positionsDisplay}</span>
                <span class="marker-label">${h(event.name)}</span>
            </div>`;
    });
    trackHtml += `
        <div class="cycle-marker l1" style="left:96%;opacity:0.65;">
            <span class="marker-line" style="background:#8a8a8a;box-shadow:none;"></span>
            <span class="marker-dot end"></span>
            <span class="marker-floor">周期结束</span>
            <span class="marker-label" style="font-size:10px;color:#666;">🔁 回到位置1</span>
        </div>`;
    trackHtml += '</div>';
    timeline.innerHTML = trackHtml;

    let listHtml = '<div style="font-size:12px;font-weight:600;color:#666;margin-bottom:8px;">📋 任务执行顺序（按周期位置）：</div>';
    allEvents.forEach((event, i) => {
        const isCurrent = event.allPositions.includes(currentPosition);
        listHtml += `
            <div class="cycle-task-item" style="${isCurrent ? 'background:#e3f2fd;border-color:#2196f3;' : ''}">
                <span class="floor-badge" style="${isCurrent ? 'box-shadow:0 0 0 2px #2196f3;' : ''}">位置${event.positionsDisplay}</span>
                <span class="task-name">${i + 1}. ${h(event.name)}${isCurrent ? ' 👈 当前' : ''}</span>
                <span class="output-var">{{task_${event.id}_Output}}</span>
            </div>`;
    });
    listHtml += `
        <div class="cycle-task-item" style="background:#f0f0e8;border-style:dashed;">
            <span class="floor-badge" style="background:#666;">位置${maxPosition}后</span>
            <span class="task-name" style="color:#666;">🔄 新周期开始，回到位置1</span>
            <span class="output-var" style="color:#888;">周期循环</span>
        </div>`;
    taskList.innerHTML = listHtml;
}

async function saveCurrentSchemeFromUI() {
    const { data } = config.resolveConfig();
    const presets = data.presets;
    const idx = presets.findIndex((p) => p.id === ui.editingPresetId);
    if (idx < 0) return;

    const schemeName = $('ra_scheme_name_input')?.value.trim() || presets[idx].name || '未命名';
    presets[idx] = {
        ...presets[idx],
        name: schemeName,
        referencePool: ui.refs,
        tasks: collectTasksFromUI(),
        nextTaskId: ui.nextTaskId,
    };
    config.saveConfigData(data);
}

function loadSchemeToUI(presetId) {
    const { data } = config.resolveConfig();
    const preset = data.presets.find((p) => p.id === presetId);
    if (!preset) return;

    ui.editingPresetId = preset.id;
    $('ra_scheme_name_input').value = preset.name || '未命名';

    const activateBtn = $('ra_scheme_activate_btn');
    if (activateBtn) {
        const isActive = preset.id === data.activePresetId;
        activateBtn.textContent = isActive ? '✅ 已激活' : '🎯 激活';
        activateBtn.disabled = isActive;
    }
    const deleteBtn = $('ra_scheme_delete_btn');
    if (deleteBtn) deleteBtn.disabled = data.presets.length <= 1;

    ui.refs = preset.referencePool ? [...preset.referencePool] : [];
    renderRefPool();

    ui.tasks = preset.tasks ? preset.tasks.map((t) => ({ ...t })) : [];
    ui.nextTaskId = preset.nextTaskId || (ui.tasks.length > 0 ? Math.max(...ui.tasks.map((t) => t.id || 0)) + 1 : 1);
    renderTaskSlots();
    renderCycleInfo();
}

function renderSchemeTabs() {
    const container = $('ra_scheme_tabs');
    if (!container) return;
    const { data } = config.resolveConfig();
    const presets = data.presets || [];
    const activeId = data.activePresetId;

    let html = '';
    for (const preset of presets) {
        const isEditing = preset.id === ui.editingPresetId;
        const isActive = preset.id === activeId;
        html += `
            <div class="scheme-tab ${isEditing ? 'active' : ''}" data-id="${h(preset.id)}">
                <span class="scheme-name">${h(preset.name || '未命名')}</span>
                ${isActive ? '<span class="scheme-badge">当前</span>' : ''}
            </div>`;
    }
    html += '<button class="scheme-tab-add" id="ra_add_scheme_tab_btn" title="添加新方案">➕</button>';
    container.innerHTML = html;

    container.querySelectorAll('.scheme-tab').forEach((tab) => {
        on(tab, 'click', async () => {
            const presetId = tab.dataset.id;
            if (presetId === ui.editingPresetId) return;
            await saveCurrentSchemeFromUI();
            loadSchemeToUI(presetId);
            renderSchemeTabs();
        });
    });

    on($('ra_add_scheme_tab_btn'), 'click', async () => {
        await saveCurrentSchemeFromUI();
        const { data: currentData } = config.resolveConfig();
        const existingCount = currentData.presets?.length || 0;
        const chineseNumbers = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
        const newName = existingCount < 10 ? `方案${chineseNumbers[existingCount]}` : `方案${existingCount + 1}`;
        const newId = `preset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const newPreset = config.makeDefaultPreset();
        newPreset.id = newId;
        newPreset.name = newName;

        currentData.presets = [...currentData.presets, newPreset];
        config.saveConfigData(currentData);

        ui.editingPresetId = newId;
        loadSchemeToUI(newId);
        renderSchemeTabs();
        window.toastr?.success?.(`已创建新方案: ${newName}`);
    });
}

let autoSaveTimer = null;
let lastSaveTime = 0;
let uiFullyInitialized = false;
const AUTO_SAVE_DELAY = 800;
const MIN_SAVE_INTERVAL = 3000;

function triggerAutoSave() {
    if (!uiFullyInitialized) return;
    const now = Date.now();
    if (now - lastSaveTime < MIN_SAVE_INTERVAL) return;
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(async () => {
        try {
            if (!uiFullyInitialized) return;
            const taskCards = document.querySelectorAll('.task-card[data-id]');
            if (ui.tasks.length > 0 && taskCards.length === 0) return;
            await saveCurrentSchemeFromUI();
            lastSaveTime = Date.now();
        } catch (e) {
            log('auto save failed:', e);
        }
    }, AUTO_SAVE_DELAY);
}

function wireTaskControls() {
    on($('ra_add_task_area'), 'click', () => {
        if (!config.getCharacterIdentity()) {
            window.toastr?.warning?.('⚠️ 未打开角色卡：任务将暂存于全局层，不会随角色卡导出。建议打开角色卡后再配置');
        }
        ui.tasks = collectTasksFromUI();
        const newTask = config.normalizeTask({
            id: ui.nextTaskId++,
            enabled: true,
            displayName: `任务${ui.tasks.length + 1}`,
            cyclePositions: [10],
            outputVarName: `task_${ui.nextTaskId - 1}_Output`,
        });
        ui.tasks.push(newTask);
        ui.expandedTasks.add(newTask.id);
        renderTaskSlots();
        renderCycleInfo();
        requestAnimationFrame(() => {
            const card = $('ra_task_slots')?.querySelector(`.task-card[data-id="${newTask.id}"]`);
            if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
        window.toastr?.success?.(`已添加任务 #${newTask.id}（已填写的其他任务内容已保留）`);
    });

    on($('ra_tasks_save'), 'click', async () => {
        try {
            if (!config.getCharacterIdentity()) {
                window.toastr?.warning?.('⚠️ 未打开角色卡：配置保存在全局层，不会随角色卡导出');
            }
            await saveCurrentSchemeFromUI();
            config.flushCardPersistNow().catch(() => { /* flush 内部已上报错误 */ });
            window.toastr?.success?.('已保存当前方案配置');
            engine.reinit();
            refreshAll();
        } catch (e) {
            window.toastr?.error?.('保存失败: ' + e.message);
        }
    });

    on($('ra_tasks_reset'), 'click', () => {
        if (!window.confirm('确定清空所有任务吗？此操作不可恢复。')) return;
        ui.tasks = [];
        ui.nextTaskId = 1;
        renderTaskSlots();
        renderCycleInfo();
        window.toastr?.info?.('已清空所有任务');
    });

    on($('ra_scheme_name_input'), 'change', async () => {
        const newName = $('ra_scheme_name_input')?.value.trim();
        if (!newName) return;
        await saveCurrentSchemeFromUI();
        renderSchemeTabs();
    });

    on($('ra_scheme_activate_btn'), 'click', async () => {
        const { data } = config.resolveConfig();
        if (ui.editingPresetId === data.activePresetId) {
            window.toastr?.info?.('该方案已经是当前激活状态');
            return;
        }
        const preset = data.presets.find((p) => p.id === ui.editingPresetId);
        if (!window.confirm(`确定将"${preset?.name || ui.editingPresetId}"设为当前使用的方案吗？`)) return;
        withConfigData((d) => { d.activePresetId = ui.editingPresetId; });
        window.toastr?.success?.('已激活该方案');
        engine.reinit();
        renderSchemeTabs();
        loadSchemeToUI(ui.editingPresetId);
        refreshAll();
    });

    on($('ra_scheme_delete_btn'), 'click', async () => {
        const { data } = config.resolveConfig();
        if (data.presets.length <= 1) {
            window.toastr?.warning?.('至少需要保留一个方案');
            return;
        }
        const preset = data.presets.find((p) => p.id === ui.editingPresetId);
        if (!window.confirm(`确定删除方案"${preset?.name || ui.editingPresetId}"吗？此操作不可恢复。`)) return;
        await saveCurrentSchemeFromUI();
        const { data: fresh } = config.resolveConfig();
        const newPresets = fresh.presets.filter((p) => p.id !== ui.editingPresetId);
        let newActiveId = fresh.activePresetId;
        if (ui.editingPresetId === fresh.activePresetId) {
            newActiveId = newPresets[0]?.id || 'default';
        }
        fresh.presets = newPresets;
        fresh.activePresetId = newActiveId;
        config.saveConfigData(fresh);

        ui.editingPresetId = newPresets[0]?.id || 'default';
        loadSchemeToUI(ui.editingPresetId);
        renderSchemeTabs();
        window.toastr?.info?.('已删除方案');
        engine.reinit();
        refreshAll();
    });

    const schemeArea = $('ra_scheme_area');
    if (schemeArea) {
        schemeArea.addEventListener('focusout', () => triggerAutoSave());
        schemeArea.addEventListener('change', (e) => {
            if (e.target.type === 'checkbox' || e.target.tagName === 'SELECT') {
                triggerAutoSave();
            }
        });
    }
    setTimeout(() => { uiFullyInitialized = true; }, 1200);
}

function renderBindingTab(layer) {
    const statusEl = $('ra_binding_status');
    const listEl = $('ra_bound_list');
    if (!statusEl) return;

    const identity = config.getCharacterIdentity();
    if (!identity) {
        statusEl.innerHTML = '<span class="status-warn">⚠ 请先打开一个角色对话（角色卡）——RUBY 配置保存在角色卡内，未打开角色卡无法绑定</span>';
    } else {
        const { source } = config.resolveConfig();
        const bound = layer === 'character';
        const layerLabel = !bound
            ? '<span class="status-warn">全局（未绑定角色卡 ⚠️）——保存修改将自动绑定到当前角色卡，或点击下方按钮立即绑定</span>'
            : (source === 'card'
                ? '<span class="status-ok">角色卡内嵌 ✓（配置已写入角色卡 data.extensions，随卡片导出/分享）</span>'
                : '<span class="status-warn">本地旧版存储（仅存于本机 settings.json）——保存修改将自动迁移写入角色卡</span>');
        statusEl.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                <span style="font-size:22px;">${bound ? (source === 'card' ? '📇' : '🔗') : '🌍'}</span>
                <div>
                    <div style="font-weight:700;font-size:15px;">当前角色：${h(identity.name)}</div>
                    <div style="font-size:13px;margin-top:4px;">
                        配置层：<strong>${layerLabel}</strong>
                    </div>
                </div>
            </div>`;
    }

    if (listEl) {
        const boundChars = config.getBoundCharacters();
        listEl.innerHTML = boundChars.length > 0
            ? boundChars.map((c) => `<div style="padding:6px 0;border-bottom:1px dashed #ddd;">${c.source === 'card' ? '📇' : '💾'} ${h(c.name)} <span style="color:#999;font-size:12px;">(${c.source === 'card' ? '角色卡内嵌' : '本地旧版'})</span></div>`).join('')
            : '<span style="color:#666;">暂无角色绑定，所有角色使用全局配置</span>';
    }
}

function wireBindingControls() {
    on($('ra_bind_btn'), 'click', () => {
        if (!config.getCharacterIdentity()) {
            window.toastr?.warning?.('请先打开一个角色对话（角色卡）');
            return;
        }
        if (config.bindToCharacter()) {
            window.toastr?.success?.('已将当前配置写入角色卡并绑定（随卡片导出）');
            engine.reinit();
            refreshAll();
        }
    });
}

function renderPresetSummary() {
    const el = $('ra_preset_summary');
    if (!el) return;
    const { data } = config.resolveConfig();
    const presets = data.presets || [];
    const tagCount = (data.customContentTags || []).length;

    let totalTasks = 0;
    let totalRefs = 0;
    for (const preset of presets) {
        totalTasks += (preset.tasks || []).length;
        totalRefs += (preset.referencePool || []).length;
    }

    let html = `
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:12px;">
            <div>📦 配置方案：<strong>${presets.length}</strong> 个</div>
            <div>🏷️ 自定义标签：<strong>${tagCount}</strong> 个</div>
            <div>📋 任务总数：<strong>${totalTasks}</strong> 个</div>
            <div>📚 参考条目总数：<strong>${totalRefs}</strong> 个</div>
        </div>
        <div style="border-top:1px dashed #999;padding-top:12px;">
        <div style="font-weight:700;margin-bottom:8px;">📋 方案列表：</div>`;

    for (const preset of presets) {
        const isActive = preset.id === data.activePresetId;
        const taskCount = (preset.tasks || []).length;
        const enabledTasks = (preset.tasks || []).filter((t) => t.enabled).length;
        const refCount = (preset.referencePool || []).length;
        html += `
            <div style="padding:10px;margin-bottom:8px;background:${isActive ? '#e8f5e9' : '#f8f8f5'};border:1px solid ${isActive ? '#2C5530' : '#999'};border-radius:4px;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                    <span style="font-weight:700;font-size:14px;">${h(preset.name || '未命名')}</span>
                    ${isActive ? '<span style="background:#2C5530;color:#fff;padding:2px 8px;border-radius:10px;font-size:10px;">当前激活</span>' : ''}
                </div>
                <div style="font-size:12px;color:#666;">📋 ${taskCount}个任务（${enabledTasks}启用）· 📚 ${refCount}个参考条目</div>
            </div>`;
    }
    html += '</div>';
    el.innerHTML = html;
}

function generateExportData() {
    const { data } = config.resolveConfig();
    return {
        _meta: {
            type: 'RUBY_ANALYZER_PRESET',
            version: '3.0.0',
            exportTime: new Date().toISOString(),
            description: '由RUBY分析系统导出的配置模板（含多方案）',
            presetCount: (data.presets || []).length,
        },
        charName: data.charName || '',
        customContentTags: data.customContentTags || [],
        jailbreak: jailbreak.normalizeJailbreakConfig(data.jailbreak),
        gen: data.gen || {},
        activePresetId: data.activePresetId,
        presets: data.presets,
    };
}

function wirePresetIoControls() {
    on($('ra_preset_export'), 'click', () => {
        try {
            const exportData = generateExportData();
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `ruby_analyzer_config_${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            window.toastr?.success?.('配置模板已导出');
        } catch (e) {
            window.toastr?.error?.('导出失败: ' + e.message);
        }
    });

    on($('ra_preset_import'), 'click', () => {
        $('ra_preset_file_input')?.click();
    });

    on($('ra_preset_file_input'), 'change', async (e) => {
        const file = e.target?.files?.[0];
        if (!file) return;
        if (!config.getCharacterIdentity()) {
            window.toastr?.warning?.('请先打开角色卡：导入的配置将自动绑定到当前角色卡');
            e.target.value = '';
            return;
        }
        try {
            const text = await file.text();
            const raw = JSON.parse(text);
            const parsed = config.parseImportTemplate(raw);
            if (!window.confirm(`确定导入"${file.name}"吗？（来源版本 ${parsed.sourceVersion}，含 ${parsed.presetCount} 个方案、${parsed.taskCount} 个任务）导入后配置将自动绑定到当前角色卡，卡内已有方案将被覆盖。`)) return;

            withConfigData((d) => {
                d.charName = parsed.charName;
                d.customContentTags = parsed.customContentTags;
                d.jailbreak = parsed.jailbreak;
                d.gen = parsed.gen;
                d.presets = parsed.presets;
                d.activePresetId = parsed.activePresetId;
            });
            config.flushCardPersistNow().catch(() => { /* flush 内部已上报错误 */ });

            ui.importedTemplateName = file.name;
            $('ra_template_info').innerHTML = `
                <div style="font-weight:700;margin-bottom:6px;">📄 ${h(file.name)}</div>
                <div style="font-size:12px;color:#666;">
                    来源版本：${h(parsed.sourceVersion)} · 导出时间：${h(parsed.sourceTime || '未知')}<br>
                    已导入：${parsed.presetCount} 个方案 · ${parsed.taskCount} 个任务
                </div>`;
            window.toastr?.success?.(`配置模板已导入（${parsed.presetCount} 个方案、${parsed.taskCount} 个任务）`);
            engine.reinit();
            refreshAll();
        } catch (err) {
            window.toastr?.error?.('导入失败: ' + err.message);
        } finally {
            e.target.value = '';
        }
    });

    on($('ra_preset_validate'), 'click', async () => {
        const resultEl = $('ra_validate_result');
        if (!resultEl) return;
        try {
            const { data } = config.resolveConfig();
            const preset = config.getActivePreset(data);
            const entries = [];
            for (const ref of preset.referencePool || []) {
                if (ref.entryKey) entries.push({ key: ref.entryKey, label: ref.label || ref.varName, type: '参考' });
            }
            for (const task of preset.tasks || []) {
                if (task.promptKey) entries.push({ key: task.promptKey, label: `${task.displayName || `任务#${task.id}`}提示词`, type: '提示词' });
                if (task.outputKey) entries.push({ key: task.outputKey, label: `${task.displayName || `任务#${task.id}`}输出`, type: '输出' });
            }

            if (entries.length === 0) {
                resultEl.style.display = 'block';
                resultEl.innerHTML = '<span class="status-warn">当前方案没有配置任何条目依赖</span>';
                return;
            }

            const charBook = await worldbook.getCharBookName();
            const chatBook = await worldbook.getChatBookName();
            if (!charBook) {
                resultEl.style.display = 'block';
                resultEl.innerHTML = '<span class="status-err">未找到角色世界书</span>';
                return;
            }

            const lines = [];
            for (const e of entries) {
                let found = false;
                try {
                    found = await worldbook.entryExists(charBook, e.key);
                    if (!found && chatBook) found = await worldbook.entryExists(chatBook, e.key);
                } catch { /* treat as missing */ }
                const isOutput = e.type === '输出';
                const cls = found ? 'status-ok' : (isOutput ? 'status-warn' : 'status-err');
                const mark = found ? '✓' : (isOutput ? '⚠（将在分析时自动创建）' : '✕ 缺失');
                lines.push(`<span class="${cls}">${mark} [${e.type}] ${h(e.label)}</span>`);
            }
            resultEl.style.display = 'block';
            resultEl.innerHTML = lines.join('<br>');
        } catch (err) {
            resultEl.style.display = 'block';
            resultEl.innerHTML = `<span class="status-err">校验失败：${h(err.message)}</span>`;
        }
    });
}
