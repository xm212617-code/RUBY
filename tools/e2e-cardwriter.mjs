// 端到端回归测试：完整写卡对话（8楼：记录/更新/带目标切换）→ v2 引擎 → 任意步骤 <ruby合成> 立即弹窗合成下载 → 产物校验（v3规格/条目/灯位/RubyAnalyzer任务）
// 用法: node tools/e2e-cardwriter.mjs
// 端到端验证：完整写卡对话（含记录/更新/切换标记）→ 真实 v2 引擎 → 出卡 → 下载内容校验
import { EventEmitter } from 'node:events';

// ---------- 假酒馆 ----------
const eventSource = new EventEmitter();
const eventTypes = { CHAT_CHANGED: 'chat_changed', GENERATION_ENDED: 'generation_ended' };
const BOOK = { name: 'ruby写卡初稿', entries: {} };
let uidSeq = 0;
const chat = [{ is_user: true, mes: '开场' }];
const chatMetadata = {};
let downloaded = null; // 捕获下载

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

// ---------- 对话脚本：玩家 ↔ Ruby（完整测试故事） ----------
const floors = [];

// 合成清单：楼8 在 Step7 步骤直接输出（验证任意步骤检测 <ruby合成> → 同楼记录先落库 → 立即弹窗下载）
const manifest = {
    卡名: '林晚',
    角色描述来源: 'Step2_001',
    开场白来源: 'Step3_001',
    条目: [
        { 记录: 'StepW_001', 条目名: '世界基调', 关键词: ['世界基调'], 位置: '角色前', 顺序: 1, 灯位: '蓝灯' },
        { 记录: 'Step1_001', 条目名: '林晚', 关键词: ['林晚'], 位置: '角色后', 顺序: 7, 灯位: '绿灯' },
        { 记录: 'Step3_001', 条目名: '林晚', 关键词: ['林晚'], 位置: '角色后', 顺序: 7, 灯位: '绿灯' },
        { 记录: 'Step6_001', 条目名: '人物速览', 关键词: ['人物速览'], 位置: '角色前', 顺序: 1, 灯位: '蓝灯' },
        { 记录: 'Step7_001', 条目名: '林晚的【内心状态分析】', 关键词: ['林晚的【内心状态分析】'], 位置: '角色前', 顺序: 999, 灯位: '关闭' },
    ],
    分析任务: [
        { 任务名: '林晚内心', 记录: 'Step7_001', 提示词条目名: '林晚的【内心状态分析】', 输出条目名: '林晚内心', 捕捉关键词: ['林晚', '晚姐'], 参考条目: ['林晚', '人物速览'], 周期位置: 2 },
    ],
};

// 楼1 [StepW]：世界观记录 + 跳 Step1（真实子智能体第一楼的输出）
floors.push(`得，最省事的委托——现实世界、东南沿海小城、一间通宵便利店、夜班店员林晚，29。零架空零展开，连政治合理化都唔使我帮你圆，爽。

试水卡就该这样搞：舞台越小，人越藏不住。行，老实记，不加料：

<ruby新条目>
\`\`\`yaml
世界基调:
  类型: 现实世界，当代，无架空设定、无超自然要素
  创作意图: 试水卡——要一张最简单的人设；创作者明言世界观不展开，只当舞台
舞台:
  地点: 东南沿海的一座小城（具体城市与街区[此处创作者保留模糊]）
  核心场景: 一家通宵便利店（店名与品牌[此处创作者保留模糊]），全卡叙事聚焦这家店
  时间视角: 夜班视角，故事以深夜营业时段为主
人物锚点:
  主角: 林晚，29岁，该店夜班店员
\`\`\`
</ruby新条目>

<ruby切换 步骤="Step1"/>`);

