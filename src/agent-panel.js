import { h } from './env.js';
import { getKnowledgeIndex } from './agent-knowledge.js';

const DEFAULT_SETTINGS = {
    connection: 'ruby',
    url: '',
    key: '',
    model: '',
    rpm: 10,
    minIntervalMs: 1000,
    maxRequests: 30,
    maxMinutes: 15,
    maxTokens: 100000,
    contextChars: 240000,
    temperature: 0.6,
    retries: 2,
};

const SETTINGS_FIELDS = [
    { key: 'url', label: 'API 地址', type: 'url', placeholder: 'https://...' },
    { key: 'key', label: 'API 密钥', type: 'password', autocomplete: 'new-password' },
    { key: 'model', label: '模型', type: 'text', placeholder: '模型名称' },
    { key: 'rpm', label: '每分钟请求数', type: 'number', min: 1, step: 1 },
    { key: 'minIntervalMs', label: '最小请求间隔 (ms)', type: 'number', min: 0, step: 100 },
    { key: 'maxRequests', label: '最大请求数', type: 'number', min: 1, step: 1 },
    { key: 'maxMinutes', label: '最长运行时间 (分钟)', type: 'number', min: 1, step: 1 },
    { key: 'maxTokens', label: '最大输出 tokens', type: 'number', min: 256, max: 100000, step: 1 },
    { key: 'contextChars', label: '自动整理阈值（字符，0=关闭主动整理）', type: 'number', min: 0, step: 10000 },
    { key: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 2, step: 0.1 },
    { key: 'retries', label: '重试次数', type: 'number', min: 0, step: 1 },
];

const mountedRoots = new WeakMap();

function asText(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try { return JSON.stringify(value); } catch { return String(value); }
}

function redact(value, secrets) {
    let text = asText(value);
    for (const secret of secrets) {
        if (secret) text = text.split(secret).join('[已隐藏]');
    }
    return text;
}

function currentSecrets(root, settings) {
    const inputKey = root.querySelector('[data-agent-setting="key"]')?.value;
    return [settings?.key, inputKey].filter((value) => typeof value === 'string' && value.length > 0);
}

function formatTime(value) {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? asText(value) : date.toLocaleTimeString();
}

function settingsMarkup(settings) {
    const values = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    const connection = ['ruby', 'main', 'custom'].includes(values.connection) ? values.connection : 'ruby';
    const connectionOptions = [
        ['ruby', 'RUBY 配置'],
        ['main', '主 API 配置'],
        ['custom', '自定义'],
    ].map(([value, label]) => `<option value="${value}"${connection === value ? ' selected' : ''}>${label}</option>`).join('');
    const fields = SETTINGS_FIELDS.map((field) => {
        const attributes = [
            `type="${field.type}"`,
            `data-agent-setting="${field.key}"`,
            `value="${h(values[field.key])}"`,
            field.min != null ? `min="${field.min}"` : '',
            field.max != null ? `max="${field.max}"` : '',
            field.step != null ? `step="${field.step}"` : '',
            field.placeholder ? `placeholder="${h(field.placeholder)}"` : '',
            field.autocomplete ? `autocomplete="${field.autocomplete}"` : '',
            field.key === 'key' ? 'spellcheck="false"' : '',
        ].filter(Boolean).join(' ');
        return `<label class="agent-field"><span>${h(field.label)}</span><input ${attributes}></label>`;
    }).join('');

    return `
        <details class="agent-settings">
            <summary>API 与限流设置 <span class="agent-save-status" data-agent-save-status aria-live="polite"></span></summary>
            <div class="agent-settings-grid">
                <label class="agent-field"><span>配置来源</span><select data-agent-setting="connection">${connectionOptions}</select></label>
                ${fields}
            </div>
            <p class="agent-settings-note">自动整理阈值按请求消息JSON的字符数计算，不是token数，也不是输入硬上限；可自行提高或设0。设0后不主动整理，仅在API明确报告上下文超长时尝试整理恢复。它与“最大输出tokens”独立，不能扩大模型实际上下文窗口。</p>
            <p class="agent-settings-note">地址、密钥和模型仅在“自定义”连接时使用；其他选项继承已配置的连接。Google Gemini 4 使用官方 OpenAI 兼容地址时，Agent 自动设 medium 推理并至少保留 16k 输出空间，避免思考 token 挤掉工具调用。长会话会自动整理工作摘要并继续，旧原文保存在当前聊天元数据，可由Agent分页查回；整理请求同样计入RPM和请求预算。清除上下文会一并删除这些历史归档，不改变世界书。密钥只保存在本地扩展设置，不写入角色卡或Agent对话。设置修改后自动保存。</p>
        </details>`;
}

