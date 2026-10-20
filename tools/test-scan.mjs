// 特殊步骤回归：ScanChar / ScanChat 世界书现状清点 + 既有条目 uid 引用合成
// 覆盖：清点条目内容、切换标记拒绝 manualOnly、主世界书引用（覆盖/沿用/原书不动）、
//       聊天世界书引用（含用户手写条目）、来源保真（role/probability/深度）
// 用法: node tools/test-scan.mjs
import { EventEmitter } from 'node:events';

// ---------- 假酒馆（双书：聊天书 ruby写卡初稿 + 主世界书 大陈设定书） ----------
const eventSource = new EventEmitter();
const eventTypes = { CHAT_CHANGED: 'chat_changed', GENERATION_ENDED: 'generation_ended' };
const CHAT_BOOK = 'ruby写卡初稿';
const CHAR_BOOK = '大陈设定书';
const BOOKS = {
    [CHAT_BOOK]: { entries: {} },
    [CHAR_BOOK]: { entries: {
        0: { uid: 0, key: ['大陈设定'], comment: '大陈设定', content: '大陈设定:\n  国号: 大陈\n  年号: 天平', constant: true, disable: false, position: 0, order: 10, depth: 4 },
        1: { uid: 1, key: ['沈青梧'], keysecondary: ['nsfw'], comment: '沈青梧NSFW', content: '沈青梧的核心切面与欲望描写。', constant: false, disable: false, position: 1, order: 20, depth: 4, selective: true, probability: 60, useProbability: true },
        2: { uid: 2, key: ['状态面板'], comment: '状态面板提示词', content: '生成 <状态> YAML 面板。', constant: true, disable: true, position: 4, role: 1, order: 5, depth: 0 },
    } },
};
let uidSeq = 0;
const chat = [{ is_user: true, mes: '开场' }];
const chatMetadata = {};
let downloaded = null;

const stExec = async (command) => {
    const c = String(command);
    if (c.startsWith('/getcharbook')) return { pipe: CHAR_BOOK };
    if (c.startsWith('/getchatbook')) return { pipe: CHAT_BOOK };
    let m = c.match(/^\/createentry file="([^"]+)" key="([^"]+)" ""$/);
    if (m) {
        const uid = ++uidSeq;
        BOOKS[m[1]].entries[uid] = { uid, key: [m[2]], comment: '', content: '', disable: false, constant: false, position: 0, order: 100, depth: 4 };
        return { pipe: String(uid) };
    }
    return { pipe: '' };
};
const fakeCtx = () => ({
    chat, chatMetadata, eventSource, eventTypes,
    saveMetadata: async () => { },
    loadWorldInfo: async (name) => JSON.parse(JSON.stringify({ entries: BOOKS[name]?.entries || {} })),
    saveWorldInfo: async (name, d) => { BOOKS[name].entries = JSON.parse(JSON.stringify(d.entries)); },
    executeSlashCommandsWithOptions: stExec,
    extensionSettings: {},
    characters: [{ name: '测试角色' }],
    saveSettings: async () => { },
});
globalThis.window = {
    SillyTavern: { getContext: () => fakeCtx() },
    toastr: {
        success: (m) => console.log('  [toast✓]', String(m).slice(0, 90)),
        info: (m) => console.log('  [toast·]', String(m).slice(0, 90)),
        warning: (m) => console.log('  [toast!]', String(m).slice(0, 90)),
        error: (m) => console.log('  [toast✗]', String(m).slice(0, 90)),
    },
    addEventListener: () => { },
    dispatchEvent: () => { },
};
globalThis.CustomEvent = class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } };
globalThis.document = {
    createElement: () => ({
        style: {}, classList: { toggle: () => { }, add: () => { }, remove: () => { }, contains: () => false },
        addEventListener: () => { },
        appendChild: () => { }, remove: () => { },
        click: () => { console.log('  [browser] 下载点击已触发'); },
        querySelector: () => ({ addEventListener: (ev, fn) => { if (ev === 'click') setTimeout(() => fn({ target: { dataset: { choice: 'build' } } }), 10); } }),
        innerHTML: '', dataset: { choice: 'build' },
    }),
    addEventListener: () => { }, removeEventListener: () => { },
    body: { appendChild: () => { } }, getElementById: () => null,
};
globalThis.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => { } };
globalThis.Blob = class { constructor(parts, opts) { downloaded = { parts, opts }; this.text = () => Promise.resolve(parts.join('')); } };

const cw = await import('../src/cardwriter.js');
cw.initCardWriter();

let fails = 0;
const ok = (c, m) => { if (!c) { console.log('FAIL ' + m); fails++; } else console.log('  ok ' + m); };
const findChatEntry = (pred) => Object.values(BOOKS[CHAT_BOOK].entries).find(pred);
const pushAi = async (mes) => {
    chat.push({ is_user: false, mes });
    eventSource.emit(eventTypes.GENERATION_ENDED);
    await new Promise((r) => setTimeout(r, 1500));
};

