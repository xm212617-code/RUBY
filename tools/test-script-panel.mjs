// Run with: node --test tools/test-script-panel.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/panel.js', import.meta.url), 'utf8');
const start = source.indexOf('function renderScriptPanel(');
const end = source.indexOf('\nfunction wireGlobalInteractions()', start);
assert.notEqual(start, -1, 'renderScriptPanel must exist');
assert.notEqual(end, -1, 'renderScriptPanel must end before global interactions');

function makeFixture({ deferFlush = false } = {}) {
    let activeIdentity = { avatar: 'first.png', name: 'First' };
    let saved;
    let resolveFlush;
    let renderedContext;
    let renderCount = 0;
    const data = { cardScripts: {} };
    const cards = new Map();
    const nodes = {
        '#ra_script_list': { innerHTML: '', querySelectorAll: () => [] },
        '#ra_script_detail': { innerHTML: '' },
        '#ra_script_count': { textContent: '' },
    };
    const root = { querySelector: (selector) => nodes[selector] || null };
    const config = {
        getCharacterIdentity: () => activeIdentity && { ...activeIdentity },
        resolveConfig: () => ({ data: structuredClone(cards.get(activeIdentity?.avatar) || data), layer: 'global' }),
        saveConfigData(next) {
            saved = { avatar: activeIdentity.avatar, data: structuredClone(next) };
            cards.set(activeIdentity.avatar, structuredClone(next));
        },
        flushCardPersistNow: () => deferFlush ? new Promise((resolve) => { resolveFlush = resolve; }) : Promise.resolve(),
    };
    const renderScriptPanel = vm.runInNewContext(`(${source.slice(start, end)})`, {
        PANEL_ID: 'ra_panel',
        $: () => root,
        config,
        getCardScripts: () => [{ id: 'test-script', name: 'Test', description: '' }],
        getCardScript: () => ({ id: 'test-script', render: (_detail, context) => { renderCount++; renderedContext = context; } }),
        h: (value) => String(value ?? ''),
        ui: { scriptId: '' },
        structuredClone,
    });
    renderScriptPanel(root);
    return {
        config,
        get renderedContext() { return renderedContext; },
        get saved() { return saved; },
        get renderCount() { return renderCount; },
        set activeIdentity(value) { activeIdentity = value; },
        finishFlush: () => resolveFlush?.(),
        refresh: () => renderScriptPanel(root),
    };
}

test('global fallback config can be saved to the currently selected card', async () => {
    const fixture = makeFixture();
    assert.equal(fixture.renderedContext.layer, 'global');
    const result = await fixture.renderedContext.save((scriptConfig) => { scriptConfig.enabled = true; });
    assert.equal(result.ok, true);
    assert.equal(fixture.saved.avatar, 'first.png');
    assert.deepEqual(fixture.saved.data.cardScripts, { 'test-script': { enabled: true } });
    assert.equal(fixture.renderCount, 1, 'save callback must not redraw the parent-owned script panel');
});

test('stale rendered save callback refuses to write after switching cards', async () => {
    const fixture = makeFixture();
    fixture.activeIdentity = { avatar: 'second.png', name: 'Second' };
    const result = await fixture.renderedContext.save(() => assert.fail('stale callback must not mutate config'));
    assert.equal(result.ok, false);
    assert.match(result.message, /角色卡已切换/);
    assert.equal(fixture.saved, undefined);
});

test('an in-flight save stays bound to the card captured when save began', async () => {
    const fixture = makeFixture({ deferFlush: true });
    const saving = fixture.renderedContext.save((scriptConfig) => { scriptConfig.enabled = true; });
    assert.equal(fixture.saved.avatar, 'first.png');
    fixture.activeIdentity = { avatar: 'second.png', name: 'Second' };
    fixture.finishFlush();
    const result = await saving;
    assert.equal(result.ok, false);
    assert.match(result.message, /角色卡已切换/);
    assert.equal(fixture.saved.avatar, 'first.png');
});

test('opening another card saves its own roster without copying or blocking the first card', async () => {
    const fixture = makeFixture();
    await fixture.renderedContext.save((config) => { config.characters = [{ name: 'First NPC', experience: 25 }]; });
    fixture.activeIdentity = { avatar: 'second.png', name: 'Second' };
    fixture.refresh();
    assert.equal(fixture.renderedContext.data.cardScripts['test-script'], undefined);
    const result = await fixture.renderedContext.save((config) => { config.characters = [{ name: 'Second NPC', experience: 50 }]; });
    assert.equal(result.ok, true);
    assert.equal(fixture.saved.avatar, 'second.png');
    fixture.activeIdentity = { avatar: 'first.png', name: 'First' };
    fixture.refresh();
    assert.deepEqual(fixture.renderedContext.data.cardScripts['test-script'].characters, [{ name: 'First NPC', experience: 25 }]);
});

test('script panel refreshes on open and visible chat changes, not generic refreshAll calls', () => {
    assert.match(source, /refreshAll\(\{ refreshScripts: !mode && ui\.mode === 'scripts' \}\)/);
    assert.match(source, /function refreshAll\(\{ refreshScripts = false \} = \{\}\)/);
    assert.match(source, /if \(refreshScripts && ui\.mode === 'scripts'\) renderScriptPanel\(\)/);
    assert.match(source, /c\.eventSource\.on\(c\.eventTypes\.CHAT_CHANGED, \(\) => \{/);
    assert.match(source, /root && root\.style\.display !== 'none' && ui\.mode === 'scripts'/);
});
