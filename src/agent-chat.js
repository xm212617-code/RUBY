import { ctx } from './env.js';
import { agentController } from './agent-controller.js';
import { isAgentMode } from './agent-mode.js';

export function agentKeyAction(event, { composer = false, inputFocus = composer, popup = false, editing = false, sendOnEnter = false, hasText = false } = {}) {
    if (popup) return null;
    if (['ArrowLeft', 'ArrowRight'].includes(event.key) && !inputFocus && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && !hasText) return 'blocked';
    if (event.key !== 'Enter') return null;
    if (event.isComposing || event.keyCode === 229) return event.ctrlKey || event.altKey ? 'composition' : null;
    if (event.ctrlKey && editing) return null;
    if (event.altKey) return 'blocked';
    if (event.ctrlKey) return composer && hasText && sendOnEnter ? 'send' : 'blocked';
    if (composer && !event.shiftKey && sendOnEnter) return 'send';
    return null;
}

export function installAgentChat({ document: doc = globalThis.document, getContext = ctx, controller = agentController, notify = (text) => globalThis.window?.toastr?.warning?.(text) } = {}) {
    if (!doc) return () => {};
    const submitDraft = () => {
        const textarea = doc.querySelector('#send_textarea');
        if (!textarea) return;
        const c = getContext();
        const text = textarea.value;
        if (controller.getState().running) { notify('Agent正在工作，当前输入已保留；请先停止或等待完成'); return; }
        if (c?.is_send_press || c?.isGenerating?.() || c?.streamingProcessor && !c.streamingProcessor.isFinished) {
            notify('酒馆仍在生成，请先停止原生成再发送Agent任务'); return;
        }
        if (!text.trim()) { notify('Agent模式不自动续写，请输入需求'); return; }
        // Slash text is intentionally treated as an Agent instruction, never evaluated by STscript.
        textarea.value = '';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        controller.submit(text).catch((error) => {
            if (!textarea.value) { textarea.value = text; textarea.dispatchEvent(new Event('input', { bubbles: true })); }
            notify(error.message);
        });
    };
    const onClick = (event) => {
        if (!isAgentMode(getContext())) return;
        const target = event.target?.closest?.('#send_but, #mes_stop, #option_regenerate, #option_continue, #mes_continue, #option_impersonate, #mes_impersonate, .swipe_left, .swipe_right');
        if (!target) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (target.id === 'send_but') submitDraft();
        else if (target.id === 'mes_stop') controller.stop();
        else notify('Agent模式不执行角色重生成、续写或切换回复；请在聊天框继续提出修改要求');
    };
    const onKey = (event) => {
        if (!isAgentMode(getContext())) return;
        const c = getContext();
        const popup = Boolean(c?.Popup?.util?.isPopupOpen?.() || doc.querySelector('dialog[open], .popup[open], .popup:not([hidden]).show'));
        const textarea = doc.querySelector('#send_textarea');
        const editing = [...doc.querySelectorAll('.mes_edit_done, .mes_reasoning_edit_done')].some((el) => el.getClientRects().length);
        const inputFocus = Boolean(event.target?.matches?.('input, textarea, select') || event.target?.isContentEditable || event.target === textarea);
        const action = agentKeyAction(event, { composer: event.target === textarea, inputFocus, popup, editing,
            sendOnEnter: c?.shouldSendOnEnter?.() === true, hasText: Boolean(textarea?.value) });
        if (!action) return;
        event.stopImmediatePropagation();
        if (action === 'composition') return;
        event.preventDefault();
        if (action === 'send') submitDraft();
        else notify('Agent模式请在聊天框发送需求，或用停止按钮中止当前任务');
    };
    const updateBadge = () => {
        const textarea = doc.querySelector('#send_textarea');
        if (!textarea?.parentElement) return;
        let badge = doc.getElementById('ruby-agent-composer-badge');
        if (!badge) {
            badge = doc.createElement('div'); badge.id = 'ruby-agent-composer-badge';
            badge.setAttribute('role', 'status');
            textarea.parentElement.insertBefore(badge, textarea);
        }
        const state = controller.getState();
        badge.hidden = state.mode !== 'agent';
        badge.textContent = state.running ? `RUBY Agent：${state.phase} · 新输入会保留，完成或停止后发送` : 'RUBY Agent 写卡接管中 · 直接在此输入需求并发送';
    };
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('keydown', onKey, true);
    const unsubscribe = controller.onStateChange(updateBadge);
    updateBadge();
    // Official interceptor catches programmatic Generate paths that bypass DOM capture.
    const interceptor = (_chat, _size, abort) => { if (isAgentMode(getContext())) abort(true); };
    globalThis.rubyAgentGenerationInterceptor = interceptor;
    return () => {
        doc.removeEventListener('click', onClick, true); doc.removeEventListener('keydown', onKey, true);
        unsubscribe(); doc.getElementById('ruby-agent-composer-badge')?.remove();
        if (globalThis.rubyAgentGenerationInterceptor === interceptor) delete globalThis.rubyAgentGenerationInterceptor;
    };
}
