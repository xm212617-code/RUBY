// 回补弹窗回归：合成清单已存在于聊天历史（无新 AI 回复）→ 聊天恢复自动补扫 / 手动 compose 均应弹窗并完成下载
// 用法: node tools/test-backfill.mjs
import { EventEmitter } from 'node:events';

// ---------- 假酒馆 ----------
const eventSource = new EventEmitter();
const eventTypes = { CHAT_CHANGED: 'chat_changed', GENERATION_ENDED: 'generation_ended' };
const BOOK = { name: 'ruby写卡初稿', entries: {} };
let uidSeq = 0;
const chat = [{ is_user: true, mes: '开场' }];
const chatMetadata = {};
let downloaded = null;

const stExec = async (command) => {
    const c = String(command);
    if (c.startsWith('/getchatbook')) return { pipe: BOOK.name };
    let m = c.match(/^\/createentry file="([^"]+)" key="([^"]+)" ""$/);
    if (m) {
        const uid = ++uidSeq;
        BOOK.entries[uid] = { uid, key: [m[2]], comment: '', content: '', disable: false, constant: false, position: 0, order: 100, depth: 4 };
        return { pipe: String(uid) };
    }
    return { pipe: '' };
};
const fakeCtx = () => ({
    chat, chatMetadata, eventSource, eventTypes,
    saveMetadata: async () => { },
    loadWorldInfo: async () => JSON.parse(JSON.stringify({ entries: BOOK.entries })),
    saveWorldInfo: async (_n, data) => { BOOK.entries = JSON.parse(JSON.stringify(data.entries)); },
    executeSlashCommandsWithOptions: stExec,
    extensionSettings: {},
    characters: [],
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

// ---------- 脚手架 ----------
const Y = (s) => '```yaml\n' + s + '\n```';
const manifestOf = (extra = {}) => `清单确认。\n<ruby合成>\n\`\`\`json\n${JSON.stringify({
    卡名: '测试卡',
    角色描述来源: 'StepW_001',
    条目: [{ 记录: 'StepW_001', 条目名: '世界基调', 关键词: ['世界基调'], 位置: '角色前', 顺序: 1, 灯位: '蓝灯' }],
    ...extra,
}, null, 2)}\n\`\`\`\n</ruby合成>`;

async function freshSession() {
    BOOK.entries = {};
    uidSeq = 0;
    chat.splice(0, chat.length, { is_user: true, mes: '开场' });
    for (const k of Object.keys(chatMetadata)) delete chatMetadata[k];
    downloaded = null;
    await cw.startSession('StepW');
    chat.push({ is_user: false, mes: `<ruby新条目>\n${Y('世界基调:\n  类型: 现实')}\n</ruby新条目>` });
    eventSource.emit(eventTypes.GENERATION_ENDED);
    await new Promise((r) => setTimeout(r, 1500));
}

let fails = 0;
const ok = (c, m) => { if (!c) { console.log('FAIL ' + m); fails++; } else console.log('  ok ' + m); };

// ---------- 场景A：清单已在历史楼层（无新回复）→ CHAT_CHANGED 恢复时自动补扫弹窗 ----------
console.log('=== 场景A：聊天恢复自动补扫 ===');
await freshSession();
ok(cw.getState().draftCount >= 1, '记录已落库');
chat.push({ is_user: false, mes: manifestOf() });
eventSource.emit(eventTypes.CHAT_CHANGED);
await new Promise((r) => setTimeout(r, 3000));
ok(!!downloaded, 'A: CHAT_CHANGED 后自动弹窗并触发下载');
if (downloaded) {
    const json = JSON.parse(downloaded.parts.join(''));
    ok(json.spec === 'chara_card_v3', 'A: v3 规格');
    ok(json.data.character_book.entries.length === 1, 'A: 条目 1 条');
}
ok(cw.getState().active === false, 'A: 会话已结束');

// ---------- 场景B：手动 compose 立即扫描历史楼层 ----------
console.log('=== 场景B：手动 compose ===');
await freshSession();
chat.push({ is_user: false, mes: manifestOf({ 卡名: '手动卡' }) });
const res = await cw.composeFromChat();
ok(String(res).includes('合成完成'), 'B: compose 返回: ' + res);
ok(!!downloaded, 'B: compose 触发下载');
if (downloaded) {
    const json = JSON.parse(downloaded.parts.join(''));
    ok(json.data.name === '手动卡', 'B: 卡名=手动卡');
}

console.log(fails === 0 ? '\n=== 回补弹窗回归全部通过 ===' : `\n=== ${fails} 项失败 ===`);
process.exit(fails ? 1 : 0);
