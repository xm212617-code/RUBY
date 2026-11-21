import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseSexCombatReport } from '../src/scripts/sex-combat-runtime.js';
import { parseSexCombatScene, syncSexCombatMarkers } from '../src/scripts/sex-combat.js';

const path = new URL('../../世界书/县城/插图县城/替换内容.html', import.meta.url);
const html = await readFile(path, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
const county = vm.createContext({ CFG: { userName: 'user' }, MAX_OPPONENTS: 6 });
const begin = html.indexOf('  function scXmlBlocks(');
const end = html.indexOf('  /* ══════════ 结算', begin);
const sceneStart = html.indexOf('  function parseSceneChars(');
const sceneEnd = html.indexOf('  /* ══════════ 持久化', sceneStart);
if (html) vm.runInContext(html.slice(begin, end) + '\n' + html.slice(sceneStart, sceneEnd), county);
const scene = (grade = 'NSFWH', name = 'A') => `<SceneInfo>\n场景类型: ${grade}\n在场角色:\n- ${name}|daily\n</SceneInfo>`;
const report = (n = 1) => `<report>\nuser:\n  单向: ${n}\n  双向: 0\n</report>`;

for (const [name, parseReport, parseScene] of [
    ['universal', parseSexCombatReport, (text) => parseSexCombatScene(text, { enabled: true })],
    ['county', county.parseReport, (text) => { const parsed = county.parseSceneChars(text); return { active: parsed.hard, roster: parsed.chars }; }],
]) {
    test(`${name}: orphan tags and custom reasoning reminders do not invalidate final data`, { skip: name === 'county' && !html }, () => {
        for (const prefix of ['别忘了<report>和<SceneInfo>。\n',
            '<custom_thought>别忘了<report>与</report>，<SceneInfo>与</SceneInfo>。</custom_thought>\n',
            '<think>' + scene('SFW', 'Wrong') + report(3) + '</think>\n']) {
            const text = prefix + scene() + '\n' + report();
            assert.equal(parseReport(text).user.单向, 1);
            assert.equal(parseScene(text).active, true);
            assert.equal(parseScene(text).roster[0], 'A');
        }
    });
    test(`${name}: multiple reports select last valid block without adding their actions`, { skip: name === 'county' && !html }, () => {
        assert.equal(parseReport(report(3) + report(1)).user.单向, 1);
        assert.equal(parseReport(report(2) + '<report>请保持这个格式</report>').user.单向, 2);
        assert.equal(parseReport('<report>unclosed reminder\n' + report(1)).user.单向, 1);
        assert.equal(parseReport(report(1) + '</report>\n<report>unclosed').user.单向, 1);
    });
    test(`${name}: scene candidates use valid fields and the last valid current scene`, { skip: name === 'county' && !html }, () => {
        assert.equal(parseScene(scene() + '<SceneInfo>记得输出</SceneInfo>').active, true);
        assert.equal(parseScene(scene() + scene('SFW')).active, false);
        assert.equal(parseScene('<SceneInfo>reminder\n' + scene()).active, true);
    });
    test(`${name}: malformed action fields and examples remain ignored`, { skip: name === 'county' && !html }, () => {
        assert.equal(parseReport('<report>\nuser:\n  单向: -1\n</report>'), null);
        assert.equal(parseReport('<report>\nuser:\n  单向: 1\n  单向: 2\n</report>'), null);
        assert.equal(parseReport('```xml\n' + report() + '\n```'), null);
        assert.equal(parseReport('<think>' + report() + '</think>'), null);
        assert.equal(parseReport('<report>\n提示词:\n</report>'), null);
    });
}

test('universal marker is placed at the final complete block despite reasoning tag mentions', () => {
    const text = '注意<SceneInfo>，别忘了<report>\n' + scene() + '\n' + report();
    const marked = syncSexCombatMarkers(text, { enabled: true });
    assert.match(marked, /<\/report>\n<\/xingdou>$/);
    assert.equal(syncSexCombatMarkers(marked, { enabled: true }), marked);
});

test('county embedded JavaScript remains syntactically valid', { skip: !html }, () => {
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) new vm.Script(match[1]);
});