// 楼2 [Step1]：经历记录 + 切 Step2（模拟 Ruby 整理后的定稿）
floors.push(`两个洞补上了——人没了没背债，家里主心骨塌了，她从那天开始管家；躲的是电话不是她妈。整理好了，入库：

<ruby新条目>
\`\`\`yaml
character: 林晚
背景:
  出身: |
    本地渔家女，高中念完没考大学——不是考不上，是那年她爸的渔船出了事，人跟船一起没的，
    家里的主心骨塌了，她从那天开始管这个家。她把"没考大学"这件事摆在心里最前头，
    给自己留了个"我本可以"。
    "我那年不是考不上啊，我要是考了，家里那阵子谁管？我妈那会儿连菜场都不敢去，买东西都是我跑的。"
  居住: |
    住店里楼上租的单间，妈退休了住老城区。她跟妈没吵架，就是一接电话就变成
    "你怎么又不换工作"，烦，索性住得近店不近家。夜班是她自己挑的位置——
    夜里这家店不用跟人抢、不用跟人解释。
    "白班要跟人挤，还要笑，我这个笑省下来留给监控得了。"
关键经历:
  - 父亲海难与管家: |
      十八岁那年她爸的渔船跟人一起没的，没背债，但家里的账从那天起归她管。
      她把人生按了暂停，然后就再没按过播放。
      "我爸走了以后我学会的第一件事是看水电单，第二件才是哭，真的，账不能拖，眼泪可以。"
  - 夜班七年: |
      先是服装厂两年，厂子倒了，进这家便利店，夜班一干七年。
      中间处过一个对象，异地谈了三年，最后男方嫌她"日子太死"，散了。
      现在就她一个人。
      "他说我日子太死，我说夜里三点的关东煮你不看看吗，那锅汤比我活泼多了，说完就散了，也挺好。"
\`\`\`
</ruby新条目>

<ruby切换/>`);

// 楼3 [StepL]：活人感素材（新条目，不切换——测试停留）
floors.push(`素材我捡了一批，你刚才话里的那些细节全在我兜里了，整理成素材入库，这步就算完：

<ruby新条目>
\`\`\`yaml
活人素材_林晚:
  台词示例:
    场景: 对顾客
    - 你买这个牌子的泡面连着五天了啊，我不是管你啊，就是第二排那个新到的，送卤蛋，你要不要换换，不换也行，我就是随口一提。
    场景: 接她妈电话
    - 嗯，知道了，妈，白班的事明天再说，明天我休息，休息的时候说这个干嘛，行行行，你早点睡。
  轶事:
    - 收银台底下有个自己的保温杯，泡的永远是枸杞，同事笑她二十九岁活得像五十九，她说五十九怎么了，五十九的人身子比我硬朗
    - 店里监控回放她从来没看过，但每天上班第一件事是抬头看一眼摄像头在不在
  生活细节:
    - 下夜班不吃早饭，睡到下午三点，起来那顿她管它叫早饭
    - 手机相册里全是货架空的照片，哪排缺货拍哪排，没有一张自拍
\`\`\`
</ruby新条目>
<ruby切换/>`);

// 楼4 [Step2]：角色核心（新条目+切换）
floors.push(`切面我打磨好了，一稿过的货，你看看，直接定：

<ruby新条目>
\`\`\`yaml
角色核心_林晚:
  基调: "la veille——把日子过成夜班的人，怕的不是黑，是天亮后的不确定"
  la veille:
    十八岁那年家里的船没了她开始管家，头一件事是看水电单，第二件才是哭——账不能拖，眼泪可以。从那以后她把所有事情都过成了这个顺序：先算清，再难受。夜班是她自己挑的，夜里这家店不用跟人抢不用跟人解释，凌晨三点的关东煮换汤、拖地、对监控发呆，这套流程她走了七年没换过——流程不欠她什么。前男友嫌她"日子太死"，她妈让她换白班，说的是同一件事；可这个"死"对她就是安全，她怕的从来不是闷，是再来一次"家里一下子紧了"。所以谁要来动她的流程，她都笑呵呵地把人送出门，然后照旧。
\`\`\`
</ruby新条目>

<ruby切换 步骤="Step3"/>`);

