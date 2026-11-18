// Run with: node --test tools/test-format-marks.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const loadSource = (source) => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const format = await loadSource(await readFile(new URL('../src/format-marks.js', import.meta.url), 'utf8'));
const config = await loadSource((await readFile(new URL('../src/config.js', import.meta.url), 'utf8'))
    .replace("import { ctx, log, warn } from './env.js';", 'const ctx = () => null, log = () => {}, warn = () => {};'));
const closingMark = (anchor, extra = {}) => ({
    tag: '/xingdou', position: 'tail', relAnchor: anchor,
    relBoundary: 'close', relSide: 'after', relMissing: 'skip', ...extra,
});

test('exact closing offset uses the named closing tag, including inline and repeated tags', () => {
    const text = '<game>start<report>one</report>middle<report>two</report></game>suffix';
    assert.equal(format.findAnchorOffset(text, 'game'), text.indexOf('</game>') + 7);
    assert.equal(format.findAnchorOffset(text, 'report'), text.indexOf('</report>') + 9);
    assert.equal(format.findAnchorOffset(text, 'game,report'), text.indexOf('</report>') + 9);
    assert.equal(format.findAnchorOffset(text, 'report', { side: 'before' }), text.indexOf('</report>'));
    assert.equal(format.findAnchorOffset(text, 'missing'), -1);
    assert.equal(format.findAnchorOffset('<reporting>x</reporting>', 'report'), -1);
    assert.equal(format.findAnchorOffset('<REPORT>x</REPORT >', 'report'), '<REPORT>x</REPORT >'.length);
    assert.equal(format.findAnchorOffset('<a.b>x</a.b>', 'a.b'), '<a.b>x</a.b>'.length);
});

test('afterClosing can target game or report without jumping to the first tag on its line', () => {
    const text = '<game><report>x</report>rest</game>tail';
    assert.equal(format.applyFormatMarks(text, [closingMark('report')]).mes,
        '<game><report>x</report>\n</xingdou>\nrest</game>tail');
    assert.equal(format.applyFormatMarks(text, [closingMark('game')]).mes,
        '<game><report>x</report>rest</game>\n</xingdou>\ntail');
    assert.equal(format.applyFormatMarks(text, [closingMark('report', { relSide: 'before' })]).mes,
        '<game><report>x\n</xingdou>\n</report>rest</game>tail');
});

test('opening tags alone do not satisfy closing boundaries, skip does not claim an inserted marker', () => {
    for (const text of ['plain', '<report>unfinished', '<report/>', '<reporting>x</reporting>']) {
        assert.deepEqual(format.applyFormatMarks(text, [closingMark('report')]), { mes: text, tags: [] });
    }
    assert.deepEqual(format.applyFormatMarks('plain', [closingMark('report', { relMissing: undefined })]),
        { mes: 'plain\n</xingdou>', tags: ['</xingdou>'] });
    assert.equal(format.applyFormatMarks('plain', [{ tag: 'ruby/', position: 'head', relAnchor: 'none' }]).mes,
        '<ruby/>\nplain');
});

test('precise insertion preserves original content, variables and ordered markers', () => {
    const text = 'prefix\r\n<report>x</report>\r\nsuffix';
    const marks = [closingMark('report', { tag: '{{var:name}}' }), closingMark('report')];
    const result = format.applyFormatMarks(text, marks, { name: 'xingdou' });
    assert.equal(result.mes, 'prefix\r\n<report>x</report>\r\n<xingdou>\r\n</xingdou>\r\nsuffix');
    assert.deepEqual(result.tags, ['<xingdou>', '</xingdou>']);
    assert.equal(format.applyFormatMarks('</report>', [closingMark('report')]).mes, '</report>\n</xingdou>');
    assert.equal(format.applyFormatMarks('<report>x</report>\nrest', [closingMark('report')]).mes,
        '<report>x</report>\n</xingdou>\nrest');
    assert.equal(format.resolveMarkVars('ruby_{{var:_ruby_phase}}_{{var:missing}}', { _ruby_phase: 'old' }, 0), 'ruby_0_');
    assert.deepEqual(format.applyFormatMarks('unchanged', [{ tag: '{{var:missing}}' }]), { mes: 'unchanged', tags: [] });
});

test('mixed exact and legacy placements retain their own anchors', () => {
    const result = format.applyFormatMarks('intro\n<game><report>x</report>rest</game>tail', [
        { tag: 'head', position: 'head' },
        closingMark('report'),
        { tag: 'legacy', relAnchor: 'game', relSide: 'before' },
        { tag: 'tail', position: 'tail' },
    ]);
    assert.equal(result.mes, '<head>\nintro\n<legacy>\n<game><report>x</report>\n</xingdou>\nrest</game>tail\n<tail>');
});

