import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { renderSexCombatContent } from '../src/scripts/sex-combat-view.js';

// Import trusted module source with only the registry seam replaced. No card code runs.
const moduleUrl = new URL('../src/scripts/sex-combat.js', import.meta.url);
const original = await readFile(moduleUrl, 'utf8');
let registration;
globalThis.__registerSexCombatTest = (value) => { registration = value; };
const source = original.replace("import { registerCardScript } from '../script-registry.js';", 'const registerCardScript = globalThis.__registerSexCombatTest;')
    .replace("'../env.js'", JSON.stringify(new URL('../env.js', moduleUrl).href))
    .replace("'./sex-combat-view.js'", JSON.stringify(new URL('../scripts/sex-combat-view.js', moduleUrl).href));
const api = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
delete globalThis.__registerSexCombatTest;
const { normalizeSexCombatConfig: normalize, parseSexCombatScene: parse, syncSexCombatMarkers: sync, buildSexCombatRegexScripts: regexScripts, sexCombatLevelName: level } = api;
const config = normalize({ enabled: true });
const scene = '<SceneInfo>\n场景类型: NSFWH\n在场角色:\n  - Alice|coat\n  - Bob\n</SceneInfo>';
const report = '<report>\n无行动\n</report>';

// Minimal DOM contract covers actual UI handlers without introducing a dependency.
class Element {
    constructor() {
        this.value = '';
        this.checked = false;
        this.dataset = {};
        this.textContent = '';
        this.handlers = new Map();
        this.classes = new Set();
        this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
    }
    addEventListener(name, fn) { this.handlers.set(name, fn); }
    async fire(name) { return this.handlers.get(name)?.({ target: this }); }
}