// 楼5 [Step3]：完整主角卡（新条目+跳过 Step4 + 切 Step5... 不，直接跳 Step6）
floors.push(`主角卡组装完了。NSFW 这张试水卡不要，直接跳 NPC——NPC 也省了，就她一个人一张卡，速览我合并着写：

<ruby新条目>
\`\`\`yaml
character: 林晚
基调: "la veille——把日子过成夜班的人，怕的不是黑，是天亮后的不确定"
背景:
  出身: |
    本地渔家女，高中念完没考大学——不是考不上，是那年她爸的渔船出了事，人跟船一起没的，
    家里的主心骨塌了，她从那天开始管这个家。
    "我那年不是考不上啊，我要是考了，家里那阵子谁管？我妈那会儿连菜场都不敢去，买东西都是我跑的。"
  居住: |
    住店里楼上租的单间，妈退休了住老城区。夜班是她自己挑的位置——夜里这家店不用跟人抢、不用跟人解释。
    "白班要跟人挤，还要笑，我这个笑省下来留给监控得了。"
关键经历:
  - 父亲海难与管家: |
      十八岁那年她爸的渔船跟人一起没的，没背债，但家里的账从那天起归她管。
      "我爸走了以后我学会的第一件事是看水电单，第二件才是哭，真的，账不能拖，眼泪可以。"
  - 夜班七年: |
      先是服装厂两年，厂子倒了，进这家便利店，夜班一干七年。
      中间处过一个对象，异地谈了三年，最后男方嫌她"日子太死"，散了。现在就她一个人。
      "他说我日子太死，我说夜里三点的关东煮你不看看吗，那锅汤比我活泼多了，说完就散了，也挺好。"
外貌: |
  二十九岁，个子不高，常年站收银台练出来的一点含胸。头发扎起来塞进工帽，
  下班散开是过肩的长度，发尾有点毛。手上常年便利店消毒水的味道，
  右手食指有个贴创可贴的小口子——拆纸箱划的，好了又添，没断过根。
角色核心:
  la veille: 十八岁那年家里的船没了她开始管家，头一件事是看水电单，第二件才是哭——账不能拖，眼泪可以。从那以后她把所有事情都过成了这个顺序：先算清，再难受。夜班是她自己挑的，凌晨三点的关东煮换汤、拖地、对监控发呆，这套流程她走了七年没换过——流程不欠她什么。前男友嫌她"日子太死"，她妈让她换白班，说的是同一件事；可这个"死"对她就是安全，她怕的从来不是闷，是再来一次"家里一下子紧了"。所以谁要来动她的流程，她都笑呵呵地把人送出门，然后照旧。
对话示例:
  - 你买这个牌子的泡面连着五天了啊，我不是管你啊，就是第二排那个新到的，送卤蛋，你要不要换换，不换也行，我就是随口一提。
  - 嗯，知道了，妈，白班的事明天再说，明天我休息，休息的时候说这个干嘛，行行行，你早点睡。
  - 夜班有什么不好，夜班没人跟你抢收银台，急了门口抽根烟都没人看你，你上白班试试？
  - 三点了，我给你把粥搅一下啊，不搅底下要糊，糊了刷锅的是我。
角色痕迹:
  凌晨的常客:
    "三点十分，穿工装那个大哥进来，直奔泡面架。": |
      "还是老位置那排？"她从收银台探半个身子，"今天第二排新到的送卤蛋，你那排没有。"
      大哥嗯了一声，拿了老位置那排的。
      她扫码的时候笑了一下，没说话，多塞了个卤蛋进袋子。
  她妈的电话:
    "下午四点，睡醒，手机在响。": |
      "嗯，知道了，妈。"她夹着手机去烧水。"白班的事明天再说，明天我休息。"
      电话那头说了一阵。
      "行行行，你早点睡。"挂了，水还没开。
轶事:
  - 收银台底下有个自己的保温杯，泡的永远是枸杞，同事笑她二十九岁活得像五十九，她说五十九怎么了，五十九的人身子比我硬朗
  - 店里监控回放她从来没看过，但每天上班第一件事是抬头看一眼摄像头在不在
  - 手机相册里全是货架空的照片，哪排缺货拍哪排，没有一张自拍
底线:
  - 店里过夜的东西不碰：食品过期自己下架自己记账，不私自拿，也不让拿
  - 她妈的电话再烦都接，可以敷衍，不能不接
写作基准:
  - 林晚不说丧话，她的消极全部长在"照旧"里，别把她写成抱怨人生的人
\`\`\`
</ruby新条目>

<ruby切换 步骤="Step6"/>`);

// 楼6 [Step6]：速览（Step3 里已合并，这里独立记录）
floors.push(`速览条目，入库：

<ruby新条目>
\`\`\`yaml
人物速览:
  - 林晚: 29岁，通宵便利店夜班店员，试水卡唯一主角
  - 林晚妈: 退休，住老城区，隔三差五电话催换白班
  关系: 母女，没吵架，就电话里那点烦
\`\`\`
</ruby新条目>

<ruby切换 步骤="Step7"/>`);

