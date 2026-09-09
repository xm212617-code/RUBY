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
    instruction: read(s.file) + MODE_NOTE,
    guide: s.guide ? read(s.guide) : '',
}));

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
        '- 必须输出上述yaml代码块，且「状态: 玩家已完成」一行不可改动。',
        '- 不要输出冗长的告别长文，yaml之外最多一两句收尾的话。',
        '- 这是收尾步骤，不要再展开新的创作讨论。',
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
        '  保留：美学设定、角色设定、NSFW设定、分析提示词',
        '  清除：其余全部过程条目（灵魂探索、活人化、NPC、速览、',
        '        分析规划等草稿与全部步骤注入条目）',
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