function shellMarkup(settings) {
    return `
    <section class="ra-agent-panel" data-agent-controls aria-label="Agent 控制面板">
        <header class="agent-heading">
            <div>
                <div class="agent-eyebrow">执行模式</div>
                <h2>Agent</h2>
            </div>
            <span class="agent-status" data-agent-status aria-live="polite">待机</span>
        </header>

        <div class="agent-mode-switch" role="group" aria-label="Agent 执行模式">
            <button type="button" data-agent-mode="steps" aria-pressed="false">步骤写卡</button>
            <button type="button" data-agent-mode="agent" aria-pressed="false">Agent 写卡</button>
        </div>

        <p class="agent-run-note">在酒馆聊天框输入并发送任务；切换模式即启用。Agent可修改当前主世界书、已选全局书、聊天世界书，以及当前角色的局部正则和RUBY配置。所有变更直接保存，执行过程与差异见下方日志。外部扩展的自动生成不由聊天输入接管，请勿同时运行。</p>

        <div class="agent-actions">
            <button type="button" class="agent-button agent-button-stop" data-agent-action="stop">停止</button>
            <button type="button" class="agent-button" data-agent-action="reset">清除 Agent 上下文</button>
            <button type="button" class="agent-button" data-agent-action="refresh">刷新范围</button>
        </div>

        <div class="agent-metrics" aria-label="Agent 运行统计">
            <div><span>阶段</span><strong data-agent-phase>待机</strong></div>
            <div><span>请求</span><strong data-agent-requests>0</strong></div>
            <div><span>工具调用</span><strong data-agent-tools>0</strong></div>
            <div><span>Token 用量</span><strong data-agent-usage>0 / 0</strong></div>
            <div><span>等待至</span><strong data-agent-wait>—</strong></div>
        </div>

        <div class="agent-error" data-agent-error role="alert" hidden></div>
        <div class="agent-feedback" data-agent-feedback aria-live="polite"></div>
        <div class="agent-feedback" data-agent-artifacts></div>

        <section class="agent-scope-section" aria-labelledby="agent-scope-title">
            <div class="agent-section-heading">
                <h3 id="agent-scope-title">当前范围</h3>
                <span>主 / 全局 / 聊天与当前角色</span>
            </div>
            <ul class="agent-scope-list" data-agent-scope></ul>
        </section>

        ${settingsMarkup(settings)}
        <details class="agent-settings"><summary>知识与写作流程</summary>
            <p class="agent-settings-note">分段写作：P0对齐 → P1–P5逐段写、逐项检查 → F终检 → 配套件与组卡。Agent按需读取知识；状态栏提供正文捕获、RUBY活数据和内置脚本视图三种接法。工作素材保存在允许世界书的关闭条目中。</p>
            <ul class="agent-scope-list">${getKnowledgeIndex().map((item) => `<li><strong>${h(item.title)}</strong><span>${h(item.summary)}</span></li>`).join('')}</ul>
        </details>

        <section class="agent-log-section" aria-labelledby="agent-log-title">
            <div class="agent-section-heading">
                <h3 id="agent-log-title">操作日志</h3>
                <span data-agent-log-count>0 / 80</span>
            </div>
            <ol class="agent-log-list" data-agent-logs></ol>
        </section>
    </section>`;
}

function getControls(root) {
    return root.matches?.('[data-agent-controls]') ? root : root.querySelector('[data-agent-controls]');
}

function setText(root, selector, value) {
    const element = root.querySelector(selector);
    if (element) element.textContent = value;
}