// Frozen pre-extraction behavior. Do not import engine (it belongs to the host runtime).
function legacyApply(mes, marks, vars, phaseOverride) {
    const resolved = marks.map((mark) => ({ ...mark, value: `<${format.resolveMarkVars(mark.tag, vars, phaseOverride)}>` }))
        .filter((mark) => mark.value !== '<>');
    const tags = resolved.map((mark) => mark.value);
    if (!resolved.length) return { mes, tags };
    const lines = mes.split('\n');
    const inserts = [], head = [], tail = [];
    for (const mark of resolved) {
        const line = mark.relAnchor ? format.findAnchorLine(lines, mark.relAnchor) : -1;
        if (line >= 0) inserts.push({ at: mark.relSide === 'after' ? line + 1 : line, value: mark.value });
        else (mark.position === 'tail' ? tail : head).push(mark.value);
    }
    inserts.sort((a, b) => b.at - a.at);
    for (const insert of inserts) lines.splice(insert.at, 0, insert.value);
    let out = lines.join('\n');
    if (head.length) out = `${head.join('\n')}\n${out}`;
    if (tail.length) out = `${out}\n${tail.join('\n')}`;
    return { mes: out, tags };
}

test('legacy candidate priority, same-line order and head/tail fallback remain unchanged', () => {
    assert.equal(format.findAnchorLine(['<report>x</report>', '<game>x</game>'], 'game,report'), 1);
    assert.equal(format.findAnchorLine(['<reporting>x</reporting>', '<report>x</report>'], 'report'), 1);
    assert.equal(format.findAnchorLine(['<REPORT>x</REPORT>'], 'report'), 0);
    assert.equal(format.findAnchorLine(['<aXb>x</aXb>', '<a.b>x</a.b>'], 'a.b'), 1);
    const templates = [
        { position: 'head' }, { position: 'tail' },
        { relAnchor: 'game', relSide: 'before' }, { relAnchor: 'game', relSide: 'after' },
        { relAnchor: 'missing', position: 'tail' }, { relAnchor: 'game,report', relSide: 'after' },
    ];
    for (const text of ['', '\n', '<game>x</game>', '<game>x</game>\n', 'a\n<game>x</game>\nb', '<report>x</report>\n<game>y</game>']) {
        for (const first of templates) for (const second of templates) {
            const marks = [{ tag: 'first', ...first }, { tag: '/last', ...second }];
            assert.deepEqual(format.applyFormatMarks(text, marks), legacyApply(text, marks));
        }
    }
});

test('format config preserves closing marks and only enables explicit optional behavior', () => {
    const marks = config.normalizeFormatMarks([closingMark('report', { tag: '</xingdou>' }),
        { tag: 'ruby', relBoundary: 'invalid', relMissing: 'invalid' }]);
    assert.deepEqual(marks[0], closingMark('report'));
    assert.equal(Object.hasOwn(marks[1], 'relBoundary'), false);
    assert.equal(Object.hasOwn(marks[1], 'relMissing'), false);
    assert.deepEqual(config.normalizeFormatMarks([{ tag: 'ruby' }]),
        [{ tag: 'ruby', position: 'tail', relAnchor: '', relSide: 'before' }]);
    const raw = { tag: '/xingdou', relAnchor: 'report', relBoundary: 'close' };
    assert.equal(format.applyFormatMarks('<report>x</report>', [raw]).mes,
        format.applyFormatMarks('<report>x</report>', config.normalizeFormatMarks([raw])).mes);
});

test('cardScripts survives normalize, JSON export/import and legacy imports as detached JSON', () => {
    const scripts = { 'sex-combat': { enabled: true, marker: 'xingdou', markerAnchor: 'game',
        nested: [1, false, null, { text: 'retained' }] }, other: { arbitrary: 'preserved', absent: undefined } };
    const normalized = config.normalizeConfigData({ cardScripts: scripts, formatMarks: [closingMark('report')] });
    assert.deepEqual(normalized.cardScripts, JSON.parse(JSON.stringify(scripts)));
    assert.notEqual(normalized.cardScripts['sex-combat'], scripts['sex-combat']);
    const imported = config.parseImportTemplate(JSON.parse(JSON.stringify(normalized)));
    assert.deepEqual(imported.cardScripts, normalized.cardScripts);
    assert.deepEqual(imported.formatMarks, normalized.formatMarks);
    assert.deepEqual(config.parseImportTemplate({ tasks: [], cardScripts: scripts }).cardScripts, normalized.cardScripts);
    for (const invalid of [null, [], true, 'text', 1, { toJSON: () => null }, { toJSON: () => [] }]) {
        assert.deepEqual(config.normalizeCardScripts(invalid), {});
    }
    const cyclic = {}; cyclic.self = cyclic;
    assert.deepEqual(config.normalizeCardScripts(cyclic), {});
    assert.deepEqual(config.normalizeCardScripts({ value: 1n }), {});
});