class Root extends Element {
    set innerHTML(html) {
        this.html = html;
        this.nodes = new Map();
        this.rows = [];
        for (const match of html.matchAll(/<(input|select|button|span|div)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
            const node = new Element();
            node.value = match[2].match(/\bvalue="([^"]*)"/)?.[1] ?? '';
            node.checked = /\bchecked\b/.test(match[2]);
            this.nodes.set(`#${match[3]}`, node);
        }
        for (const match of html.matchAll(/<select id="([^"]+)">([\s\S]*?)<\/select>/g)) {
            this.nodes.get(`#${match[1]}`).value = match[2].match(/<option value="([^"]+)" selected/)?.[1] || '';
        }
        // Input elements are void and can precede a later closing container.
        for (const match of html.matchAll(/<input\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
            const node = new Element();
            node.value = match[1].match(/\bvalue="([^"]*)"/)?.[1] ?? '';
            node.checked = /\bchecked\b/.test(match[1]);
            this.nodes.set(`#${match[2]}`, node);
        }
        for (const match of html.matchAll(/<div class="form-row" data-character="(\d+)">([\s\S]*?)<\/div>/g)) {
            const row = new Element();
            const name = new Element();
            name.value = match[2].match(/class="sc-name[^>]*value="([^"]*)"/)?.[1] ?? '';
            const exp = new Element();
            exp.value = match[2].match(/class="sc-exp[^>]*value="([^"]*)"/)?.[1] ?? '';
            const label = new Element();
            const button = new Element();
            button.dataset.index = match[1];
            row.querySelector = (selector) => ({ '.sc-name': name, '.sc-exp': exp, '.sc-level': label, '.sc-del': button })[selector];
            this.rows.push(row);
        }
    }
    get innerHTML() { return this.html; }
    querySelector(selector) { return this.nodes.get(selector); }
    querySelectorAll(selector) {
        if (selector === '[data-character]') return this.rows;
        if (selector === '.sc-del') return this.rows.map((row) => row.querySelector('.sc-del'));
        return [];
    }
}

function render(initial = {}, save, hostContext = {}) {
    const root = new Root();
    let saved;
    const character = hostContext.character || { avatar: 'test-card.png', name: 'Test', data: { extensions: { regex_scripts: [] } } };
    const live = hostContext;
    live.characterId ??= 0;
    live.characters ||= [character];
    live.extensionSettings ||= { character_allowed_regex: ['test-card.png'] };
    globalThis.window = { SillyTavern: { getContext: () => live } };
    const context = {
        data: { cardScripts: { 'sex-combat': initial } },
        async save(mutator) {
            const draft = structuredClone(saved ?? initial);
            mutator(draft);
            if (save) await save(draft);
            saved = draft;
        },
    };
    registration.render(root, context);
    return { root, get saved() { return saved; } };
}

test('normalization supplies detached defaults and finite experience', () => {
    const first = normalize();
    assert.equal(first.enabled, false);
    assert.equal(first.defaultJudgment, true);
    assert.equal(first.defaultExperience, 10);
    assert.equal(first.marker, 'xingdou');
    first.trigger.tag = 'Different';
    assert.equal(normalize().trigger.tag, 'SceneInfo');
    const value = normalize({ enabled: 'false', defaultJudgment: false, markerPlacement: 'tail', defaultExperience: Infinity,
        characters: [{ name: 'Alice', experience: 0 }, { name: ' alice ', experience: 100 }, { name: 'A-B', experience: -5 }, { name: 'AB', experience: '25' }] });
    assert.equal(value.enabled, false);
    assert.equal(value.defaultJudgment, false);
    assert.equal(value.markerPlacement, 'after-anchor-end');
    assert.deepEqual(value.characters, [{ name: 'Alice', experience: 0 }, { name: 'A-B', experience: 10 }, { name: 'AB', experience: 25 }]);
    assert.equal(normalize(null).trigger.tag, 'SceneInfo');
    assert.notEqual(normalize({ marker: 'report' }).marker, 'report');
    const collisions = normalize({ marker: 'xingdou', trigger: { tag: 'xingdou' }, roster: { tag: 'ruby-sex-combat-marker' }, actionTag: 'ruby-sex-combat-marker-2' });
    assert.equal(collisions.marker, 'ruby-sex-combat-marker-3');
});

test('YAML roster field spans lines and extracts only configured field', () => {
    const parsed = parse(scene + report, config);
    assert.equal(parsed.valid, true);
    assert.equal(parsed.active, true);
    assert.deepEqual(parsed.roster, ['Alice', 'Bob']);
    assert.equal(parsed.report, '无行动');
    assert.equal(parse(scene.replace('NSFWH', 'SFW'), config).active, false);
    assert.equal(parse(scene, normalize()).active, false);
    const unbulleted = scene.replace('  - Alice|coat\n  - Bob', 'Alice|coat\nBob');
    assert.equal(parse(unbulleted, config).valid, true, 'YAML newline roster accepts names without dash bullets');
    assert.deepEqual(parse(unbulleted, config).roster, ['Alice', 'Bob']);
    assert.deepEqual(parse(scene.replace('  - Alice|coat\n  - Bob', "  - 'Alice'\n  - Bob\n其它: Eve"), config).characters, ['Alice', 'Bob']);
    assert.deepEqual(parse(scene.replace('  - Alice|coat\n  - Bob', "['Alice', 'Bob']"), config).roster, ['Alice', 'Bob']);
});

test('JSON and separated rosters support custom tags and multiline values', () => {
    const custom = normalize({ enabled: true, trigger: { tag: 'game', field: 'mode', value: 'go' }, roster: { tag: 'cast', field: 'names' }, rosterFormat: 'json' });
    assert.deepEqual(parse('<game>mode: go</game><cast>{"names":["A","B","A"]}</cast>', custom).roster, ['A', 'B']);
    assert.deepEqual(parse('<game>mode: go</game><cast>names: [\n  "A",\n  "B"\n]</cast>', custom).roster, ['A', 'B']);
    assert.equal(parse('<game>mode: go</game><cast>{"names":[{"name":"A"}]}</cast>', custom).valid, false);
    const loose = { ...config, rosterFormat: 'loose' };
    assert.deepEqual(parse(scene.replace('  - Alice|coat\n  - Bob', 'Alice，Bob;Carol\nDavid\n其它: Eve'), loose).roster, ['Alice', 'Bob', 'Carol', 'David']);
});

test('ambiguous, incomplete and example XML do not trigger', () => {
    for (const invalid of [scene + scene, scene + '</SceneInfo>', scene.replace('</SceneInfo>', ''), scene.replace('场景类型: NSFWH', '场景类型: SFW\n场景类型: NSFWH'),
        `\`\`\`xml\n${scene}\n\`\`\``, `~~~xml\n${scene}\n~~~`, `<!--${scene}-->`, `\`${scene.replaceAll('\n', ' ')}\``]) {
        assert.equal(parse(invalid, config).active, false, invalid);
    }
    assert.equal(parse(`\`\`\`xml\n${scene}\n\`\`\`\n${scene}`, config).active, true);
    assert.equal(parse('<SceneInfo>{"场景类型":"SFW","场景类型":"NSFWH","在场角色":[]}</SceneInfo>', config).active, false);
    assert.deepEqual(parse(scene.replace('  - Alice|coat\n  - Bob', 'Plain Name'), config).roster, ['Plain Name']);
    assert.equal(parse('<SceneInfo>\n<!--\n场景类型: NSFWH\n在场角色:\n- Alice\nother: value\n-->\n</SceneInfo>', config).active, false);
});

test('markers use exact closing offsets, never a missing-anchor tail, and are idempotent', () => {
    const full = `${scene}prefix${report}suffix`;
    const marked = sync(full, config);
    assert.equal(marked, `${scene}prefix${report}\n</xingdou>\nsuffix`);
    assert.equal(sync(marked, config), marked);
    assert.equal(sync(`${marked}</xingdou>`, config), marked);
    assert.equal(sync(scene, config), scene);
    assert.equal(sync(scene + '<report>partial', config), scene + '<report>partial');
    assert.equal(sync(scene + report + report, config), scene + report + report);
    assert.equal(sync(full, { ...config, marker: 'custom', markerAnchor: 'trigger' }), `${scene}\n</custom>\nprefix${report}suffix`);
    assert.match(sync(scene, { ...config, actionTag: 'report', markerAnchor: 'trigger' }), /<\/SceneInfo>\n<\/xingdou>$/);
    const expectedUnmarked = full.replace('</report>suffix', '</report>\n\nsuffix');
    assert.equal(sync(marked, { ...config, enabled: false }), expectedUnmarked);
    assert.equal(sync(`\`\`\`xml\n</xingdou>\n\`\`\`\n${marked}`, config), `\`\`\`xml\n</xingdou>\n\`\`\`\n${marked}`);
});

test('Regex installation updates three owned entries and actually renders escaped HTML', () => {
    const foreign = { id: 'foreign', findRegex: 'anything', extra: { keep: true } };
    const settings = { ...config, marker: 'x:mark', characters: [{ name: '<img src=x onerror=alert(1)>$&', experience: 25 }] };
    const entries = regexScripts([foreign, { id: 'ruby-sex-combat-v1', old: true }, { id: 'ruby-sex-combat-v1', duplicate: true }], settings);
    assert.deepEqual(entries[0], foreign);
    assert.notEqual(entries[0], foreign);
    assert.equal(entries.length, 4);
    assert.deepEqual(regexScripts(entries, settings), entries);
    const prompt = entries.find((entry) => entry.promptOnly);
    const display = entries.find((entry) => entry.markdownOnly);
    const compile = (entry) => { const match = entry.findRegex.match(/^\/(.*)\/([a-z]*)$/); return new RegExp(match[1], match[2]); };
    assert.equal('a</x:mark>b'.replace(compile(prompt), prompt.replaceString), 'ab');
    const html = '</x:mark>'.replace(compile(display), display.replaceString);
    assert.match(html, /^```html\n<!doctype html>[\s\S]*<style>[\s\S]*sc-board[\s\S]*<\/style>[\s\S]*<body>[\s\S]*data-ruby-sex-combat="true"[\s\S]*ruby-sex-combat-view-request[\s\S]*<\/html>\n```$/);
    assert.match(html, /<!doctype html>[\s\S]*sc-pair[\s\S]*sc-gauges[\s\S]*sc-fatigue/);
    const regexExpandedHtml = html.replace(/\\\$(\d+)|\\\$<([^>]+)>|\\\$([&'`$])/g, (_match, number, group, literal) => {
        if (number) return '';
        if (group) return '';
        return literal;
    });
    const liveHtml = renderSexCombatContent({ state: { round: 1, p: 50, user: { pos: 10, ex: 20 }, opps: [{ name: '<img src=x onerror=alert(1)>$&', pos: 80, p: 50, ex: 25 }] }, levels: { user: 0, '<img src=x onerror=alert(1)>$&': 25 } });
    assert.match(liveHtml, /&lt;img/);
    assert.match(liveHtml, /\$&/);
    assert.doesNotMatch(liveHtml, /<img\b/i);
    assert.equal(prompt.disabled, false);
    assert.equal(regexScripts([], {}).every((entry) => entry.disabled), true);
});

test('configured XML blocks are hidden only for display, preserving source and prompt fields', () => {
    const custom = normalize({ enabled: true, trigger: { tag: 'game', field: 'mode', value: 'sexhard' }, roster: { tag: 'cast', field: 'names' }, rosterFormat: 'loose', actionTag: 'actions' });
    const source = '<game>mode: sexhard</game>\n<cast>names: Alice,Bob</cast>\n正文\n<actions>user:\n  单向: 1\n</actions>\n</xingdou>\n<gameplay>keep</gameplay>';
    const rules = regexScripts([], custom);
    const hide = rules.find((entry) => entry.id === 'ruby-sex-combat-blocks-display-v1');
    assert.equal(hide.markdownOnly, true);
    assert.equal(hide.promptOnly, false);
    const compile = (entry) => { const match = entry.findRegex.match(/^\/(.*)\/([a-z]*)$/); return new RegExp(match[1], match[2]); };
    const visible = source.replace(compile(hide), hide.replaceString);
    assert.equal(visible, '\n\n正文\n\n</xingdou>\n<gameplay>keep</gameplay>');
    assert.equal(parse(source, custom).active, true, 'Ruby still parses the untouched raw message');
    const prompt = rules.filter((entry) => entry.promptOnly).reduce((text, rule) => text.replace(compile(rule), rule.replaceString), source);
    assert.ok(prompt.includes('<game>mode: sexhard</game>'));
    assert.ok(prompt.includes('<cast>names: Alice,Bob</cast>'));
    assert.ok(prompt.includes('<actions>'));
    assert.ok(!prompt.includes('</xingdou>'));
    const defaults = regexScripts([], config).find((entry) => entry.id === hide.id);
    assert.equal('<SceneInfo>场景类型：NSFWH</SceneInfo>正文<report>data</report>'.replace(compile(defaults), ''), '正文');
    const renamed = regexScripts(rules, config);
    assert.equal(renamed.filter((entry) => entry.id === hide.id).length, 1, 'changing XML tags updates the owned rule in place');
});

test('UI registration uses current-config save contract and awaits Promise', async () => {
    assert.equal(registration.id, 'sex-combat');
    let completed = false;
    const ui = render({ customKey: 'preserved' }, async (draft) => {
        assert.equal(draft.marker, 'custom');
        assert.equal(draft['sex-combat'], undefined);
        await Promise.resolve();
        completed = true;
    });
    ui.root.querySelector('#sc-marker').value = 'custom';
    await ui.root.querySelector('#sc-save').fire('click');
    assert.equal(completed, true);
    assert.equal(ui.saved.marker, 'custom');
    assert.equal(ui.saved.customKey, 'preserved');
    assert.match(ui.root.innerHTML, /脚本配置已保存/);
});

test('UI character CRUD preserves unsaved fields and displays levels immediately', async () => {
    const ui = render();
    ui.root.querySelector('#sc-trigger-value').value = 'custom-value';
    ui.root.querySelector('#sc-character-name').value = 'Alice';
    ui.root.querySelector('#sc-character-exp').value = '25';
    await ui.root.querySelector('#sc-character-add').fire('click');
    assert.deepEqual(ui.saved.characters, [{ name: 'Alice', experience: 25 }]);
    assert.equal(ui.saved.trigger.value, 'custom-value');
    const row = ui.root.rows[0];
    row.querySelector('.sc-name').value = 'Carol';
    row.querySelector('.sc-exp').value = '50';
    await row.querySelector('.sc-exp').fire('input');
    assert.equal(row.querySelector('.sc-level').textContent, '老手');
    await ui.root.querySelector('#sc-save').fire('click');
    assert.deepEqual(ui.saved.characters, [{ name: 'Carol', experience: 50 }]);
    await ui.root.rows[0].querySelector('.sc-del').fire('click');
    assert.deepEqual(ui.saved.characters, []);
    await ui.root.querySelector('#sc-judgment').fire('click');
    assert.equal(ui.saved.defaultJudgment, false);
    assert.deepEqual([0, 10, 25, 50, 100].map(level), ['处子', '新手', '经验', '老手', '魅魔']);
});

test('UI validation and rejected saves show errors without throwing', async () => {
    const ui = render();
    ui.root.querySelector('#sc-marker').value = 'report';
    await ui.root.querySelector('#sc-save').fire('click');
    assert.equal(ui.saved, undefined);
    assert.match(ui.root.querySelector('#sc-feedback').textContent, /不能与解析标签相同/);
    ui.root.querySelector('#sc-marker').value = 'xingdou';
    ui.root.querySelector('#sc-default-exp').value = '-1';
    await ui.root.querySelector('#sc-save').fire('click');
    assert.equal(ui.saved, undefined);
    const rejected = render({}, async () => { throw new Error('disk failure'); });
    await rejected.root.querySelector('#sc-save').fire('click');
    assert.match(rejected.root.querySelector('#sc-feedback').textContent, /disk failure/);
});

test('UI installs only owned card Regex and propagates write failures', async () => {
    const foreign = { id: 'other', findRegex: 'x' };
    const character = { avatar: 'alice.png', data: { extensions: { regex_scripts: [foreign], other: 'kept' } } };
    const calls = [];
    const extensionSettings = { character_allowed_regex: [] };
    const context = { character, extensionSettings, async writeExtensionField(...args) { calls.push(args); }, saveSettingsDebounced() {} };
    const ui = render(config, undefined, context);
    await ui.root.querySelector('#sc-install-regex').fire('click');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 0);
    assert.equal(calls[0][1], 'regex_scripts');
    assert.deepEqual(calls[0][2][0], foreign);
    assert.equal(character.data.extensions.other, 'kept');
    assert.equal(character.data.extensions.regex_scripts.length, 4);
    assert.deepEqual(extensionSettings.character_allowed_regex, ['alice.png'], 'install explicitly authorizes this card scoped regex');
    context.extensionSettings = { character_allowed_regex: ['alice.png'] };
    context.writeExtensionField = async () => { throw new Error('no write'); };
    await ui.root.querySelector('#sc-install-regex').fire('click');
    assert.match(ui.root.querySelector('#sc-feedback').textContent, /no write/);
    delete globalThis.window;
});

test('card switches during async config save cannot install Regex into the new card', async () => {
    const characters = [{ avatar: 'first.png', name: 'First', data: { extensions: {} } }, { avatar: 'second.png', name: 'Second', data: { extensions: {} } }];
    let characterId = 0;
    let writes = 0;
    const host = { character: characters[0], get characterId() { return characterId; }, characters, extensionSettings: { character_allowed_regex: ['first.png', 'second.png'] }, async writeExtensionField() { writes++; } };
    const ui = render(config, async () => { characterId = 1; }, host);
    await ui.root.querySelector('#sc-install-regex').fire('click');
    assert.equal(writes, 0);
    assert.match(ui.root.querySelector('#sc-feedback').textContent, /角色卡已切换/);
    assert.equal(characters[1].data.extensions.regex_scripts, undefined);
    delete globalThis.window;
});
