// 外部审查器（机械八股清洗，不调用 AI）：
// 内置约束库（builtin-refs.js）在"提示词层"约束 AI 的写法；本模块在"机械层"兜底——
// 对分析管线收到的回复（写入聊天世界书之前）直接识别约束库硬条件八股词，
// 命中即替换为空字符串。词表与约束库的八股词速查一一对应，并包含
// 约束库 <ANTI_ACCOUNT_MONEY> 新增的算账 / 计算 / 砝码 / 金钱类意象禁令。
// 聊天楼层正文不经本模块——分析输入原样阅读，故事文本不做机械改动。

const WORD_GROUPS = [
    { name: '审查词', words: ['共犯'] },
    { name: '模糊词', words: ['似乎', '几乎', '仿佛', '如同', '宛如', '好像', '近乎'] },
    { name: '陈旧比喻', words: [
        '像受惊的小鹿', '投石入湖', '心湖泛起涟漪', '心湖荡漾',
        '像小兽', '像小兔子', '像小猫', '像精灵', '像天使', '像人偶',
        '如春风拂面', '如沐春风',
    ] },
    { name: '过度微表情', words: [
        '嘴角微微上扬', '嘴角勾起弧度', '眼里闪过光芒', '眼中闪过一丝', '手指无意识颤抖',
        '嘴角上扬', '眼眸微动', '眼波流转', '指尖泛白', '睫毛轻颤', '眸光微闪',
    ] },
    { name: '语气声线', words: ['轻声说道', '低声呢喃', '不容置疑', '斩钉截铁地'] },
    { name: '极端程度', words: [
        '从来不曾', '从来不', '从来没',
        '非常', '极其', '彻底', '完全', '绝对', '从不', '总是', '永远', '过度', '极度', '万分', '无比', '深深的', '极是', '极为',
    ] },
    { name: '极端情绪', words: [
        '歇斯底里', '如临大敌', '生无可恋', '万念俱灰',
        '崩溃', '绝望', '狂喜', '恐惧', '幼稚地', '痛苦',
    ] },
    { name: '极端对比', words: ['完全相反', '判若两人', '天差地别', '截然不同'] },
    { name: '情绪标签', words: [
        '她感到', '她内心', '她觉得', '她心想', '他感到', '他内心', '他觉得', '他心想',
        '涌起', '泛起', '下意识', '无意识', '不由自主',
    ] },
    { name: '心理描写', words: ['大段内心活动', '长篇内心独白', '此子绝非常人', '啊你是我的神'] },
    {
        // 约束库 <ANTI_ACCOUNT_MONEY>：算账 / 计算 / 砝码 / 金钱类意象写作全部禁止
        name: '算账·砝码·金钱意象',
        words: [
            // 账目 / 计算类
            '打算盘', '小算盘', '一笔账', '这笔账', '情感账本', '心理账户', '情感账户', '信任账户',
            '算账', '计算', '盘算', '算盘', '账本', '心账', '清算', '核算', '结算', '核账', '对账',
            // 砝码 / 天平类
            '砝码', '天平', '筹码', '加码', '秤砣', '秤杆', '法码',
            // 金钱交易类
            '回报率', '情感成本', '信任成本', '关系成本',
            '成本', '收益', '利息', '利润', '估值', '定价', '抵押', '赤字', '回本', '亏本', '账单', '交易', '买卖',
        ],
    },
];

// 模式类八股（约束库中"XX"通配写法）：整段命中替换为空
const PATTERN_GROUPS = [
    { name: '语气声线', patterns: [
        '带着[^，。！？\\n]{0,8}口吻',
        '用[^，。！？\\n]{0,8}语气',
        '充满[^，。！？\\n]{0,8}味道',
        '声音透着[^，。！？\\n]{0,8}',
    ] },
    { name: '情绪标签', patterns: [
        // 单字动词太易误伤（如"太阳升起"），限定身心容器语境再删
        '(?:心中|心里|心底|心头|眼底|眼里|眼中|胸口|胸间)(?:闪过|掠过|升起|泛起|涌起|浮起)',
    ] },
];

// 否定转折（约束库处理法：只留后半句，删除前半句的否定部分）
//   ✗ 不是权谋手段，是市井直觉 → ✓ 是市井直觉
const KEEP_TAIL_PATTERNS = [
    { name: '否定转折', re: '不是[^，。！？\\n]{1,24}，而是([^，。！？\\n]{1,40})', rep: '$1' },
    { name: '否定转折', re: '不是[^，。！？\\n]{1,24}而是([^，。！？\\n]{1,40})', rep: '$1' },
    { name: '否定转折', re: '不是[^，。！？\\n]{1,24}，是([^，。！？\\n]{1,40})', rep: '是$1' },
    { name: '否定转折', re: '与其说[^，。！？\\n]{1,24}，不如说([^，。！？\\n]{1,40})', rep: '$1' },
    { name: '否定转折', re: '与其说[^，。！？\\n]{1,24}不如说([^，。！？\\n]{1,40})', rep: '$1' },
    { name: '否定转折', re: '并非[^，。！？\\n]{1,24}，?只是([^，。！？\\n]{1,40})', rep: '$1' },
    { name: '否定转折', re: '不是[^，。！？\\n]{1,24}，?倒是([^，。！？\\n]{1,40})', rep: '$1' },
];

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 删词后的边界清理：重复标点收敛、行首残留的孤立标点删除（保留缩进，不动 YAML 结构） */
function tidyAfterSanitize(text) {
    return text
        .replace(/([，。！？、；：])\1+/g, '$1')
        .replace(/^([ \t]*)[，、。！？；：]+/gm, '$1');
}

/**
 * 机械清洗一份收到的回复文本：词表 / 模式命中一律替换为空，否定转折只留后半句。
 * 幂等（删掉的词不会回来），返回 { text, removed: [{ name, count }] }，无命中时 text 原样返回。
 */
export function sanitizeReply(text) {
    const src = String(text ?? '');
    if (!src.trim()) return { text: src, removed: [] };
    let out = src;
    const removed = [];

    for (const g of WORD_GROUPS) {
        if (!g.words.length) continue;
        const source = g.words.slice().sort((a, b) => b.length - a.length).map(escapeRe).join('|');
        const hits = out.match(new RegExp(source, 'g'));
        if (hits && hits.length) {
            removed.push({ name: g.name, count: hits.length });
            out = out.replace(new RegExp(source, 'g'), '');
        }
    }

    for (const g of PATTERN_GROUPS) {
        let count = 0;
        for (const p of g.patterns) {
            const hits = out.match(new RegExp(p, 'g'));
            if (hits && hits.length) {
                count += hits.length;
                out = out.replace(new RegExp(p, 'g'), '');
            }
        }
        if (count) removed.push({ name: g.name, count });
    }

    for (const p of KEEP_TAIL_PATTERNS) {
        const hits = out.match(new RegExp(p.re, 'g'));
        if (hits && hits.length) {
            removed.push({ name: p.name, count: hits.length });
            out = out.replace(new RegExp(p.re, 'g'), p.rep);
        }
    }

    if (removed.length) out = tidyAfterSanitize(out);
    return { text: out, removed };
}

/** 摘要：'模糊词×2, 算账·砝码·金钱意象×1'；无命中返回空串 */
export function summarizeRemoved(removed) {
    return (removed || []).map((r) => `${r.name}×${r.count}`).join(', ');
}
