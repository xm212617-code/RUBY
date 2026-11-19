// Usage: node tools/build-agent-knowledge.mjs [skill-root] [RUBY-entry-root]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSexCombatRegexScripts } from '../src/scripts/sex-combat.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const skillRoot = resolve(process.argv[2] || join(repoRoot, '..', '..', '.kilo', 'skills', '角色卡分段流水线'));
const rubyRoot = resolve(process.argv[3] || join(repoRoot, '..', '世界书', '通用分析器', 'RUBY条目'));
const read = (root, name) => readFileSync(join(root, name), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
const skill = (name) => read(skillRoot, name);
const ruby = (name) => read(rubyRoot, name);
const entry = (id, title, summary, content) => ({ id, title, summary, content });

function before(text, heading) {
    const index = text.indexOf('\n' + heading);
    if (index < 0) throw new Error(`Missing section boundary: ${heading}`);
    return text.slice(0, index).trimEnd();
}

function finalCheck() {
    try { return skill('checks/F-全卡终检.md'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return `# F 全卡终检
源 skill 未提供独立的 F 文件时，按 SKILL.md 的 F/GF、writing 第六节及 voice 的专项与声口三问执行。

1. 核对 G1–G5 和完整 YAML。逐段与 brief、已确认项目口径及共享历史对照，查事实、时间线、人物关系、称呼、尺度和跨卡污染。不追加未确认设定。
2. 逐字扫项目词表、八股变形、禁句式、重复意象和补完句。不能只按关键词判定，用 voice A/B/C 的上下文标准复核。
3. 按 writing 第六节逐区核验。重点检查基调未复述、经历语例有依据、切面机制及六坑、痕迹不替玩家行动、底线与核心一致、基准只保留不可推导的指令。
4. 通读所有语料，用 voice I 的三问逐条核对声口，遮名检查能否辨人。记录数字指标（总行数、切面/对话/痕迹/轶事/底线/基准数量、重复意象），与各段标准及已确认项目配额对照。
5. 给每项判定及证据，FAIL 就地修复并全卡复查。写 RESULT: PASS 后才加 [GF-PASS]。D 交付整卡 YAML、锚词和切面、已对齐口径和配套清单。仅在创作者明确通过后记 [CARD-APPROVED]。`;
}

const checks = [
    ['p0', 'P0-动笔前', '对齐创作者、拆卡与建立 brief。'],
    ['p1', 'P1-段一使用说明核心身份基调出身居住', '主卡开篇与语例。'],
    ['p2', 'P2-段二关键经历', '时间线、事件逻辑与角色语料。'],
    ['p3', 'P3-段三外貌角色核心', '第一人称外貌、切面及六坑。'],
    ['p4', 'P4-段四对话示例角色痕迹', '纯对白和用于呈现角色的虚拟场景。'],
    ['p5', 'P5-段五轶事底线写作基准', '不可推导片段、红线和写作约束。'],
    ['f', 'F-全卡终检', '一致性、字词、声口与数字指标。'],
    ['n', 'N-NSFW档案', '主卡过审后的独立补充档案闸门。'],
    ['s', 'S-分析任务与状态栏', '六段分析提示词、面板与接线检查。'],
    ['c', 'C-组卡', '成品 JSON/PNG 与源条目的核验。'],
].map(([id, file, summary]) => {
    let content = id === 'f' ? finalCheck() : skill(`checks/${file}.md`);
    if (id === 's') {
        content = content.replace(/^> (?:方法依据|实例)：.*\n/gm, '')
            .replace(/^- \*\*状态栏 HTML\*\*：.*$/m, '- **状态栏 HTML**：按数据源选择 panel-snapshot、panel-ruby-live 或 panel-sex-combat，使用对应示例及宿主前置检查。')
            .replace(/### 状态栏 HTML\n[\s\S]*?(?=### 挂接)/, `### 状态栏 HTML
- [ ] 消息快照使用白名单捕获或宿主编码。活状态用固定 outputKey，验证 uid=0、空记录、忙态和手动刷新。性斗视图只接内置 runtime。
- [ ] 核对 regex 作用域、显示标志、转义和实际 renderer。验证脚本执行与适配器缺失的错误提示。

`);
    }
    if (id === 'c') content = 'Agent 组卡前先读 assembly。源检查单的文件路径描述离线工具链，由实际可用的受控打包能力决定。脚本型 HTML 前置见 panel-host。\n\n' + content;
    return entry(`check-${id}`, file, summary, content);
});

const fence = '```';
const fenced = (lang, text) => `${fence}${lang}\n${text}\n${fence}`;
const jsonExample = (value) => fenced('json', JSON.stringify(value, null, 2));
const displayRegex = (id, scriptName, findRegex, html) => ({
    id, scriptName, findRegex, replaceString: fenced('html', html),
    trimStrings: [], placement: [2], disabled: false, markdownOnly: true,
    promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null,
});

const snapshotRegex = displayRegex('ruby-agent-snapshot-example', '场景快照',
    String.raw`/<SceneInfo>([\p{L}\p{N} _-]{1,80})<\/SceneInfo>/gu`, `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>场景册页</title>
<style>
  body{margin:0;padding:.6rem;color:#38281d;font:1rem/1.45 serif}
  details{max-width:42rem;margin:auto;padding:.7rem 1rem;background:#f4ecdb;border-block:3px solid #9e2b25}
  summary{cursor:pointer;font-weight:bold} p{margin:.5rem 0 0;overflow-wrap:anywhere}
</style>
<details open><summary>场景册页</summary><p>地点 · $1</p></details>
</html>`);

const liveRegex = displayRegex('ruby-agent-live-example', 'RUBY 实时状态', '/【RUBY实时状态】/g', `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RUBY 实时状态</title>
<style>body{font:1rem/1.5 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
<h2>值班状态</h2>
<p id="status" role="status">读取中…</p>
<div id="results"></div>
<button id="read" type="button">重读</button>
<button id="run" type="button">手动分析并刷新</button>
<script>
const outputKey = 'demo-status';
const statusNode = document.getElementById('status');
const results = document.getElementById('results');
const read = document.getElementById('read');
const run = document.getElementById('run');

function detectAdapter() {
    for (const name of ['STscript', 'executeSlashCommands', 'triggerSlash']) {
        if (typeof window[name] === 'function') return window[name].bind(window);
    }
    let context;
    try { context = window.parent.SillyTavern?.getContext?.(); } catch { /* Cross-origin frame. */ }
    if (typeof context?.executeSlashCommands === 'function') return context.executeSlashCommands.bind(context);
    throw new Error('宿主未提供斜杠执行适配器，请检查消息 renderer 和桥接配置');
}

async function call(command) {
    const result = await detectAdapter()(command);
    const raw = result?.pipe ?? result?.value ?? result;
    if (typeof raw !== 'string') throw new Error('斜杠执行适配器没有返回文本');
    try { return JSON.parse(raw); } catch { throw new Error(raw || 'RUBY 返回空响应'); }
}

async function render(keys) {
    const rows = [];
    for (const key of keys) {
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(key)) throw new Error('示例仅接受安全 ASCII outputKey');
        const rec = await call('/ruby key=' + key + ' strict=true json=true read');
        const row = document.createElement('pre');
        if (Array.isArray(rec) && rec.length === 0) row.textContent = key + '：暂无数据';
        else if (rec?.uid != null && typeof rec.content === 'string') row.textContent = rec.content || '（空条目）';
        else throw new Error('RUBY 返回了无效的读记录');
        rows.push(row);
    }
    results.replaceChildren(...rows);
}

async function update(analyze = false) {
    read.disabled = run.disabled = true;
    statusNode.textContent = analyze ? '分析中…' : '读取中…';
    try {
        let keys = [outputKey];
        let notice = '已读取当前聊天的最新状态';
        if (analyze) {
            const result = await call('/ruby task=demo-status json=true run');
            if (!Array.isArray(result?.tasks)) throw new Error(result?.summary || 'RUBY 返回了无效的任务结果');
            keys = [...new Set(result.tasks.filter((task) => task.ok && task.outputKey).map((task) => task.outputKey))];
            if (!keys.length) throw new Error(result.summary || '分析没有可刷新的输出');
            notice = result.summary || (result.ok ? '分析并刷新完成' : '已刷新成功任务的输出');
        }
        await render(keys);
        statusNode.textContent = notice;
    } catch (error) {
        results.replaceChildren();
        statusNode.textContent = error.message;
        console.error('RUBY 状态栏', error);
    } finally {
        read.disabled = run.disabled = false;
    }
}
read.addEventListener('click', () => update());
run.addEventListener('click', () => update(true));
update();
</script>
</html>`);

const data = [
    entry('pipeline', '真 Agent 写卡流水线', '阶段、工作区、闸门、交付与知识导航。', `# 真 Agent 写卡流水线
下文为 skill 的只读方法。浏览器里 brief.md、draft.md、progress.md 分别对应已授权世界书中三个独立的关闭条目。为每张卡确定稳定且唯一的主键，例 agent:demo:brief、agent:demo:draft、agent:demo:progress。卡名和 uid 必须以实际数据为准。ST 持久化条目以 disable:true 表示关闭，导出卡片条目以 enabled:false 表示关闭。可关闭注入但仍能受控读取。读写只用 Agent 提供的受控接口，先核对当前聊天、书和唯一条目，复读确认内容和关闭状态。禁止借旧写卡触发标记绕过权限。
按阶段阅读 check-p0 至 check-p5、check-f、check-n、check-s、check-c。写作方法见 writing、voice、nsfw、analysis。项目口径由创作者提供，profile-template 只是示例。状态栏和组卡的宿主行为以 panel-host、对应 panel-* 和 assembly 为准。未获授权的范例卡或本地文件需由创作者明确提供。

${skill('SKILL.md')}`),
    ...checks,
    entry('profile-template', '项目口径模板', '只读填空示例，项目真实配置由创作者提供。', skill('profile.template.md')),
    entry('writing', '主卡写作心法', '角色构成、信息效率、主卡 YAML 模板与拆读示范。', skill('references/写作心法.md')),
    entry('voice', '语料与八股禁令', '语料 A/B/C 检查、切面和一致性专项。', skill('references/语料与八股禁令.md')),
    entry('nsfw', '独立补充档案心法', '三面交融、区块写法、自检清单与模板。', before(skill('references/NSFW档案心法.md'), '## 附录：完整范例')),
    entry('analysis', 'RUBY 分析任务写法', '六段骨架、两种状态原型、输出与挂接。', skill('references/分析任务心法.md')),
    entry('assembly', '组卡与核验', '世界书灯位、正则、RUBY 配置、导出和回验。', `# 组卡与核验
按 check-c 盘点并核对。下面保留原 skill 的原理、流程和示例布局，位置、灯位和 order 以创作者实际配置为准。第 4 节只作历史配置示意，脚本型面板的围栏、宏和宿主支持以 panel-host 为准。只有受控组卡能力可执行打包；无法执行时输出配置/清单，保持 GC 待验。组卡时排除关闭的工作区条目，关闭的分析提示词仍可按计划随卡交付。

${before(skill('references/组卡.md'), '## 九、实例索引')}`),
    entry('ruby-legacy', '旧 RUBY 写卡知识索引', '已有写卡步骤与 P0–P5 的对应关系。', `旧 StepW/Step0 用于世界观和美学对齐，辅助 P0。旧 Step1 是角色经历访谈，主要辅助 P0 收集素材及 P2 写作，流水线 P1 只写开篇。旧 StepL 收集活人感素材，供 P2、P4、P5。旧 Step2 讨论角色核心，辅助 P0 切面方案与 P3。旧 Step3 的整卡结构供 P1–P5 与 F 参考，仍逐段过闸。Step4、Step7、StepX、Overview 分别辅助 N、S、F、C；Step5 NPC 与 Step6 关系速览是独立配套。
下面的旧资料仅参考写作方法。旧 Step 编号、定稿标签、跳步、角色扮演指令都不用于真 Agent 工具授权或阶段推进。`),
    ...[
        ['world', '01a_StepW：世界观讨论.txt', '世界观构思与现实题材取材。'],
        ['history', '03_Step1：角色经历讨论.txt', '访谈、因果追问和时间线整理。'],
        ['texture', '03b_StepL：活人感设计.txt', '生活细节和角色语感。'],
        ['npc', '07_Step5：NPC设计.txt', '简化 NPC 结构和接线。'],
        ['relationships', '08_Step6：人物速览与关系网.txt', '关系速览、可读索引和独立条目。'],
    ].map(([id, filename, summary]) => entry(`ruby-legacy-${id}`, `旧 RUBY · ${filename.split('：')[1].slice(0, -4)}`, summary,
        '历史只读资料。先看 ruby-legacy，沿用写作方法时仍按当前流水线闸门推进。\n\n' + ruby(filename))),
    entry('panel-host', '消息状态栏宿主与正则', 'SillyTavern 替换顺序、渲染前置与转义。', `# 三类状态栏
panel-snapshot 从对应楼层正文读取，重渲染同一楼仍显示该楼数据。panel-ruby-live 读取当前聊天世界书，可由授权的手动 run 更新。panel-sex-combat 只向当前卡已安装的内置 runtime 取只读视图。不同时间语义的部分可以同页分卷，标明快照或实时。

## 宿主行为
SillyTavern Regex engine 的 runRegexScript 先把替换模板内的 {{match}}（不区分大小写）改为 $0，再展开 $0（整个匹配）、$1 等数字捕获和 $<name> 命名捕获。应用 trimStrings 后，最后对整个替换文本调用 substituteParams，宏可以在静态模板或捕获文本里发生展开。此流程没有 HTML、JavaScript 或属性转义，也不是 JS String.replace 的 $&、$$ 规则。substituteRegex:0 仅关闭查找表达式的宏替换，不影响替换文本末尾的宏展开。
正则记录放 data.extensions.regex_scripts。placement:[2] 匹配 AI 输出；确需玩家消息才用 [1,2]。markdownOnly:true 配 promptOnly:false 做显示层替换，runOnEdit:true 才覆盖编辑路径。原始标记仍留在消息里。需要从 prompt 去掉标记时另做 promptOnly 规则，别把整段 HTML 注入 prompt。
三个示例的 replaceString 是完整可导入的值。支持 HTML 代码块转 iframe 的 renderer 才会执行其中的 script，需安装、启用并实际验证。原生 ST/Regex 不承诺代码块转 iframe，也不提供通用 STscript；缺 renderer 时可能只显示代码块。活状态还需明确支持斜杠执行的适配器，性斗帧还需处在 runtime 认可的消息 DOM 中。

## 保留源码与边界
JSON 导入/export 保留反斜杠、围栏、换行、字面宏和 script，按 JSON.stringify 序列化，不做全局替换或删脚本。若需在最终 DOM 显示字面宏，把花括号写成 HTML 实体（例如 &#123;&#123;user&#125;&#125;）；脚本中可用 JS unicode escape 表示花括号或美元符以避开宏/组占位扫描。按上下文编码，禁止将未经约束的捕获直接拼进 HTML、属性、JSON 或 JavaScript，尤其禁止把 $1 放进反引号模板。反引号、美元插值、提前闭合 script 及宏展开都能突破字符串边界。`),
    entry('panel-snapshot', '$1 正文快照', '安全捕获、册页布局与可导入的快照正则。', `# 正文快照
正文写一行 <SceneInfo>北门岗亭</SceneInfo>，对应楼层的显示正则只收长度 1–80 的 Unicode 字母、数字、空格、下划线和短横线。捕获放入 HTML 文本，拒绝尖括号、引号、反引号、反斜杠、宏与换行。这里使用原生 details 完成折叠；要求 iframe renderer 才会按下方围栏显示。白名单外的文本不会匹配，不应放宽到任意文本。
从册页式面板提炼：先给统一题头，按场景、人物、实时动态分卷，天然适合可折叠布局。题签用低饱和底色、墨色文字与单一强调色，网格列按容器宽度降级。快照只保留本楼的新信息；人物长设定另存已授权条目，不嵌进面板。动态内容用 textContent。若需要图，已批准资源按固定 id 映射至 URL，不把捕获当 URL。
任意 UTF-8 多行文本场景，需由受信宿主先编码为无填充 Base64URL，再在原始消息放入标记，正则仅捕获 [A-Za-z0-9_-] 并长度限额，放进数据属性；脚本解码进 textContent，验证解码错误。原生 Regex 不负责编码。也可由受信 renderer 自己从消息提取文本，用 DOM API 安全赋值。

${jsonExample(snapshotRegex)}`),
    entry('panel-ruby-live', 'RUBY read/run 活状态', '有适配器检测、错误处理和 run 后刷新闭环。', `# RUBY 活状态
在当前卡 RUBY 面板创建任务，promptKey 指向关闭的提示词条目，示例任务 outputKey 为 demo-status。可先在当前聊天世界书加主键 demo-status，内容例如「值班：未交接」，单测纯读无需运行分析。消息输出 【RUBY实时状态】。正确的读写命令分别为 /ruby key=demo-status strict=true json=true read 和 /ruby task=demo-status json=true run。具名参数始终在子命令前。示例只接受安全 ASCII outputKey；其他命名需用宿主支持的参数序列化，read 可用 key64= 传 encodeURIComponent 的结果。禁止把正文或模型返回的自由文本拼进命令。
read 默认读聊天世界书且 content 会展开宏。book=char 选主角色书，book=<书名> 选指定书，raw=true 保留宏。普通 read 优先精确后模糊；strict=true 用主键精确查询。json=true 返回记录（含 uid、book、keys、comment、content、disabled、constant）或未命中的 []，all=true 返回数组。uid=0 是合法记录，以 rec.uid != null 检查。适配器可能回字符串或带 pipe/value 的对象，失败也可能直接回文本。
run 会调用配置好的分析并写聊天世界书，要等完成后按成功的 tasks[].outputKey 重读。任务 spec 支持 id、名称、promptKey、outputKey 或关键词，多个可逗号分隔。按钮只在用户主动点击时调用固定任务；显示忙态、部分成功或错误。本面板在挂载时读取，周期更新后需重读、重渲染或手动刷新。历史楼中的面板也读当前状态。需要只读视图时去掉 run 按钮与处理路径，保留必要的检测和错误提示。

${jsonExample(liveRegex)}`),
    entry('panel-sex-combat', '内置性斗 runtime 只读视图', '静态 registry、postMessage 接线和生产正则示例。', `# 性斗 runtime 只读视图
在角色卡的 RUBY 脚本页启用内置 sex-combat，通过面板安装 Regex 并确认宿主允许该卡正则。下面数组是生产构建器为启用状态和默认配置生成的完整正则（默认收 </xingdou>）。优先走面板安装以同步配置和稳定 id。保留其它卡内正则，按 id 更新这三条。匹配、类名与包围格式是 runtime 就绪检查的一部分，改 marker 要从脚本配置重新安装。只导入正则不会启用 runtime，需有当前卡配置、聊天身份、已允许并启用的正则、消息 iframe 以及有效场景/报告才会显示实际进度。
帧向 parent.postMessage 发送 {type:'ruby-sex-combat-view-request', nonce}。host 确认来源是 #chat .mes .mes_text 内匹配的 iframe，检查 data-ruby-sex-combat="true" 和运行资格，再回 {type:'ruby-sex-combat-view-state', nonce, identity, html}，有具体 origin 时以该 origin 回复，隔离帧可用通配符。内置帧按 type 和 nonce 刷新，html 是 runtime renderSexCombatContent 产出的片段。保留超时或空态提示供排障；自定义受控客户端应额外校验 event.source === parent 与已知 origin，不能把任意 postMessage 的 html 插进 DOM。
现有 registry 由插件模块静态注册，此能力只用于内置 sex-combat runtime。角色卡与 Agent 无动态注册任意 JS 的入口。面板只请求视图，不跑斜杠、不改世界书、不触发结算；所有结算由 runtime 自己处理。

${jsonExample(buildSexCombatRegexScripts([], { enabled: true }))}`),
];

const out = '// Generated by tools/build-agent-knowledge.mjs. Do not edit.\n'
    + `export const AGENT_KNOWLEDGE_DATA = ${JSON.stringify(data, null, 2)};\n`;
writeFileSync(join(repoRoot, 'src', 'agent-knowledge-data.js'), out, 'utf8');
console.log(`written: src/agent-knowledge-data.js (${Buffer.byteLength(out)} bytes, ${data.length} entries)`);