// ---------- 场景A：进入 ScanChar → 清点主世界书 ----------
console.log('=== 场景A：ScanChar 清点主世界书 ===');
await cw.startSession('StepW');
await pushAi('<ruby新条目>\n```yaml\n世界基调:\n  类型: 现实\n```\n</ruby新条目>');
ok(cw.getState().draftCount >= 1, 'A: 记录已落库');
ok(await cw.switchStep('ScanChar', { manual: true }), 'A: 手动进入 ScanChar');
const inv = findChatEntry((e) => Array.isArray(e.key) && e.key.includes('RUBY写卡_世界书现状'));
ok(!!inv && !inv.disable, 'A: 世界书现状条目已创建并注入');
const invText = String(inv?.content || '');
ok(invText.includes('uid=0') && invText.includes('大陈设定') && invText.includes('蓝灯'), 'A: 清点含 uid/条目名/灯位');
ok(invText.includes('沈青梧NSFW') && invText.includes('副关键词[nsfw]') && invText.includes('概率60%'), 'A: 清点含副关键词/概率');
ok(invText.includes('uid=2') && invText.includes('D0·user'), 'A: 清点含 D0 位置与角色标注');
ok(invText.includes('主世界书:N'), 'A: 清点含引用说明');
const stepEntry = findChatEntry((e) => Array.isArray(e.key) && e.key.includes('RUBY写卡_ScanChar'));
ok(!!stepEntry && !stepEntry.disable, 'A: ScanChar 步骤指令已注入');
ok(String(stepEntry?.content || '').includes('主世界书'), 'A: 步骤指令为主世界书版本');

// ---------- 场景B：切换标记指向特殊步骤 → 拒绝 ----------
console.log('=== 场景B：切换标记拒绝 ===');
await pushAi('我们去看主世界书吧\n<ruby切换 步骤="ScanChar"/>');
ok(cw.getState().stepId === 'ScanChar', 'B: 仍在 ScanChar（未重复切换）');
ok(String(cw.getState().lastAction || '').includes('特殊步骤'), 'B: lastAction 提示特殊步骤: ' + cw.getState().lastAction);

// ---------- 场景C：主世界书 uid 引用合成（覆盖/沿用/原书不动） ----------
console.log('=== 场景C：主世界书引用合成 ===');
const charBefore = JSON.stringify(BOOKS[CHAR_BOOK].entries);
const manifestC = {
    卡名: '重建卡',
    角色描述来源: '主世界书:1',
    开场白来源: '',
    条目: [
        { 书: '主世界书', uid: 0, 顺序: 5 },
        { 记录: 'StepW_001', 条目名: '世界基调', 关键词: ['世界基调'], 位置: '角色前', 顺序: 1, 灯位: '蓝灯' },
        { 书: '主世界书', uid: 2, 条目名: '状态面板提示词', 灯位: '关闭' },
    ],
    分析任务: [],
};
await pushAi(`清单确认。\n<ruby合成>\n\`\`\`json\n${JSON.stringify(manifestC, null, 2)}\n\`\`\`\n</ruby合成>`);
ok(!!downloaded, 'C: 合成触发下载');
if (downloaded) {
    const json = JSON.parse(downloaded.parts.join(''));
    ok(json.data.name === '重建卡', 'C: 卡名');
    ok(json.data.description === '沈青梧的核心切面与欲望描写。', 'C: description 来自主世界书 uid1');
    ok(json.data.character_book.entries.length === 3, 'C: 3 条条目');
    const byName = new Map(json.data.character_book.entries.map((e) => [e.comment, e]));
    const e0 = byName.get('大陈设定');
    ok(e0 && e0.constant === true && e0.position === 'before_char', 'C: uid0 沿用蓝灯/角色前');
    ok(e0 && e0.insertion_order === 5, 'C: uid0 顺序覆盖为 5');
    ok(e0 && e0.content === '大陈设定:\n  国号: 大陈\n  年号: 天平', 'C: uid0 内容取自主世界书');
    ok(byName.has('世界基调'), 'C: 记录引用照常工作');
    const e2 = byName.get('状态面板提示词');
    ok(e2 && e2.enabled === false, 'C: uid2 灯位覆盖为关闭');
    ok(e2 && e2.position === 'at_depth' && e2.extensions.position === 4 && e2.extensions.depth === 0, 'C: uid2 沿用 D0/深度0');
    ok(e2 && e2.extensions.role === 1, 'C: uid2 沿用 role=user');
    ok(JSON.stringify(BOOKS[CHAR_BOOK].entries) === charBefore, 'C: 主世界书原书未被改动');
    const e1 = byName.get('世界基调');
    ok(e1 && e1.insertion_order === 1 && e1.content.includes('现实'), 'C: 记录条目内容正确');
}
ok(cw.getState().active === false, 'C: 会话已结束');
const invAfter = findChatEntry((e) => Array.isArray(e.key) && e.key.includes('RUBY写卡_世界书现状'));
ok(!invAfter, 'C: 世界书现状条目随合成清理');

