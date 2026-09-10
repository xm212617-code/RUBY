// 从「RUBY条目」源目录生成 src/cardwriter-data.js（内置写卡步骤数据模块）
// 用法: node tools/build-cardwriter-data.mjs [RUBY条目目录]
// 默认目录: ../世界书/通用分析器/RUBY条目（相对本仓库根）
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = resolve(process.argv[2] || join(repoRoot, '..', '世界书', '通用分析器', 'RUBY条目'));

const read = (name) => {
    const p = join(srcDir, name);
    if (!existsSync(p)) throw new Error(`source file missing: ${p}`);
    return readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trim();
};

// RUBY 写卡模式自动切换说明：追加到每个步骤指令末尾
const MODE_NOTE = `

【RUBY写卡模式·自动切换说明】
当前处于RUBY写卡模式的对话中：各步骤条目的开启/关闭由RUBY自动管理。
RUBY检测到本步骤的完成标记（规定的yaml总结输出）后，会自动关闭当前步骤条目、开启下一步骤条目，创作者无需手动去世界书切换，结束语中也不必强调手动切换世界书。
若创作者想手动跳转/回退步骤，让TA打开RUBY面板的"写卡"页签操作即可。`;

// 过时表述清洗：源文本写作时步骤需手动开关世界书条目，现在由RUBY代管。
// 逐行替换/删除这些指令，保持与当前环境一致。
const INSTRUCTION_LINE_RULES = [
    // 结束语编号列表里的手动开关注册项：整行删除
    [/^\s*\d+\.\s*手动切换：.*$/, ''],
    // "请你手动切换到StepX，然后我会…" → 自动版
    [/请你手动切换到(Step[\d.]+(?:或Step[\d.]+)?[^\n，。]*?)，然后我会/, 'RUBY检测到完成标记后会自动切换到$1。之后我会'],
    [/请你手动切换到下一个step。/, 'RUBY检测到完成标记后会自动切换到下一个step。'],
    [/请你手动切换到(Step[\d.]+)。/, 'RUBY检测到完成标记后会自动切换到$1。'],
    // 约束条款："要求创作者手动切换到StepX" → 自动
    [/要求创作者手动切换到(Step[\d.]+(?:或Step[\d.]+)?)/, 'RUBY检测到完成标记后自动切换到$1'],
    [/完成后要求创作者手动切换到(Step[\d.]+)/, '完成后由RUBY自动切换到$1'],
    // 边界回应里的指引
    [/请先完成(Step[\d.-]+)，然后手动切换。/, '请按顺序完成$1，切换由RUBY自动处理。'],
    [/请手动切换到正确的step。/, '步骤切换由RUBY自动处理，无需手动操作世界书。'],
    [/请你手动切换到(Step[\d.]+)$/, 'RUBY会自动切换到$1'],
    // Step7 结束语的整句手动开关指令
    [/去世界书把(Step[\d.]+_[^\n]+?)关掉，打开(Step[\d.]+_[^\n]+?)。/, 'RUBY检测到完成标记后会自动切换到$2。'],
];

// 说明文本（气泡）里的过时行：手动开关条目/手动保存世界书 → RUBY 代管
const GUIDE_LINE_RULES = [
    [/^\s*-\s*完成Step[\d.]+后，去世界书把「[^」]+」关掉.*$/, '- 完成本步骤后，RUBY会自动切换到下一步骤（无需操作世界书）'],
    [/^\s*-\s*或者将这个yaml保存到世界书的临时条目中$/, '- yaml总结由RUBY自动捕获并写入《ruby写卡初稿》'],
    [/^\s*-\s*或者要求Ruby输出总结yaml，保存到世界书的临时条目中$/, '- yaml总结由RUBY自动捕获并写入《ruby写卡初稿》'],
    [/^\s*-\s*如果对话过长导致[逻辑记忆]力?衰退，可以将Step[\d.]+的yaml结果保存到世界书$/, '- 对话过长也没关系：RUBY会保存每步的yaml总结，不依赖聊天记录'],
    [/^\s*-\s*在世界书中新建条目，把档案放入（如：角色名_nsfw.yaml）$/, '- 档案yaml由RUBY自动写入《ruby写卡初稿》世界书'],
];

function sanitizeLines(text, rules) {
    return text.split('\n').map((line) => {
        for (const [re, replacement] of rules) {
            if (re.test(line)) return replacement === '' ? '' : line.replace(re, replacement);
        }
        return line;
    }).filter((line, idx, arr) => {
        // 去掉被清空后留下的连续空行（保留原有段落分隔的单空行）
        if (line === '' && arr[idx - 1] === '') return false;
        return true;
    }).join('\n');
}

