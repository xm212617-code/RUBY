import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { AGENT_SYSTEM_GUIDE, getKnowledgeIndex, readKnowledge } from '../src/agent-knowledge.js';
import { buildSexCombatRegexScripts } from '../src/scripts/sex-combat.js';

const index = getKnowledgeIndex();
const ids = index.map(({ id }) => id);
assert.equal(new Set(ids).size, ids.length);
for (const id of ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'f', 'n', 's', 'c']) {
    assert.ok(ids.includes(`check-${id}`));
}
assert.match(AGENT_SYSTEM_GUIDE, /Step1.*不是流水线 P1/);
assert.match(AGENT_SYSTEM_GUIDE, /已授权世界书.*关闭条目/);
assert.equal(readKnowledge('missing'), null);
assert.equal(readKnowledge('__proto__'), null);
assert.throws(() => readKnowledge('pipeline', { limit: 0 }), RangeError);
assert.throws(() => readKnowledge('pipeline', { offset: -1 }), RangeError);

for (const { id, title, summary, chars } of index) {
    assert.ok(title && summary && chars);
    const full = readKnowledge(id, { limit: Number.MAX_SAFE_INTEGER });
    let content = '';
    let offset = 0;
    do {
        const page = readKnowledge(id, { offset, limit: 677 });
        assert.deepEqual([page.id, page.title, page.total], [id, title, chars]);
        assert.ok(page.content.length <= 677);
        content += page.content;
        offset = page.nextOffset;
        assert.ok(offset === null || offset === content.length);
    } while (offset !== null);
    assert.equal(content, full.content);
    assert.equal(content.length, chars);
    assert.deepEqual(readKnowledge(id, { offset: chars + 1 }), { id, title, content: '', total: chars, nextOffset: null });
}
const defaultPage = readKnowledge('writing');
assert.equal(defaultPage.content.length, Math.min(12000, defaultPage.total));
assert.equal(defaultPage.nextOffset, defaultPage.total > 12000 ? 12000 : null);
index[0].title = 'mutated';
assert.notEqual(getKnowledgeIndex()[0].title, 'mutated');

const dataUrl = new URL('../src/agent-knowledge-data.js', import.meta.url);
const bundled = readFileSync(dataUrl, 'utf8');
assert.ok(Buffer.byteLength(bundled) < 250_000);
assert.doesNotMatch(bundled, /[A-Z]:[\\/]|\.codex-section|data-ruby-sex-combat=\\?"true[^\n]*替换内容\.html/);
assert.match(readKnowledge('profile-template').content, /# profile 模板/);
assert.match(readKnowledge('check-f').content, /GF-PASS/);

function example(id) {
    const { content } = readKnowledge(id, { limit: Number.MAX_SAFE_INTEGER });
    const extract = content.match(/\n```json\n([\s\S]*?)\n```$/);
    assert.ok(extract, `${id} must provide importable JSON metadata`);
    return JSON.parse(extract[1]);
}

function applyExample(rule, text) {
    const [, pattern, flags] = rule.findRegex.match(/^\/([\s\S]*)\/([a-z]*)$/);
    assert.deepEqual(rule.trimStrings, []);
    // Mirror host group expansion for the examples; this fixture has no host macros.
    return text.replace(new RegExp(pattern, flags), (...groups) => rule.replaceString
        .replace(/{{match}}/gi, '$0')
        .replace(/\$(\d+)|\$<([^>]+)>/g, (_, number, name) => (number ? groups[Number(number)] : groups.at(-1)?.[name]) || ''));
}

function checkDisplay(rule) {
    assert.deepEqual(rule.placement, [2]);
    assert.deepEqual([rule.markdownOnly, rule.promptOnly, rule.runOnEdit, rule.disabled, rule.substituteRegex], [true, false, true, false, 0]);
    assert.match(rule.replaceString, /^```html\n<!doctype html>[\s\S]*<\/html>\n```$/);
}

const snapshot = example('panel-snapshot');
checkDisplay(snapshot);
assert.match(applyExample(snapshot, '<SceneInfo>北门岗亭 - 2</SceneInfo>'), /地点 · 北门岗亭 - 2<\/p>/);
for (const payload of ['<img>', '${document.title}', '`', '</script>', '{{user}}', '&lt;', '\"', 'a\nb', 'a'.repeat(81)]) {
    const message = `<SceneInfo>${payload}</SceneInfo>`;
    assert.equal(applyExample(snapshot, message), message);
}

const live = example('panel-ruby-live');
checkDisplay(live);
const liveHtml = applyExample(live, '【RUBY实时状态】');
const liveScript = liveHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
new Script(liveScript); // Parse the fixture; do not execute panel code.
assert.equal(liveHtml, live.replaceString);
assert.match(liveScript, /function detectAdapter\(\)[\s\S]*宿主未提供斜杠执行适配器/);
assert.match(liveScript, /rec\?\.uid != null/);
assert.match(liveScript, /strict=true json=true read/);
assert.match(liveScript, /\/ruby task=demo-status json=true run/);
assert.match(liveScript, /task\.ok && task\.outputKey/);
assert.doesNotMatch(liveScript, /innerHTML|\/ruby (?:read|run) /);

const sexCombat = example('panel-sex-combat');
assert.deepEqual(sexCombat, buildSexCombatRegexScripts([], { enabled: true }));
const [prompt, display, hidden] = sexCombat;
assert.equal(prompt.promptOnly, true);
assert.equal(applyExample(prompt, '</xingdou>'), '');
checkDisplay(display);
assert.equal(applyExample(hidden, '<report>已结束</report>'), '');
const sexHtml = applyExample(display, '</xingdou>');
assert.match(sexHtml, /data-ruby-sex-combat="true"/);
const sexScript = sexHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
new Script(sexScript);
assert.match(sexScript, /ruby-sex-combat-view-request/);
assert.match(sexScript, /ruby-sex-combat-view-state/);
assert.doesNotMatch(sexScript, /\/ruby |registerCardScript/);

console.log(`agent knowledge: ${ids.length} entries, pagination and three offline panel fixtures passed`);