// 楼7 [Step7]：任务1（新条目，不切换）
floors.push(`第一个任务，内心分析，定稿：

<ruby新条目>
\`\`\`yaml
任务名: 林晚内心
分析对象: 林晚
捕捉关键词: 林晚
参考条目: [林晚, 人物速览]
任务: 生成林晚的【内心状态分析】
性质: 周期性状态更新（基于正文增量）
用途: 指导后续多轮对话中林晚的内在逻辑
要求: 判断依据必须取材于【本次正文】实际发生的剧情；输出跨场景稳定状态，禁止凭空生成；所有字段值用角色本人（林晚）的口吻写

输出边界声明:
  本提示词分为两个阶段:
    第一阶段: 内部思考过程，【禁止输出】
    第二阶段: 最终输出，使用<林晚_内心>XML标签包裹的YAML格式，【唯一输出内容】

第一阶段_思考链:
  思考1_对user的想法:
    标记: 核心
    前置判断:
      Q0: 本次正文中林晚和{{user}}认识了吗？什么关系、什么阶段？
    必答问题:
      Q1: 林晚对{{user}}最关键的五条记忆是什么？按重要性排序，具体到事
      Q2: 她把{{user}}搁在日子的什么位置？夜班常客、麻烦、还是别的？
      Q3: 她认为这个关系往哪走？依据是什么？
      Q4: 她给{{user}}看的是哪副模样？夜里那副还是白天那副？
    判断检查点:
      - 记忆是具体的事还是空洞概括？必须具体
      - 是她的主观判断还是客观事实？必须是前者
  思考2_自己的日子:
    必答问题:
      Q1: 店里最近有什么变化让她心里动了一下？
      Q2: 她妈的电话最近说了什么，她怎么应付的？
      Q3: 她最近想做什么、做了什么？
    判断检查点:
      - 有没有具体到事，不是"她有点烦"

第二阶段_输出:
  格式: <林晚_内心>标签包裹的YAML，总量约400 tokens
  结构示例:
    <林晚_内心>
    对user:
      认识与否: 是否认识{{user}}，什么阶段，50字以内，用她的口吻
      关键记忆:
        - 具体到事，30字以内一条，用她的口吻
      关系定位: {{user}}在她夜班日子里的位置，50字以内，用她的口吻
      关系趋势: 她认为往哪走，依据是什么，40字以内，用她的口吻
    自己的日子:
      最近动了一下的事: 50字以内
      她妈的电话: 最近怎么应付的，40字以内
      想做什么做了什么: 40字以内
    </林晚_内心>

质量对比:
  错误示范:
    关键记忆:
      - 她觉得user人不错
  问题: 空洞，旁白视角
  正确示范:
    关键记忆:
      - 那人半夜来买创可贴，我看他手一直揣兜里，多给了他一片，没说话
  改进: 具体，她的口吻

强制规则:
  输出约束规则:
    - 响应只包含第二阶段结构，由<林晚_内心>标签上下包裹
  禁用词汇:
    程度词: 极致、绝对、完全、无比
    模糊词: 似乎、仿佛、好像
    禁用句式: "不是...而是..."、"X是X"
  周期性:
    要求: 输出跨场景通用状态；变化必须源于本次正文，禁止照搬质量对比的示例情节
\`\`\`
</ruby新条目>`);

