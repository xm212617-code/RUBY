// /ruby run 手动分析接口回归测试（假酒馆 + 假 AI generateRaw + 斜杠原语 mock）：任务解析/批量/结果结构/错误路径
// 用法: node tools/test-run-interface.mjs
// /ruby run 手动分析接口单元测试（假酒馆 + 假 AI generateRaw）：任务解析/批量/结果结构/错误路径
import { EventEmitter } from 'node:events';

const eventSource = new EventEmitter();
const eventTypes = { CHAT_CHANGED: 'chat_changed', GENERATION_ENDED: 'generation_ended', MESSAGE_RECEIVED: 'message_received', CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready' };
const CHAT_BOOK = 'ruby-测试角色·剧情分析';
const CHAR_BOOK = '测试角色';
const BOOKS = { [CHAT_BOOK]: { entries: {} }, [CHAR_BOOK]: { entries: {} } };
let uidSeq = 0;
const addEntry = (book, key, content) => {
    const uid = ++uidSeq;
    BOOKS[book].entries[uid] = { uid, key: Array.isArray(key) ? key : [key], comment: '', content, disable: false, constant: false };
};
addEntry(CHAR_BOOK, '沛霖内心提示', '任务指令…');
addEntry(CHAR_BOOK, '沛霖生理提示', '任务指令…');

const CARD_CONFIG = {
    presets: [{
        id: 'p1', name: '方案一', cycleLength: 2,
        tasks: [
            { id: 1, displayName: '沛霖内心', promptKey: '沛霖内心提示', outputKey: '沛霖内心', extraKeys: '沛霖', keywordScanKeywords: ['沛霖'], enabled: true, useReferences: [], useOutputs: [], position: 1, depth: 4, order: 9 },
            { id: 2, displayName: '沛霖生理', promptKey: '沛霖生理提示', outputKey: '沛霖生理', extraKeys: '沛霖', keywordScanKeywords: ['沛霖'], enabled: true, useReferences: [], useOutputs: [], position: 1, depth: 4, order: 10 },
            { id: 3, displayName: '禁用任务', promptKey: '', outputKey: '禁用输出', enabled: false, useReferences: [], useOutputs: [], position: 1, depth: 4, order: 11 },
        ],
        startupTask: { enabled: false, displayName: '开局', useReferences: [], useOutputs: [] },
        director: { enabled: false },
        referencePool: [],
    }],
    activePresetId: 'p1',
};
const chat = [{ is_user: true, mes: '开场' }, { is_user: false, mes: '正文1' }];
const chatMetadata = {};

// 假 AI 接缝：generateRaw（主通道）
let fakeAiResult = '对user:\n  关系趋势: 更近了';
let aiCalls = 0;

const _VARS = {};
const fakeCtx = () => ({
    eventSource, eventTypes,
    chat, chatMetadata,
    name2: '测试角色',
    characterId: 0,
    characters: [{ name: '测试角色', avatar: 'none', data: { extensions: { RubyAnalyzer: CARD_CONFIG } } }],
    chatLength: chat.length,
    mainApi: 'openai',
    getCurrentChatId: () => 'test-chat',
    saveMetadata: async () => { },
    saveMetadataDebounced: async () => { },
    loadWorldInfo: async (name) => JSON.parse(JSON.stringify({ entries: BOOKS[name]?.entries || {} })),
    saveWorldInfo: async (name, data) => { BOOKS[name].entries = JSON.parse(JSON.stringify(data.entries)); },
    generateRaw: async () => { aiCalls++; return fakeAiResult; },
    executeSlashCommandsWithOptions: async (cmd) => {
        // 模拟 ST 斜杠原语：管道 |、setvar/getvar、setentryfield、createentry、getchatbook/getcharbook
        const VARS = _VARS;
        const parseVal = (s) => {
            s = String(s ?? '').trim();
            if (s.startsWith('"') && s.endsWith('"')) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
            return s;
        };
        const run = async (one, piped) => {
            const c = String(one).trim();
            if (c.startsWith('/getchatbook')) return { pipe: CHAT_BOOK };
            if (c.startsWith('/getcharbook')) return { pipe: CHAR_BOOK };
            let m = c.match(/^\/createentry file="([^"]+)" key="([^"]+)" ""$/);
            if (m) {
                const uid = ++uidSeq;
                BOOKS[m[1]].entries[uid] = { uid, key: [m[2]], comment: '', content: '', disable: false, constant: false, position: 0, order: 100, depth: 4 };
                return { pipe: String(uid) };
            }
            m = c.match(/^\/setvar key=(\S+) ([\s\S]*$)/);
            if (m) { VARS[m[1]] = parseVal(m[2]); return { pipe: '' }; }
            m = c.match(/^\/getvar (\S+)$/);
            if (m) return { pipe: String(VARS[m[1]] ?? '') };
            m = c.match(/^\/setentryfield file="([^"]+)" uid=(\d+) field=(\w+)(?: (.*))?$/);
            if (m) {
                const book = BOOKS[m[1]]; const uid = parseInt(m[2], 10); const field = m[3];
                const rawVal = m[4] !== undefined ? parseVal(m[4]) : String(piped ?? '');
                const e = book?.entries[uid];
                if (!e) return { pipe: '', isError: true, errorMessage: `uid ${uid} not found` };
                if (field === 'key' || field === 'keysecondary') {
                    e[field] = String(rawVal).split(',').map((s) => s.trim()).filter(Boolean);
                } else if (['constant', 'disable', 'selective', 'excludeRecursion', 'preventRecursion'].includes(field)) {
                    e[field] = rawVal === '1' || rawVal === 1 || rawVal === 'true';
                } else if (['position', 'order', 'depth', 'selectiveLogic'].includes(field)) {
                    e[field] = parseInt(rawVal, 10) || 0;
                } else {
                    e[field] = rawVal;
                }
                return { pipe: '' };
            }
            return { pipe: '' };
        };
        const parts = String(cmd).split('|').map((s) => s.trim());
        let result = { pipe: '' };
        for (const p of parts) {
            result = await run(p, result?.pipe);
            if (result?.isError) return result;
        }
        return result;
    },
    extensionSettings: {},
    saveSettings: async () => { },
    substituteParams: (s) => String(s),
});
globalThis.window = { SillyTavern: { getContext: () => fakeCtx() }, toastr: {}, addEventListener: () => { }, dispatchEvent: () => { } };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o?.detail; } };
globalThis.document = { createElement: () => ({ style: {}, classList: { toggle: () => { } }, addEventListener: () => { }, appendChild: () => { }, remove: () => { }, querySelector: () => null }), addEventListener: () => { }, removeEventListener: () => { }, body: { appendChild: () => { } }, getElementById: () => null };

