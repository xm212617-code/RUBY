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
    { id: 'Step6.5', name: '创作交接', optional: true, tool: false, file: '22_Step6.5：创作交接.txt', guide: '' },
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
