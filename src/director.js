// RUBY 导演模式：高度结构化的周期调度任务。
// 导演AI每周期在位置1运行一次，根据正文/历史/优先级为本周期排出"位置→任务"调度表；
// 引擎按计划在对应位置唤醒普通任务（沿用其完整分析管线），导演排中即跑（忽略关键词扫描）。
import { log, warn } from './env.js';

// ---------- 周期位置计算（纯函数） ----------

/** 启用锚点后的相对回复数（1 = 启用后第一条AI回复 = 周期位置1） */
export function directorRel(aiCount, anchor) {
    return aiCount - anchor;
}

/** AI回复数对应的周期位置（1..cycleLength）；未过锚点返回0 */
export function directorPosition(aiCount, anchor, cycleLength) {
    const rel = directorRel(aiCount, anchor);
    if (rel <= 0 || !cycleLength || cycleLength <= 0) return 0;
    return ((rel - 1) % cycleLength) + 1;
}

/** AI回复数对应的周期轮次（1起） */
export function directorRound(aiCount, anchor, cycleLength) {
    const rel = directorRel(aiCount, anchor);
    if (rel <= 0 || !cycleLength || cycleLength <= 0) return 0;
    return Math.floor((rel - 1) / cycleLength) + 1;
}

// ---------- 任务简介自动提取 ----------
// 创作者未手写简介时，从任务提示词条目内容中捕捉标记词附近约200字作为任务切面简介。

const BRIEF_MARKERS = ['该任务是为了', '任务说明', '任务简介', '任务目标', '任务内容', '本任务'];
const BRIEF_MAX_CHARS = 200;

