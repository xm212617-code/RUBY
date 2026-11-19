import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { prepareAgentMarkdown, renderAgentMarkdown, agentMessageSource } from '../src/agent-render.js';

const markdown = '# 标题\n\n一段 **重点**。\n第二行。\n\n- 第一项\n- 第二项\n\n| 字段 | 值 |\n| --- | --- |\n| 名称 | Ruby |\n\n```html\n<style>body{display:none}</style>\n<script>alert(1)</script>\n<div>源代码</div>\n```';

test('Markdown fences, paragraphs, list markers and tables survive preprocessing', () => {
    assert.equal(prepareAgentMarkdown(markdown), markdown);
    assert.equal(prepareAgentMarkdown('说明 <b>原样显示</b>，`<b>代码</b>`'), '说明 &lt;b&gt;原样显示&lt;/b&gt;，`<b>代码</b>`');
    assert.equal(prepareAgentMarkdown('~~~html\n<script>x</script>\n~~~'), '~~~html\n<script>x</script>\n~~~');
});

test('missing Markdown libraries fall back to line-preserving escaped text', () => {
    const html = renderAgentMarkdown(markdown, {});
    assert.match(html, /pre class="ruby-agent-plain"/);
    assert.match(html, /第一项\n- 第二项/);
    assert.doesNotMatch(html, /<script>|<style>/);
});

test('old escaping is decoded once and exact new source takes precedence', () => {
    assert.equal(agentMessageSource({ mes: '&#96;&#96;&#96;html\n&lt;div&gt;&amp;lt;\n&#96;&#96;&#96;' }), '```html\n<div>&lt;\n```');
    assert.equal(agentMessageSource({ mes: '<div>Rendered</div>', extra: { ruby_agent_source: markdown } }), markdown);
});

test('renderer requests table, fenced code and line-break support, followed by sanitization', () => {
    let options, passed, sanitized;
    const html = renderAgentMarkdown(markdown, {
        showdown: { Converter: class { constructor(input) { options = input; } makeHtml(text) { passed = text; return '<p>Converted</p>'; } } },
        DOMPurify: { sanitize(text, config) { sanitized = config; return text; } },
    });
    assert.equal(options.tables, true); assert.equal(options.ghCodeBlocks, true); assert.equal(options.simpleLineBreaks, true);
    assert.equal(passed, markdown); assert.ok(sanitized.FORBID_TAGS.includes('iframe'));
    assert.equal(html, '<div class="ruby-agent-prose"><p>Converted</p></div>');
});

test('real Showdown and DOMPurify render readable rich text while leaving delivered HTML inert', { skip: !process.env.RUBY_RENDER_TEST_ROOT }, () => {
    const require = createRequire(process.env.RUBY_RENDER_TEST_ROOT + '/package.json');
    const showdown = require('showdown');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('');
    const DOMPurify = require('dompurify')(dom.window);
    const html = renderAgentMarkdown(markdown + '\n\n<iframe src="evil"></iframe>\n\n[bad](javascript:alert(1))', { showdown, DOMPurify });
    const body = dom.window.document.createElement('div'); body.innerHTML = html;
    assert.equal(body.querySelector('h1').textContent, '标题');
    assert.equal(body.querySelector('strong').textContent, '重点');
    assert.equal(body.querySelectorAll('li').length, 2);
    assert.equal(body.querySelector('table tbody td').textContent, '名称');
    assert.match(body.querySelector('pre code').textContent, /<script>alert\(1\)<\/script>/);
    assert.match(body.querySelector('p').innerHTML, /<br/);
    assert.equal(body.querySelectorAll('script,style,iframe').length, 0);
    assert.equal(body.querySelector('a').hasAttribute('href'), false);
    dom.window.close();
});