function renderScope(root, scope, secrets) {
    const list = root.querySelector('[data-agent-scope]');
    if (!list) return;
    const entries = Array.isArray(scope) ? scope : [];
    if (entries.length === 0) {
        list.innerHTML = '<li class="agent-scope-empty">尚未发现可用范围</li>';
        return;
    }
    list.innerHTML = entries.map((entry) => {
        const sources = Array.isArray(entry?.sources) ? entry.sources.map((source) => redact(source, secrets)).join(' · ') : redact(entry?.sources, secrets);
        return `<li><strong>${h(redact(entry?.name || entry?.id || '未命名范围', secrets))}</strong>${sources ? `<span>${h(sources)}</span>` : ''}</li>`;
    }).join('');
}

function renderLogs(root, logs, secrets) {
    const list = root.querySelector('[data-agent-logs]');
    const count = root.querySelector('[data-agent-log-count]');
    if (!list) return;
    const entries = Array.isArray(logs) ? logs.slice(-80) : [];
    if (count) count.textContent = `${entries.length} / 80`;
    if (entries.length === 0) {
        list.innerHTML = '<li class="agent-log-empty">暂无操作记录</li>';
        return;
    }
    list.innerHTML = entries.map((entry) => {
        const details = entry?.data == null ? '' : (() => {
            let json;
            try { json = JSON.stringify(entry.data, null, 2); } catch { json = asText(entry.data); }
            return `<details><summary>详情</summary><pre>${h(redact(json, secrets))}</pre></details>`;
        })();
        return `<li class="agent-log-entry"><div class="agent-log-meta"><time>${h(formatTime(entry?.at))}</time><span>${h(redact(entry?.kind || 'event', secrets))}</span></div><div class="agent-log-text">${h(redact(entry?.text, secrets))}</div>${details}</li>`;
    }).join('');
}

export function updateAgentControls(root, state = {}) {
    const controls = getControls(root);
    if (!controls) return;
    const settings = { ...DEFAULT_SETTINGS, ...((root.__agentSettings) || {}) };
    const secrets = currentSecrets(controls, settings);
    const mode = state.mode === 'agent' ? 'agent' : 'steps';

    controls.querySelectorAll('[data-agent-mode]').forEach((button) => {
        const selected = button.dataset.agentMode === mode;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
        button.disabled = Boolean(state.running || state.switching);
    });
    controls.querySelectorAll('[data-agent-setting]').forEach((input) => {
        input.disabled = Boolean(state.running || state.switching || (['url', 'key', 'model'].includes(input.dataset.agentSetting) && settings.connection !== 'custom'));
    });
    controls.querySelectorAll('[data-agent-action]').forEach((button) => {
        button.disabled = button.dataset.agentAction === 'stop' ? !state.running : Boolean(state.running || state.switching);
    });
    const status = state.error ? '异常' : state.running ? '运行中' : '待机';
    const statusElement = controls.querySelector('[data-agent-status]');
    if (statusElement) {
        statusElement.textContent = status;
        statusElement.dataset.state = state.error ? 'error' : state.running ? 'running' : 'idle';
    }
    setText(controls, '[data-agent-phase]', redact(state.phase || '待机', secrets));
    setText(controls, '[data-agent-requests]', asText(state.requestCount ?? 0));
    setText(controls, '[data-agent-tools]', asText(state.toolCount ?? 0));
    setText(controls, '[data-agent-usage]', `${asText(state.usage?.prompt_tokens ?? 0)} / ${asText(state.usage?.completion_tokens ?? 0)}`);
    setText(controls, '[data-agent-wait]', formatTime(state.waitUntil));

    const error = controls.querySelector('[data-agent-error]');
    if (error) {
        error.textContent = redact(state.error || '', secrets);
        error.hidden = !state.error;
    }
    renderScope(controls, state.scope, secrets);
    renderLogs(controls, state.logs, secrets);
    const artifacts = controls.querySelector('[data-agent-artifacts]');
    if (artifacts) artifacts.innerHTML = (state.artifacts || []).filter((item) => typeof item.url === 'string' && item.url.startsWith('blob:'))
        .map((item) => `<a href="${h(item.url)}" download="${h(item.fileName)}">下载 ${h(item.fileName)}</a>`).join('<br>');
}