const engine = await import('file:///D:/game/SillyTavern/nova-creator-cli/nova-creator-cli/ruby-analyzer/src/engine.js');
const configMod = await import('file:///D:/game/SillyTavern/nova-creator-cli/nova-creator-cli/ruby-analyzer/src/config.js');

let fails = 0;
const ok = (c, m) => { if (!c) { console.log('FAIL ' + m); fails++; } };

// 0. resolveTask 各解析路径
const { data } = configMod.resolveConfig();
const preset = data.presets[0];
const { resolveTask } = engine;
ok(resolveTask('1', preset)?.id === 1, 'id 解析');
ok(resolveTask('沛霖内心', preset)?.id === 1, 'displayName 解析');
ok(resolveTask('沛霖内心提示', preset)?.id === 1, 'promptKey 解析');
ok(resolveTask('沛霖生理', preset)?.id === 2, 'outputKey 解析');
ok(resolveTask('沛霖', preset)?.id === 1, '捕捉关键词解析');
ok(resolveTask('禁用任务', preset)?.enabled === false, '禁用任务可解析但 enabled=false');
ok(resolveTask('不存在', preset) === null, '未命中 null');

// 1. 单任务手动执行（名字）→ 结果结构 + 世界书写入
const r1 = await engine.forceRun('task', '沛霖内心');
ok(r1.ok === true && r1.completed === 1 && r1.failed === 0, '单任务 ok: ' + JSON.stringify(r1).slice(0, 100));
ok(r1.tasks[0].name === '沛霖内心' && r1.tasks[0].outputKey === '沛霖内心', '结果含 outputKey');
const written = Object.values(BOOKS[CHAT_BOOK].entries).find((e) => (e.key || []).includes('沛霖内心'));
ok(!!written && String(written.content).includes('更近了'), '输出已写入聊天世界书');
ok(aiCalls === 1, 'AI 调用 1 次: ' + aiCalls);

// 2. 批量（outputKey + id 混用逗号分隔）
const r2 = await engine.forceRun('task', '沛霖生理,1');
ok(r2.completed === 2, '批量 2 任务完成: ' + r2.summary);
ok(r2.tasks.length === 2 && r2.tasks.every((t) => t.ok), '批量结果齐');

// 3. 未启用/不存在 → 报错
let err3 = '';
try { await engine.forceRun('task', '禁用任务'); } catch (e) { err3 = e.message; }
ok(err3.includes('未找到启用的任务'), '禁用任务报错: ' + err3.slice(0, 40));
let err4 = '';
try { await engine.forceRun('task', '不存在的任务'); } catch (e) { err4 = e.message; }
ok(err4.includes('未找到'), '不存在报错');

// 4. 混合：一个命中一个未命中 → 命中的照跑
const r5 = await engine.forceRun('task', '沛霖内心, 不存在的任务');
ok(r5.completed === 1 && r5.ok === true, '混合批量只跑命中的: ' + r5.summary);

// 5. 空结果失败路径
fakeAiResult = 'x'; // 长度<2 → 内容过短失败
const r6 = await engine.forceRun('task', '沛霖内心');
ok(r6.ok === false && r6.failed === 1 && r6.tasks[0].reason === '内容过短', '空结果失败: ' + JSON.stringify(r6.tasks[0]));

console.log(fails === 0 ? '\n=== /ruby run 手动分析接口全部测试通过 ===' : `\n=== ${fails} 项失败 ===`);
process.exit(fails ? 1 : 0);