// ---------- 场景D：ScanChat 清点 + 聊天世界书引用（含用户手写条目） ----------
console.log('=== 场景D：ScanChat 清点与聊天书引用 ===');
await cw.startSession('StepW');
await pushAi('<ruby新条目>\n```yaml\n世界基调:\n  类型: 现实2\n```\n</ruby新条目>');
// 用户手写条目（非 RUBY 前缀）
const userUidRaw = await stExec(`/createentry file="${CHAT_BOOK}" key="用户手写条目" ""`);
const userUid = parseInt(userUidRaw.pipe, 10);
BOOKS[CHAT_BOOK].entries[userUid].comment = '用户手写条目';
BOOKS[CHAT_BOOK].entries[userUid].content = '用户手写的既有内容。';
BOOKS[CHAT_BOOK].entries[userUid].constant = false;
ok(await cw.switchStep('ScanChat', { manual: true }), 'D: 手动进入 ScanChat');
const invD = findChatEntry((e) => Array.isArray(e.key) && e.key.includes('RUBY写卡_世界书现状'));
const invDText = String(invD?.content || '');
ok(invDText.includes('聊天世界书'), 'D: 清点范围为聊天世界书');
ok(invDText.includes(`uid=${userUid}`) && invDText.includes('用户手写条目'), 'D: 用户手写条目在清点中');
ok(invDText.includes('RUBY流程条目，合成清单禁止引用'), 'D: RUBY 流程条目已标注');
ok(invDText.includes('ruby记录_StepW_001'), 'D: 记录条目在清点中（可用 uid 引用）');
const manifestD = {
    卡名: '聊天重建卡',
    条目: [
        { 书: '聊天世界书', uid: userUid, 灯位: '蓝灯', 顺序: 9 },
    ],
    分析任务: [],
};
await pushAi(`确认，合成。\n<ruby合成>\n\`\`\`json\n${JSON.stringify(manifestD, null, 2)}\n\`\`\`\n</ruby合成>`);
ok(!!downloaded, 'D: 合成触发下载');
if (downloaded) {
    const json = JSON.parse(downloaded.parts.join(''));
    const entries = json.data.character_book.entries;
    ok(entries.length === 1 && entries[0].comment === '用户手写条目', 'D: 卡内含用户条目');
    ok(entries[0].constant === true && entries[0].insertion_order === 9, 'D: 覆盖生效（蓝灯/顺序9）');
    ok(entries[0].content === '用户手写的既有内容。', 'D: 内容保留');
    const chatUser = BOOKS[CHAT_BOOK].entries[userUid];
    ok(chatUser && chatUser.constant === true && chatUser.order === 9, 'D: 聊天书内该条目同步整理');
    const rubyLeft = Object.values(BOOKS[CHAT_BOOK].entries).filter((e) => Array.isArray(e.key) && String(e.key[0]).startsWith('ruby') && e.key[0] !== 'ruby记录_StepW_001');
    ok(rubyLeft.length === 0, 'D: 未引用的 RUBY 条目已清理（记录引用除外）: ' + rubyLeft.map((e) => e.key[0]).join(','));
}

// ---------- 场景E：引用 RUBY 流程条目 → 明确拒绝（绑错书防呆） ----------
console.log('=== 场景E：RUBY 流程条目引用被拒 ===');
downloaded = null;
await cw.startSession('StepW');
const rulesEntry = findChatEntry((e) => Array.isArray(e.key) && e.key.includes('RUBY写卡规则'));
ok(!!rulesEntry, 'E: RUBY 流程条目存在');
const manifestE = {
    卡名: '坏卡',
    条目: [{ 书: '聊天世界书', uid: (BOOKS[CHAT_BOOK] && Object.entries(BOOKS[CHAT_BOOK].entries).find(([, e]) => Array.isArray(e.key) && e.key.includes('RUBY写卡规则')) || [])[0] }],
};
await pushAi(`确认。\n<ruby合成>\n\`\`\`json\n${JSON.stringify(manifestE, null, 2)}\n\`\`\`\n</ruby合成>`);
ok(!downloaded, 'E: 未触发下载');
ok(String(cw.getState().lastError || '').includes('RUBY流程条目，禁止引用'), 'E: 错误指明 RUBY 流程条目: ' + cw.getState().lastError);
ok(String(cw.getState().lastError || '').includes(`《${CHAT_BOOK}》`), 'E: 错误带聊天书名与条目数');

console.log(fails === 0 ? '\n=== 特殊步骤回归全部通过 ===' : `\n=== ${fails} 项失败 ===`);
process.exit(fails ? 1 : 0);
