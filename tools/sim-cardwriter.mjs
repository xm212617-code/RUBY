#!/usr/bin/env node
// 写卡模式全链路桌面模拟（回归测试）：假酒馆环境 + 对话脚本驱动 v2 记录引擎
// 用法: node tools/sim-cardwriter.mjs（应看到: 11 楼记录/自动切换/合成完成/世界书只剩干净条目）
// 写卡模式 v2 全链路桌面模拟（修正时序：先装假酒馆，再动态 import 引擎）
import { EventEmitter } from 'node:events';

// ---------- 假酒馆（必须在 import 引擎之前就位） ----------
const eventSource = new EventEmitter();
const eventTypes = { CHAT_CHANGED: 'chat_changed', GENERATION_ENDED: 'generation_ended' };

const BOOK = { name: 'ruby写卡初稿', entries: {} };
let uidSeq = 0;
const chat = [{ is_user: true, mes: '开场' }];
const chatMetadata = {};

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
    saveMetadataDebounced: async () => { },
});

globalThis.window = {
    SillyTavern: { getContext: () => fakeCtx() },
    toastr: {
        success: (m) => console.log('  [toast✓]', String(m).slice(0, 80)),
        info: (m) => console.log('  [toast·]', String(m).slice(0, 80)),
        warning: (m) => console.log('  [toast!]', String(m).slice(0, 80)),
        error: (m) => console.log('  [toast✗]', String(m).slice(0, 80)),
    },
    addEventListener: () => { },
    dispatchEvent: (e) => console.log('  [event]', e.type, JSON.stringify(e.detail || {})),
};
globalThis.CustomEvent = class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } };
globalThis.document = {
    createElement: () => ({
        style: {}, classList: { toggle: () => { }, add: () => { }, remove: () => { }, contains: () => false },
        addEventListener: () => { },
        appendChild: () => { }, remove: () => { }, click: () => { },
        querySelector: () => ({ addEventListener: (ev, fn) => { if (ev === 'click') setTimeout(() => fn({ target: { dataset: { choice: 'build' } } }), 10); } }),
        innerHTML: '', dataset: { choice: 'build' },
    }),
    addEventListener: () => { }, removeEventListener: () => { },
    body: { appendChild: () => { } }, getElementById: () => null,
};
globalThis.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => { } };
globalThis.Blob = class { constructor(parts) { this.text = () => Promise.resolve(parts.join('')); } };

// ---------- import 引擎 ----------
const { CARDWRITER_DATA } = await import('../src/cardwriter-data.js');
console.log('数据模块 OK:', CARDWRITER_DATA.steps.map((s) => s.id).join(' → '));

// config.js 需要 settings：看它读什么
// （getSettings -> store——silently fails if unavailable; getUi 默认 {} -> notify/draft 默认开）
const cw = await import('../src/cardwriter.js');
cw.initCardWriter();
console.log('引擎初始化 OK');