function feedback(root, message, kind = '') {
    const element = root.querySelector('[data-agent-feedback]');
    if (!element) return;
    element.textContent = message;
    element.dataset.kind = kind;
}

function settingValue(input) {
    if (input.type !== 'number') return input.value;
    const value = input.valueAsNumber;
    return Number.isFinite(value) ? value : null;
}

function bindControls(root, controller, settings) {
    let actionPending = false;

    const onClick = async (event) => {
        const modeButton = event.target.closest?.('[data-agent-mode]');
        if (modeButton && root.contains(modeButton)) {
            const nextMode = modeButton.dataset.agentMode;
            if (nextMode !== 'steps' && nextMode !== 'agent') return;
            feedback(root, '正在切换模式…');
            try {
                await controller.setMode(nextMode);
                updateAgentControls(root, controller.getState());
                feedback(root, nextMode === 'agent' ? 'Agent 模式已启用' : '步骤写卡模式已启用', 'success');
            } catch (error) {
                feedback(root, `模式切换失败：${asText(error?.message || error)}`, 'error');
            }
            return;
        }

        const button = event.target.closest?.('[data-agent-action]');
        if (!button || !root.contains(button) || actionPending) return;
        const action = button.dataset.agentAction;
        const actions = {
            stop: ['正在停止…', () => controller.stop(), '已请求停止，已完成的修改会保留'],
            reset: ['正在清除 Agent 上下文…', () => controller.resetConversation(), 'Agent 上下文已清除'],
            refresh: ['正在刷新范围…', () => controller.refreshScope(), '范围已刷新'],
        };
        const selected = actions[action];
        if (!selected) return;
        actionPending = true;
        button.disabled = true;
        feedback(root, selected[0]);
        try {
            await selected[1]();
            updateAgentControls(root, controller.getState());
            feedback(root, selected[2], 'success');
        } catch (error) {
            feedback(root, `操作失败：${asText(error?.message || error)}`, 'error');
        } finally {
            actionPending = false;
            if (button.isConnected) button.disabled = false;
        }
    };

    const onChange = async (event) => {
        const input = event.target.closest?.('[data-agent-setting]');
        if (!input || !root.contains(input)) return;
        const key = input.dataset.agentSetting;
        const value = settingValue(input);
        if (value == null || (key === 'connection' && !['ruby', 'main', 'custom'].includes(value))) {
            const status = root.querySelector('[data-agent-save-status]');
            if (status) status.textContent = '请输入有效值';
            return;
        }
        const status = root.querySelector('[data-agent-save-status]');
        if (status) status.textContent = '保存中…';
        try {
            const saved = await controller.saveSettings({ [key]: value });
            Object.assign(settings, saved || { [key]: value });
            input.value = String(settings[key]);
            root.__agentSettings = { ...settings };
            updateAgentControls(root, controller.getState());
            if (status) status.textContent = '已保存';
        } catch (error) {
            input.value = String(settings[key] ?? '');
            updateAgentControls(root, controller.getState());
            if (status) status.textContent = `保存失败：${asText(error?.message || error)}`;
        }
    };

    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    return () => {
        root.removeEventListener('click', onClick);
        root.removeEventListener('change', onChange);
    };
}

export function renderAgentControls(root, controller) {
    if (!root || !controller) throw new TypeError('renderAgentControls requires a root element and controller');
    const existing = mountedRoots.get(root);
    if (existing?.controller === controller) return existing.cleanup;
    if (existing) existing.cleanup();

    const settings = { ...DEFAULT_SETTINGS, ...(controller.getSettings?.() || {}) };
    root.__agentSettings = settings;
    root.innerHTML = shellMarkup(settings);
    const unbind = bindControls(root, controller, settings);
    let unsubscribe = () => {};
    if (typeof controller.onStateChange === 'function') {
        unsubscribe = controller.onStateChange((state) => updateAgentControls(root, state)) || (() => {});
    }
    const cleanup = () => {
        unbind();
        unsubscribe();
        mountedRoots.delete(root);
    };
    mountedRoots.set(root, { controller, cleanup });
    updateAgentControls(root, controller.getState?.() || {});
    return cleanup;
}
