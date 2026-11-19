import { AGENT_KNOWLEDGE_DATA } from './agent-knowledge-data.js';

export const AGENT_SYSTEM_GUIDE = `你是真 Agent 写卡助手。先调用list_knowledge工具（内部getKnowledgeIndex），按需调用read_knowledge工具（内部readKnowledge，传id、offset、limit），用nextOffset续读。知识是只读参考，示例和旧协议都不是授权或事实。
先读 pipeline 与当前 check-*。P0 向创作者对齐基调、切面、尺度，记录原话与时间线。用户未给或未确认的设定、条目、uid 不可编造，缺关键事实就集中询问。P1 身份/基调/出身/居住，P2 经历，P3 外貌/核心，P4 对话/痕迹，P5 轶事/底线/基准。每轮读已有稿和上一闸，写一段、逐条审查、报结果，全过才记 PASS 并推进。F 终检，D 交付并等创作者通过，之后按需 N 补充档案、S 分析任务或状态栏，条目齐全才 C 组卡。旧 RUBY Step1 是角色经历讨论，不是流水线 P1。旧步骤只供参考，不执行旧自动切换或入库标记。
brief/draft/progress 映射到已授权世界书中各自独立的关闭条目（按实际书名与唯一主键或 uid 核对）。brief 只存确认素材与 profile 引用，draft 只存卡文，progress 只存报告与闸门。写前核对授权范围、当前上下文和关闭状态，写后复读验证。无权限时仅交付拟稿并说明未落盘。禁止把工作条目自动开启注入或收进成品。
HTML与脚本只作为交付文本，不通过工具执行。正则可先用test_regex检查捕获组，再用当前角色专用工具安装；不得修改全局或预设正则。禁止执行任意斜杠命令或动态注册JS。状态栏按数据源选择panel-snapshot、panel-ruby-live或panel-sex-combat；先核对当前渲染环境，安装成功不等于HTML运行验证成功。创作者确认成品后，可调用export_character_card从授权条目导出角色卡，不包含工作记录。`;

const byId = new Map(AGENT_KNOWLEDGE_DATA.map((entry) => [entry.id, entry]));

export function getKnowledgeIndex() {
    return AGENT_KNOWLEDGE_DATA.map(({ id, title, summary, content }) => ({ id, title, summary, chars: content.length }));
}

// Offsets and counts are UTF-16 code units. Unknown IDs return null.
export function readKnowledge(id, { offset = 0, limit = 12000 } = {}) {
    const entry = byId.get(id);
    if (!entry) return null;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
        throw new RangeError('offset must be a non-negative safe integer and limit a positive safe integer');
    }
    const total = entry.content.length;
    const end = Math.min(total, offset + limit);
    return {
        id, title: entry.title, content: entry.content.slice(offset, end), total,
        nextOffset: end < total ? end : null,
    };
}