// ---------- 对话脚本 ----------
const Y = (s) => '```yaml\n' + s + '\n```';
const script = [
    // StepW 世界观
    `那我们把这个世界先钉下来。\n<ruby新条目>\n${Y(`大陈设定:
  国号: 大陈
  年号: 天平
  时局: |
    承平百年毁于内战，郭太师平定中原，然节度使林立，各据州郡。
    朝廷龟缩关中，号令不出京畿。县镇之权尽入防御使、团练使之手。
  风气: |
    礼崩乐坏，武人以刀兵论尊卑。寻常夫妻能相守到老便算天大的福分。`)}\n</ruby新条目>`,
    // Step0 美学
    `故事核心定下来了。\n<ruby新条目>\n${Y(`故事还原: |
  一个县城刑房书吏的女儿，在乱世里靠一手验尸的本事活下来、往上走的故事。
基调: 苦练本事，谁都靠不住，本事最靠得住`)}\n</ruby新条目>`,
    // Step1 角色经历
    `她的故事我整理成背景加经历。\n<ruby新条目>\n${Y(`character: 沈青梧
背景:
  出身: |
    刑房书吏的女儿，从小在仵作房边上长大，看惯了尸体和账本。
    "我爹那句话我记到现在，死人不会说谎，活人才会。"
  居住: |
    县衙后巷的赁屋里，一间半，跟老仆桂妈住。
关键经历:
  - 父亲蒙冤: |
      天平三年，父亲验一桩命案验出了不该验的人，被反咬下狱，死在牢里。
      "我去领尸那天还下着雨，桂妈劝我哭一场，我说哭什么，账还没算。"`)}\n</ruby新条目>`,
    // StepL 活人感
    `攒了一批素材。\n<ruby新条目>\n${Y(`活人素材_沈青梧:
  台词示例:
    - 你问我怕不怕，怕啊，怕有什么用，怕也得把尺子带齐了再进场。
  轶事:
    - 袖袋里永远揣一副自己的银针，比县衙发的细半寸
  生活细节:
    - 吃饭快，扒完就洗手，指甲缝永远干净`)}\n</ruby新条目>`,
    // Step2 角色核心
    `切面打磨好了。\n<ruby新条目>\n${Y(`角色核心_沈青梧:
  基调: "la prudence——她等得起：闹了案子就成死案，等着还有翻案那天，这一等就是七年"
  la prudence:
    父亲下狱那年她十六岁，没人让她等，是她自己按住自己不闹的——她算过，闹了案子就成死案，等着还有翻案那天。这一等就是七年。`)}\n</ruby新条目>`,
    // Step3 角色卡
    `主角卡组装完成。\n<ruby新条目>\n${Y(`character: 沈青梧
基调: "la prudence——她等得起：闹了案子就成死案，等着还有翻案那天，这一等就是七年"
背景:
  出身: |
    刑房书吏的女儿，在仵作房边上长大。
    "我爹那句话我记到现在，死人不会说谎，活人才会。"
关键经历:
  - 父亲蒙冤: |
      父亲验出不该验的人，被反咬下狱死在牢里。
      "我去领尸那天还下着雨，桂妈劝我哭一场，我说哭什么，账还没算。"
对话示例:
  - 你问我怕不怕，怕啊，怕有什么用，怕也得把尺子带齐了再进场。`)}\n</ruby新条目>`,
    // Step5 NPC
    `NPC 一个。\n<ruby新条目>\n${Y(`桂妈:
  别名: 桂婆子
  基本: 沈家的老仆，跟了沈家三代人。嘴碎，心细，认死理。
  外貌: 干瘦小老太，头发一丝不乱地挽着，常年一身洗得发白的靛蓝布衣。
  具体行为:
    - 买菜永远多买一把葱，说讨个彩头，回来把葱插在窗台的破碗里
  台词示例:
    - 姑娘，粥在灶上温着呢，我念了三遍了，你这耳朵是纸糊的。
  轶事:
    - 认得全县一半的更夫，谁家夜里出过事她比衙门知道得早`)}\n</ruby新条目>`,
    // Step6 速览
    `速览条目。\n<ruby新条目>\n${Y(`人物速览:
  - 沈青梧: 主角，仵作之女
  - 桂妈: 沈家老仆
  关系: 主仆，相依为命`)}\n</ruby新条目>`,
    // Step7 任务1
    `第一个任务定稿。\n<ruby新条目>\n${Y(`任务名: 沈青梧内心
分析对象: 沈青梧
捕捉关键词: 沈青梧
参考条目: [沈青梧, 人物速览]
任务: 生成沈青梧的【内心状态分析】
性质: 周期性状态更新（基于正文增量）`)}\n</ruby新条目>`,
    // Step7 任务2
    `第二个任务定稿。\n<ruby新条目>\n${Y(`任务名: 大陈局势
分析对象: 大陈设定
捕捉关键词: 局势
参考条目: [大陈设定]
任务: 生成大陈的【局势动态分析】
性质: 周期性状态更新`)}\n</ruby新条目>`,
    // Step7 更新任务1（测试更新）
    `把第一个任务改严一点。\n<ruby更新条目 编号="001">\n${Y(`任务名: 沈青梧内心
分析对象: 沈青梧
捕捉关键词: 沈青梧
参考条目: [沈青梧, 人物速览]
任务: 生成沈青梧的【内心状态分析】（修订版：增加判断检查点）
性质: 周期性状态更新（基于正文增量）`)}\n</ruby更新条目>`,
];

const stepOrder = ['StepW', 'Step0', 'Step1', 'StepL', 'Step2', 'Step3', 'Step5', 'Step6', 'Step7'];
const perStepFloors = { Step7: 3 };

console.log('\n=== 模拟开始 ===');
const started = await cw.startSession('StepW');
console.log('startSession(StepW):', started, '| state.stepId =', cw.getState().stepId);