export function extractTaskBrief(content, maxChars = BRIEF_MAX_CHARS) {
    const text = String(content || '')
        .replace(/```[a-zA-Z]*\n?/g, '')
        .replace(/<\/?[a-zA-Z][^>]*>/g, '')
        .trim();
    if (!text) return '';
    for (const marker of BRIEF_MARKERS) {
        const i = text.indexOf(marker);
        if (i >= 0) {
            const start = Math.max(0, i - 40);
            const slice = text.slice(start, start + maxChars + 40).trim();
            return slice.length > maxChars ? `${slice.slice(0, maxChars)}…` : slice;
        }
    }
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

// ---------- 人物名相似匹配（导演输出用任务名时回退匹配 id） ----------

function normName(s) {
    return String(s || '').toLowerCase().replace(/[\s_-]+/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

function namesSimilar(a, b) {
    const na = normName(a);
    const nb = normName(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.length >= 2 && nb.length >= 2) return na.includes(nb) || nb.includes(na);
    return false;
}

// ---------- 提示词组装 ----------

/**
 * 组装导演提示词（作为单条 user 消息经 buildMessages 注入破限后发送）。
 * @param {object} p
 * @param {{id:number,name:string,priority:number,brief:string}[]} p.tasks 启用任务清单
 * @param {number} p.cycleLength 周期长短
 * @param {number} p.minSpacing 最低间隔（0=AI全权）
 * @param {number} p.round 当前周期轮次
 * @param {{position:number,taskId:number,name:string}[]} p.lastCycle 上周期任务
 * @param {{position:number,taskId:number,name:string}[]} p.woken 本周期已触发
 * @param {{id:number,name:string,cyclesAgo:number}[]} p.overdue 久未触发任务
 * @param {string} p.contextText 正文上下文
 * @param {string[]} p.refSections 参考条目段落
 */
export function buildDirectorPrompt(p) {
    const L = p.cycleLength;
    const lines = [];

    lines.push('【导演任务】你是本卡的剧情导演。职责只有一个：为本周期规划分析任务的触发排期。分析任务本身由系统执行，你只决定"哪个任务排在周期第几次AI回复之后"。');

    lines.push('【任务清单】（id｜名称｜优先级｜简介；优先级数字越大越优先，0为普通）');
    if (p.tasks.length === 0) {
        lines.push('（当前没有可调度的任务）');
    }
    for (const t of p.tasks) {
        lines.push(`task${t.id}｜${t.name}｜优先级${t.priority}${t.brief ? `｜${t.brief}` : '｜（无简介）'}`);
    }

    lines.push('【排期规则】');
    lines.push(`1. 周期长度为 ${L} 次AI回复，位置1是你自己（导演），任务只能排在位置2~${L}。`);
    lines.push('2. 每种任务本周期最多出现一次。');
    lines.push(p.minSpacing > 0
        ? `3. 最低间隔（硬性约束）：相邻两次触发（含你在的位置1）至少间隔 ${p.minSpacing} 次AI回复。`
        : '3. 最低间隔：未设置硬性约束，间隔由你根据剧情节奏决定。');
    lines.push('4. 分步要平均而有间隔，不要把任务堆在周期开头或结尾。');
    lines.push('5. 与本次正文发展相关的任务优先安排；正文多次提及某个角色、而该角色的任务又久未触发时，优先安排该任务。');
    lines.push('6. 优先级数字大的任务在同等条件下更优先考虑。');
    lines.push('7. 不是所有任务都必须排——按剧情需要选择，剧情不需要的周期可以少排或不排。');

    lines.push('【调度参考】');
    lines.push(`当前是第 ${p.round} 周期。`);
    lines.push(`上周期任务：${p.lastCycle.length > 0 ? p.lastCycle.map((a) => `位置${a.position}→${a.name}`).join('；') : '无记录'}`);
    lines.push(`本周期已触发：${p.woken.length > 0 ? p.woken.map((a) => `位置${a.position}→${a.name}`).join('；') : '无（你位于位置1，是本周期第一个动作）'}`);
    lines.push(`久未触发：${p.overdue.length > 0 ? p.overdue.map((t) => `${t.name}（已${t.cyclesAgo}个周期未触发）`).join('；') : '无'}`);

    if (p.contextText) {
        lines.push('【正文上下文】（判断任务与剧情相关性的依据）');
        lines.push(p.contextText);
    }
    if (p.refSections.length > 0) {
        lines.push('【参考条目】（创作者认为对导演重要的世界书内容）');
        lines.push(p.refSections.join('\n\n'));
    }

    lines.push('【输出格式】');
    lines.push('只输出一个yaml代码块，禁止输出yaml之外的任何文字：');
    lines.push('```yaml');
    lines.push('周期安排:');
    lines.push('- 位置: 3');
    lines.push(`  任务: task1`);
    lines.push('- 位置: 7');
    lines.push('  任务: task2');
    lines.push('```');
    lines.push(`要求：位置为2~${L}的整数；任务写任务清单中的task id；按位置从小到大排列；每个任务最多出现一次。`);

    return lines.join('\n\n');
}

// ---------- 输出解析（严格→宽容两级） ----------

function yamlFences(text) {
    return [...String(text || '').matchAll(/```yaml[ \t]*\r?\n([\s\S]*?)```/g)].map((m) => m[1]).filter(Boolean);
}

/**
 * 解析导演调度输出。
 * @returns {{assignments:{position:number,taskId:number}[], retryable:boolean, reason:string}}
 *   retryable=true 表示格式错乱/内容不完整（可自动重试）；assignments 可能为空数组但解析成功。
 */
export function parseDirectorSchedule(text, taskList) {
    const blocks = yamlFences(text);
    if (blocks.length === 0) {
        return { assignments: [], retryable: true, reason: '输出中未找到yaml代码块' };
    }
    const idByName = new Map(taskList.map((t) => [t.id, t.name]));
    const resolveTaskId = (raw) => {
        const s = String(raw || '').trim();
        let m = s.match(/^task\s*(\d+)$/i) || s.match(/task\s*(\d+)/i);
        if (m) return parseInt(m[1], 10);
        // 任务名回退匹配（含id前缀剥离）
        const bare = s.replace(/^task\d+\s*[:：]?\s*/i, '').trim();
        for (const [id, name] of idByName) {
            if (namesSimilar(bare || s, name)) return id;
        }
        return NaN;
    };

    // 严格层：成对的 "位置: N" / "任务: taskM"（或任务名）
    const assignments = [];
    let curPos = NaN;
    for (const block of blocks) {
        for (const line of block.split('\n')) {
            const pm = line.match(/位置\s*[:：]?\s*(\d+)/);
            if (pm) {
                if (Number.isFinite(curPos)) continue; // 上一个位置没有配到任务，等待任务行
                curPos = parseInt(pm[1], 10);
                continue;
            }
            const tm = line.match(/任务\s*[:：]\s*(.+)/);
            if (tm && Number.isFinite(curPos)) {
                const taskId = resolveTaskId(tm[1]);
                if (Number.isFinite(taskId)) assignments.push({ position: curPos, taskId });
                curPos = NaN;
            }
        }
    }
    if (assignments.length > 0) {
        return { assignments, retryable: false, reason: '' };
    }

    // 宽容层：单行形式 "位置3: task1, task5" / "3: task1" / "- 位置3 task1"
    for (const block of blocks) {
        for (const line of block.split('\n')) {
            const m = line.match(/^\s*-?\s*(?:位置\s*)?(\d+)\s*[:：]\s*(.+)/);
            if (!m) continue;
            const pos = parseInt(m[1], 10);
            for (const part of m[2].split(/[,，、\s]+/)) {
                const taskId = resolveTaskId(part);
                if (Number.isFinite(taskId) && Number.isFinite(pos)) assignments.push({ position: pos, taskId });
            }
        }
    }
    if (assignments.length > 0) {
        log(`[director] schedule parsed in lenient mode (${assignments.length} entries)`);
        return { assignments, retryable: false, reason: '' };
    }

    // 显式空计划：周期安排: [] / 无
    const explicitEmpty = blocks.some((b) => /周期安排\s*[:：]\s*(\[\s*\]|无|空)/.test(b));
    if (explicitEmpty) {
        return { assignments: [], retryable: false, reason: '' };
    }
    return { assignments: [], retryable: true, reason: 'yaml中未解析出任何 位置/任务 对' };
}

/**
 * 校验并规范化调度：剔除越界位置/未启用任务，同任务去重（保留最靠前位置），间隔违规仅警告。
 * @returns {{assignments:{position:number,taskId:number}[], warnings:string[], retryable:boolean, reason:string}}
 */
export function validateSchedule(assignments, { cycleLength, minSpacing, taskList }) {
    const enabled = new Map(taskList.map((t) => [t.id, t]));
    const warnings = [];
    const byTask = new Map();
    for (const a of [...assignments].sort((x, y) => x.position - y.position)) {
        const pos = Math.round(Number(a.position));
        const taskId = Math.round(Number(a.taskId));
        if (!Number.isFinite(pos) || pos < 2 || pos > cycleLength) {
            warnings.push(`位置${a.position}越界（合法范围2~${cycleLength}），已剔除`);
            continue;
        }
        if (!enabled.has(taskId)) {
            warnings.push(`task${a.taskId}不在启用任务清单中，已剔除`);
            continue;
        }
        if (byTask.has(taskId)) {
            warnings.push(`task${taskId}出现多次，仅保留最早位置`);
            continue;
        }
        byTask.set(taskId, pos);
    }
    const final = [...byTask.entries()]
        .map(([taskId, position]) => ({ position, taskId }))
        .sort((x, y) => x.position - y.position);

    if (minSpacing > 0 && final.length > 0) {
        const positions = [1, ...final.map((a) => a.position)]; // 位置1是导演自己
        for (let i = 1; i < positions.length; i++) {
            const gap = positions[i] - positions[i - 1];
            if (gap < minSpacing) {
                warnings.push(`位置${positions[i]}与前一触发的间隔为${gap}，低于最低间隔${minSpacing}（按导演输出执行）`);
            }
        }
    }
    return { assignments: final, warnings, retryable: false, reason: '' };
}

// ---------- API 路由 ----------

/**
 * 导演API三选一：'main'=酒馆主API；'analyzer'=RUBY分析API；'custom'=其他API（独立url/key/model）。
 * 返回 ai.callModel 可用的 apiCfg。
 */
export function resolveDirectorApiCfg(apiMode, analyzerApi, customApi) {
    if (apiMode === 'main') return { provider: 'main' };
    if (apiMode === 'custom') {
        const c = customApi || {};
        return { provider: 'custom', url: String(c.url || ''), key: String(c.key || ''), model: String(c.model || ''), stream: true, cache: [] };
    }
    return analyzerApi;
}
