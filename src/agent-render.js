const escapeHtml = (text) => String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Preserve Markdown syntax while treating raw HTML outside code as literal text. */
export function prepareAgentMarkdown(text) {
    let fence = null;
    return String(text).split('\n').map((line) => {
        const mark = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (fence) {
            if (new RegExp(`^ {0,3}${fence.char}{${fence.length},}[ \\t]*$`).test(line)) fence = null;
            return line;
        }
        if (mark) { fence = { char: mark[1][0], length: mark[1].length }; return line; }
        return line.split(/(`+[^`\n]*`+)/g).map((part) => /^(`+)[\s\S]*\1$/.test(part) ? part : escapeHtml(part)).join('');
    }).join('\n');
}

export function renderAgentMarkdown(text, libraries = globalThis.window) {
    const showdown = libraries?.showdown;
    const purifier = libraries?.DOMPurify;
    if (!showdown?.Converter || !purifier?.sanitize) return `<div class="ruby-agent-prose"><pre class="ruby-agent-plain">${escapeHtml(text)}</pre></div>`;
    const converter = new showdown.Converter({ tables: true, ghCodeBlocks: true, simpleLineBreaks: true,
        strikethrough: true, tasklists: true, literalMidWordUnderscores: true, noHeaderId: true });
    const html = converter.makeHtml(prepareAgentMarkdown(text));
    const clean = purifier.sanitize(html, { USE_PROFILES: { html: true },
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'img', 'video', 'audio'],
        FORBID_ATTR: ['style', 'srcdoc'], ALLOW_DATA_ATTR: false });
    return `<div class="ruby-agent-prose">${clean}</div>`;
}

export function agentMessageSource(message) {
    if (typeof message.extra?.ruby_agent_source === 'string') return message.extra.ruby_agent_source;
    // Recover messages written before Markdown support; decode exactly one escaping layer.
    return String(message.mes || '').replace(/&#96;|&lt;|&gt;|&amp;/g, (entity) => ({ '&#96;': '`', '&lt;': '<', '&gt;': '>', '&amp;': '&' }[entity]));
}