let scriptIdx = 0;
let floor = 1;
// 每步：楼层带切换标记的目标；Step3 用 步骤="Step5" 跳过可选的 Step4（测试带目标跳步）；Step7 只在最后一楼带 步骤="Overview"
const switchPlan = {
    StepW: '', Step0: '', Step1: '', StepL: '', Step2: '',
    Step3: 'Step5',                    // 跳过 Step4 NSFW
    Step5: '', Step6: '',
    Step7: 'Overview',                 // 主链终点→合成
};
for (const stepId of stepOrder) {
    const floors = perStepFloors[stepId] || 1;
    for (let i = 0; i < floors; i++) {
        const isLastFloorOfStep = i === floors - 1;
        const target = switchPlan[stepId];
        const sw = isLastFloorOfStep ? (target ? `\n<ruby切换 步骤="${target}"/>` : '\n<ruby切换/>') : '';
        const aiText = script[scriptIdx++] + sw;
        console.log(`\n--- 楼${floor} [${stepId}] AI 输出 ${aiText.includes('ruby更新条目') ? '（更新标记' : aiText.includes('ruby新条目') ? '（新条目标记' : '（无标记'}${sw ? '+切换标记' : ''}${sw.includes('步骤=') ? '·带目标' : ''}） ---`);
        chat.push({ is_user: false, mes: aiText });
        eventSource.emit(eventTypes.GENERATION_ENDED);
        await new Promise((r) => setTimeout(r, 1600));
        console.log(`    → 引擎当前步骤: ${cw.getState().stepId}`);
        floor++;
    }
}

console.log('\n=== 记录阶段结束后的世界书（ruby记录_ 条目） ===');
for (const [uid, e] of Object.entries(BOOK.entries)) {
    const k = Array.isArray(e.key) ? e.key[0] : '?';
    if (k.startsWith('ruby记录_')) console.log(`  ${k} | keys=${JSON.stringify(e.key)} | disable=${e.disable} | order=${e.order} | pos=${e.position}`);
}

// ---------- Overview 合成 ----------
const manifestText = `清单确认了，合成吧。\n<ruby合成>\n\`\`\`json\n${JSON.stringify({
    卡名: '沈青梧',
    角色描述来源: 'Step2_001',
    条目: [
        { 记录: 'StepW_001', 条目名: '大陈设定', 关键词: ['大陈设定'], 位置: '角色前', 顺序: 1, 灯位: '蓝灯' },
        { 记录: 'Step1_001', 条目名: '沈青梧', 关键词: ['沈青梧'], 位置: '角色后', 顺序: 7, 灯位: '绿灯' },
        { 记录: 'Step5_001', 条目名: '桂妈', 关键词: ['桂妈'], 位置: '角色后', 顺序: 99, 灯位: '绿灯' },
        { 记录: 'Step6_001', 条目名: '人物速览', 关键词: ['人物速览'], 位置: '角色前', 顺序: 1, 灯位: '蓝灯' },
        { 记录: 'Step7_001', 条目名: '沈青梧的【内心状态分析】', 关键词: ['沈青梧的【内心状态分析】'], 位置: '角色前', 顺序: 999, 灯位: '关闭' },
    ],
    分析任务: [
        { 任务名: '沈青梧内心', 记录: 'Step7_001', 提示词条目名: '沈青梧的【内心状态分析】', 输出条目名: '沈青梧内心', 捕捉关键词: ['沈青梧'], 参考条目: ['沈青梧', '人物速览'], 周期位置: 2 },
    ],
}, null, 2)}\n\`\`\`\n</ruby合成>`;
console.log('\n--- 合成阶段（引擎应已通过切换标记自动进入） ---');
if (cw.getState().stepId !== 'Overview') {
    console.log('引擎未自动进入 Overview，手动切换');
    await cw.switchStep('Overview', { manual: true });
    await new Promise((r) => setTimeout(r, 200));
}
chat.push({ is_user: false, mes: manifestText });
eventSource.emit(eventTypes.GENERATION_ENDED);
await new Promise((r) => setTimeout(r, 6000));

console.log('\n=== 合成后引擎状态 ===');
console.log(JSON.stringify(cw.getState(), null, 1));
console.log('\n=== 合成后世界书（应只剩干净条目，无 RUBY 前缀） ===');
for (const [uid, e] of Object.entries(BOOK.entries)) {
    const k = Array.isArray(e.key) ? e.key.join(',') : '?';
    console.log(`  [${e.comment || '无名'}] keys=[${k}] disable=${e.disable} constant=${e.constant} pos=${e.position} order=${e.order} | ${String(e.content || '').slice(0, 40).replace(/\n/g, '¶')}…`);
}
process.exit(0);