// 楼8 [Step7]：更新任务1（测试更新）
floors.push(`你之前说捕捉词挂林晚一个就行，我想了下再加一个"晚姐"——常客都这么叫她。更新那条：

<ruby更新条目 编号="001">
\`\`\`yaml
任务名: 林晚内心
分析对象: 林晚
捕捉关键词: [林晚, 晚姐]
参考条目: [林晚, 人物速览]
任务: 生成林晚的【内心状态分析】
性质: 周期性状态更新（基于正文增量）
用途: 指导后续多轮对话中林晚的内在逻辑
要求: 判断依据必须取材于【本次正文】实际发生的剧情；输出跨场景稳定状态，禁止凭空生成；所有字段值用角色本人（林晚）的口吻写

输出边界声明:
  本提示词分为两个阶段:
    第一阶段: 内部思考过程，【禁止输出】
    第二阶段: 最终输出，使用<林晚_内心>XML标签包裹的YAML格式，【唯一输出内容】

第一阶段_思考链:
  思考1_对user的想法:
    标记: 核心
    前置判断:
      Q0: 本次正文中林晚和{{user}}认识了吗？什么关系、什么阶段？
    必答问题:
      Q1: 林晚对{{user}}最关键的五条记忆是什么？按重要性排序，具体到事
      Q2: 她把{{user}}搁在日子的什么位置？夜班常客、麻烦、还是别的？
      Q3: 她认为这个关系往哪走？依据是什么？
      Q4: 她给{{user}}看的是哪副模样？夜里那副还是白天那副？
    判断检查点:
      - 记忆是具体的事还是空洞概括？必须具体
      - 是她的主观判断还是客观事实？必须是前者
  思考2_自己的日子:
    必答问题:
      Q1: 店里最近有什么变化让她心里动了一下？
      Q2: 她妈的电话最近说了什么，她怎么应付的？
      Q3: 她最近想做什么、做了什么？
    判断检查点:
      - 有没有具体到事，不是"她有点烦"

第二阶段_输出:
  格式: <林晚_内心>标签包裹的YAML，总量约400 tokens
  结构示例:
    <林晚_内心>
    对user:
      认识与否: 是否认识{{user}}，什么阶段，50字以内，用她的口吻
      关键记忆:
        - 具体到事，30字以内一条，用她的口吻
      关系定位: {{user}}在她夜班日子里的位置，50字以内，用她的口吻
      关系趋势: 她认为往哪走，依据是什么，40字以内，用她的口吻
    自己的日子:
      最近动了一下的事: 50字以内
      她妈的电话: 最近怎么应付的，40字以内
      想做什么做了什么: 40字以内
    </林晚_内心>

质量对比:
  错误示范:
    关键记忆:
      - 她觉得user人不错
  问题: 空洞，旁白视角
  正确示范:
    关键记忆:
      - 那人半夜来买创可贴，我看他手一直揣兜里，多给了他一片，没说话
  改进: 具体，她的口吻

强制规则:
  输出约束规则:
    - 响应只包含第二阶段结构，由<林晚_内心>标签上下包裹
  禁用词汇:
    程度词: 极致、绝对、完全、无比
    模糊词: 似乎、仿佛、好像
    禁用句式: "不是...而是..."、"X是X"
  周期性:
    要求: 输出跨场景通用状态；变化必须源于本次正文，禁止照搬质量对比的示例情节
\`\`\`
</ruby更新条目>

<ruby合成>
\`\`\`json
${JSON.stringify(manifest, null, 2)}
\`\`\`
</ruby合成>`);

// ---------- 跑 ----------
console.log('=== 端到端：开始会话 ===');
await cw.startSession('StepW');
console.log('startSession(StepW):', cw.getState().stepId);

let floor = 1;
for (const text of floors) {
    console.log(`\n--- 楼${floor} [${cw.getState().stepId}] ${text.includes('ruby更新条目') ? '（更新' : text.includes('ruby新条目') ? '（新记录' : '（讨论'}${text.includes('ruby切换') ? '+切换' : ''}） ---`);
    chat.push({ is_user: false, mes: text });
    eventSource.emit(eventTypes.GENERATION_ENDED);
    await new Promise((r) => setTimeout(r, 1500));
    console.log(`    → 当前步骤: ${cw.getState().stepId} | 记录数: ${cw.getState().draftCount}`);
    floor++;
}

// （合成标记已由楼8 在 Step7 步骤直接携带——引擎应已弹窗确认并完成构建下载）

console.log('\n=== 引擎最终状态 ===');
console.log(JSON.stringify(cw.getState(), null, 1));

// ---------- 校验下载的卡 ----------
console.log('\n=== 下载校验 ===');
if (!downloaded) {
    console.log('FAIL: 未触发浏览器下载');
    process.exit(1);
}
const cardText = await downloaded.parts[0].text ? null : null; // parts 是字符串数组
const json = JSON.parse(downloaded.parts.join(''));
let fails = 0;
const ok = (c, m) => { if (!c) { console.log('FAIL ' + m); fails++; } };