// 完成输出协议：每个步骤完成时必须输出 XML 标签包裹的 ```yaml 代码块。
// MATCH_KEY 是 RUBY 识别完成的锚点字段——必须出现在 yaml 内（防草稿误判），
// 但只有一个稳定核心词，不做多重校验（不能太严格）。
const COMPLETION_PROTOCOLS = {
    Step0: { tag: 'step0_aesthetic_summary', matchKey: '故事还原' },
    Step1: { tag: 'step1_soul_exploration', matchKey: '人生经历' },
    Step2: { tag: 'step2_living_character', matchKey: '角色核心' },
    Step3: { tag: 'character', matchKey: 'character:' },
    Step4: { tag: 'NSFW档案', matchKey: 'nsfw_profile' },
    Step5: { tag: 'step5_npc_design', matchKey: 'NPC' },
    Step6: { tag: 'step6_quickview', matchKey: '关系' },
    Step7: { tag: 'step7_analysis_plan', matchKey: '任务' },
    Step8: { tag: 'step8_analysis_prompts', matchKey: '任务:' },
};

function completionProtocolNote(stepId) {
    const p = COMPLETION_PROTOCOLS[stepId];
    if (!p) return '';
    return `

【完成输出协议（RUBY自动识别依赖）】
⚠️ 本步骤完成时，你必须输出一个唯一的完成产物，格式严格如下：
1. 用XML标签 <${p.tag}> ... </${p.tag}> 整体包裹，标签独占一行
2. 标签内有且仅有一个 \`\`\`yaml 代码块：第一行是 \`\`\`yaml，最后一行是 \`\`\`（三个反引号），中间是纯yaml文本
3. yaml内容中必须包含"${p.matchKey}"字段（这是RUBY识别完成的锚点，不可省略、不可改名）
4. 所有字段必须完整填写真实内容——禁止用"..."、"省略"、"等等"占位
5. 代码块内禁止再出现三个反引号，禁止嵌套代码块

格式示例：
<${p.tag}>
\`\`\`yaml
${p.matchKey === 'character:' ? 'character: [角色全名]' : `${p.matchKey}:`}
  [完整内容...]
\`\`\`
</${p.tag}>

⚠️ 平时讨论、展示草稿时禁止使用这个XML标签——它是完成信号，只在本步骤最终总结时输出。
⚠️ 输出协议的yaml必须完整，但不必完美，创作者确认前可以继续修改。`;
}

const steps = [
    { id: 'Step0', name: '美学思考', optional: false, tool: false, file: '02_Step0：美学思考.txt', guide: '00_Step0说明_美学思考.txt' },
    { id: 'Step1', name: '灵魂探索', optional: false, tool: false, file: '03_Step1：灵魂探索.txt', guide: '00_Step1说明_灵魂探索.txt' },
    { id: 'Step2', name: '活人化塑造', optional: false, tool: false, file: '04_Step2：活人化塑造.txt', guide: '00_Step2说明_活人化塑造.txt' },
    { id: 'Step3', name: '输出角色模板', optional: false, tool: false, file: '05_Step3：输出角色模板.txt', guide: '00_Step3说明_结构化输出.txt' },
    { id: 'Step4', name: 'NSFW档案写作', optional: true, tool: false, file: '06_可选_Step4：进阶角色拆分.txt', guide: '00_Step4说明_进阶角色拆分.txt' },
    { id: 'Step5', name: 'NPC设计', optional: false, tool: false, file: '07_Step5：NPC设计.txt', guide: '' },
    { id: 'Step6', name: '人物速览与关系网', optional: false, tool: false, file: '08_Step6：人物速览与关系网.txt', guide: '' },
    { id: 'Step7', name: '分析方向与规划', optional: false, tool: false, file: '09_Step7：分析方向与规划.txt', guide: '' },
    { id: 'Step8', name: '分析提示词写作', optional: false, tool: false, file: '10_Step8：分析提示词写作.txt', guide: '' },
    { id: 'StepX', name: '自检任务', optional: true, tool: true, file: '16_StepX：自检任务.txt', guide: '' },
].map((s) => ({
    id: s.id,
    name: s.name,
    optional: s.optional,
    tool: s.tool,
    instruction: sanitizeLines(read(s.file), INSTRUCTION_LINE_RULES) + MODE_NOTE + completionProtocolNote(s.id),
    guide: s.guide ? sanitizeLines(read(s.guide), GUIDE_LINE_RULES) : '',
}));