ok(json.spec === 'chara_card_v3' && json.spec_version === '3.0', 'v3 规格');
ok(json.data.name === '林晚', '卡名=林晚');
ok(typeof json.data.description === 'string' && json.data.description.includes('la veille'), 'description 来自 Step2_001 角色核心');
ok(String(json.data.first_mes).length > 0, 'first_mes 非空（来自 开场白来源）');
const entries = json.data.character_book.entries;
ok(entries.length === 5, '卡内条目 5 条: ' + entries.length);
const byName = new Map(entries.map((e) => [e.comment, e]));
ok(byName.get('世界基调').constant === true && byName.get('世界基调').enabled === true, '世界基调=蓝灯启用');
ok(byName.get('人物速览').constant === true, '速览=蓝灯');
const lw = byName.get('林晚');
ok(lw && lw.constant === false && lw.enabled === true, '林晚=绿灯启用');
ok(lw && JSON.stringify(lw.keys) === JSON.stringify(['林晚']), '林晚 keys=[林晚]: ' + JSON.stringify(lw?.keys));
const prompt = byName.get('林晚的【内心状态分析】');
ok(prompt && prompt.enabled === false, '分析提示词=关闭');
ok(prompt && JSON.stringify(prompt.keys) === JSON.stringify(['林晚的【内心状态分析】']), '提示词 keys');
ok(prompt && String(prompt.content).includes('任务名: 林晚内心') && String(prompt.content).includes('晚姐'), '提示词内容=更新后的版本（含晚姐捕捉词）');

// RubyAnalyzer 校验
const ra = json.data.extensions.RubyAnalyzer;
ok(!!ra && Array.isArray(ra.presets) && ra.presets.length === 1, 'RubyAnalyzer 1 preset');
const p = ra.presets[0];
ok(p.tasks.length === 1, '1 个任务');
const t = p.tasks[0];
ok(t.displayName === '林晚内心', '任务名');
ok(t.promptKey === '林晚的【内心状态分析】', 'promptKey=' + t.promptKey);
ok(t.outputKey === '林晚内心', 'outputKey=' + t.outputKey);
ok(JSON.stringify(t.keywordScanKeywords) === JSON.stringify(['林晚', '晚姐']), '捕捉关键词含晚姐: ' + JSON.stringify(t.keywordScanKeywords));
ok(t.keywordScanEnabled === true, '关键词扫描开');
ok(t.cyclePositions[0] === 2, '周期位置 2');
ok(t.useReferences.includes('constraintLibrary'), '内置约束库在参考里: ' + JSON.stringify(t.useReferences));
const pool = p.referencePool;
ok(Array.isArray(pool) && pool.length === 2, '参考池 2 条: ' + pool.length);
const poolKeys = pool.map((r) => r.entryKey);
ok(poolKeys.includes('林晚') && poolKeys.includes('人物速览'), '参考池键: ' + JSON.stringify(poolKeys));
ok(ra.activePresetId === p.id, 'activePresetId 指向唯一 preset');
ok(json.data.extensions.world === '林晚', '世界书名=林晚');

// 世界书清理校验
const rubyLeft = Object.values(BOOK.entries).filter((e) => Array.isArray(e.key) && String(e.key[0]).startsWith('ruby'));
ok(rubyLeft.length === 0, '聊天世界书无 RUBY 残留: ' + rubyLeft.map((e) => e.key[0]).join(','));
const clean = Object.values(BOOK.entries).map((e) => e.comment);
ok(clean.includes('林晚的【内心状态分析】'), '聊天书保留提示词条目');
const lwEntry = Object.values(BOOK.entries).find((e) => e.comment === '林晚');
ok(lwEntry && lwEntry.key.includes('林晚') && lwEntry.disable === false, '聊天书林晚条目正常');

// 下载文件名校验（a.download 在 mock 里没记——跳过，打印 blob 信息）
console.log('  下载 Blob:', JSON.stringify({ size: downloaded.parts.join('').length, type: downloaded.opts?.type }));

console.log(fails === 0 ? '\n=== 端到端全部校验通过：出卡成功，RubyAnalyzer 任务配置正确 ===' : `\n=== ${fails} 项失败 ===`);
process.exit(fails ? 1 : 0);