// 路线图简述：每步一句话，注入常驻「写卡路线图」条目（约300 token），让AI始终知道全流程与当前位置
const ROADMAP_BRIEFS = {
    Step0: '还原创作者的故事想法，确定基调与世界概念',
    Step1: '通过人生经历挖掘角色的渴望、张力与恐惧',
    Step2: '把设定变成有缺点、有反差的活人',
    Step3: '整合前3步，产出完整的主角卡yaml',
    Step4: '为主角撰写独立的NSFW补充档案',
    Step5: '创作配角/NPC的设定（可多轮产出）',
    Step6: '浓缩人物速览与关系条目',
    Step7: '确定游戏期需要哪些自动分析',
    Step8: '撰写各分析任务的提示词（可多轮产出）',
    StepX: '检查既有产出的一致性与质量（工具步骤，按需使用）',
    Overview: '确认全部完成，输出收尾yaml触发最终清理',
};
for (const step of steps) {
    step.brief = ROADMAP_BRIEFS[step.id] || step.name;
}

// 总览（收尾）：仅手动抵达；Ruby 返回含「玩家已完成」的 yaml 后触发最终清理
steps.push({
    id: 'Overview',
    name: '总览',
    optional: false,
    tool: true,
    instruction: [
        '创作者已明确表示：全部写卡想法已经完成，进入收尾阶段。',
        '',
        '你的任务：',
        '1. 回顾本次写卡对话的全部产出（美学思考、灵魂探索、活人化塑造、角色卡、NSFW档案、NPC、人物速览、分析提示词等）。',
        '2. 输出一个yaml代码块作为收尾总结，格式如下：',
        '',
        '<ruby_overview>',
        '```yaml',
        '状态: 玩家已完成',
        '产出清单:',
        '  美学设定: [一句话说明本次美学思考的核心]',
        '  角色设定: [主角名 + 一句话]',
        '  NSFW设定: [如有，一句话；如无写"未创建"]',
        '  分析提示词: [本次创建的分析任务列表]',
        '保留说明: [一句话告知创作者，以上设定将保留在世界书中，其余过程条目会被清理]',
        '```',
        '</ruby_overview>',
        '',
        '严格要求：',
        '- 必须输出上述yaml代码块，且「状态: 玩家已完成」一行不可改动（这是RUBY识别收尾的锚点）。',
        '- 不要输出冗长的告别长文，yaml之外最多一两句收尾的话。',
        '- 这是收尾步骤，不要再展开新的创作讨论。',
        '- 平时讨论中禁止使用 <ruby_overview> 标签，它只在收尾时输出一次。',
    ].join('\n'),
    guide: [
        '<details>',
        '<summary><big><b style="color:#e67e22">总览：写卡收尾</b></big></summary>',
        '',
        '```',
        '这一步是整个写卡流程的终点，只能手动进入。',
        '',
        '进入后告诉Ruby：你完成你的想法了。',
        'Ruby会输出一个包含「状态: 玩家已完成」的yaml收尾总结。',
        '',
        'RUBY检测到该标记后会自动执行最终清理：',
        '  保留：美学设定、角色设定、NSFW设定、NPC设定、',
        '        人物速览、分析提示词',
        '  清除：其余过程条目（灵魂探索、活人化、分析规划等',
        '        草稿与全部步骤注入条目）',
        '```',
        '',
        '</details>',
    ].join('\n'),
});

const data = {
    version: 1,
    draftBook: 'ruby写卡初稿',
    rules: read('00_角色创作步骤辅助规则.txt'),
    persona: read('01_Ruby写卡助手.txt'),
    appendix: read('17_附录_分析器原理知识库.txt'),
    steps,
};

const out = `// 自动生成：tools/build-cardwriter-data.mjs —— 请勿手改，重新运行脚本更新
// 源目录: 世界书/通用分析器/RUBY条目
export const CARDWRITER_DATA = ${JSON.stringify(data, null, 2)};
`;

const outPath = join(repoRoot, 'src', 'cardwriter-data.js');
writeFileSync(outPath, out, 'utf8');
const kb = (out.length / 1024).toFixed(1);
console.log(`written: src/cardwriter-data.js (${kb} KB), steps: ${steps.length}`);
