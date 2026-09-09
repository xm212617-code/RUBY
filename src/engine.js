import { ctx, log, warn } from './env.js';
import * as config from './config.js';
import * as scheduler from './scheduler.js';
import * as reader from './reader.js';
import * as worldbook from './worldbook.js';
import * as ai from './ai.js';
import { buildMessages } from './jailbreak.js';

const state = {
    armed: false,
    running: false,
    needTick: false,
    layer: 'unavailable',
    identity: null,
    cycleLength: 0,
    baseline: 0,
    triggered: new Set(),
    lastError: null,
    lastRunAt: null,
    lastRunSummary: '',
};

const listeners = new Set();
let initialized = false;
let tickTimer = null;
const TICK_DELAY_MS = 1200;

export function onStateChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function emitState() {
    for (const fn of listeners) {
        try { fn(getEngineState()); } catch { /* ignore listener errors */ }
    }
}

export function getEngineState() {
    const c = ctx();
    const aiCount = c ? reader.countAiReplies(c.chat) : 0;
    return {
        armed: state.armed,
        running: state.running,
        layer: state.layer,
        cycleLength: state.cycleLength,
        aiCount,
        position: scheduler.positionFor(aiCount, state.cycleLength),
        charName: state.identity?.name || '',
        hasCharacter: !!state.identity,
        lastError: state.lastError,
        lastRunAt: state.lastRunAt,
        lastRunSummary: state.lastRunSummary,
    };
}

function notify(kind, message, options = {}) {
    if (!config.getUi().notify) return;
    const fn = window.toastr?.[kind];
    if (typeof fn === 'function') fn(message, '', { timeOut: 4000, ...options });
}

export function initEngine() {
    if (initialized) return;
    initialized = true;

    const c = ctx();
    if (!c?.eventSource || !c?.eventTypes) {
        warn('event system unavailable, engine not started');
        return;
    }

    c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => {
        setTimeout(reinit, 300);
    });
    c.eventSource.on(c.eventTypes.GENERATION_ENDED, () => {
        scheduleTick();
    });
    c.eventSource.on(c.eventTypes.MESSAGE_RECEIVED, (_messageId, type) => {
        if (type === 'first_message') scheduleTick();
    });
    c.eventSource.on(c.eventTypes.MESSAGE_DELETED, () => {
        setTimeout(() => {
            const cc = ctx();
            if (!cc) return;
            const aiCount = reader.countAiReplies(cc.chat);
            if (aiCount < state.baseline) {
                state.baseline = aiCount;
                log(`baseline resynced down to ${aiCount} after message deletion`);
            }
        }, 300);
    });

    setTimeout(reinit, 1500);
    log('engine initialized, listening to chat events');
}

export function reinit() {
    const c = ctx();
    if (!c) return;
    state.triggered.clear();
    state.lastError = null;

    state.identity = config.getCharacterIdentity();
    if (!state.identity) {
        state.armed = false;
        state.layer = 'unavailable';
        state.cycleLength = 0;
        log('no active character (or group chat), engine standby');
        emitState();
        return;
    }

    const { data, layer } = config.resolveConfig();
    state.layer = layer;
    if (layer !== 'character') {
        state.armed = false;
        state.cycleLength = 0;
        log(`engine standby: config not bound to a character card (layer=${layer}); bind via panel to arm`);
        emitState();
        return;
    }
    const preset = config.getActivePreset(data);
    const len = scheduler.cycleLength(preset.startupTask, preset.tasks);

    if (len <= 0) {
        state.armed = false;
        state.cycleLength = 0;
        log(`engine standby: no enabled tasks for "${state.identity.name}" (layer=${layer})`);
        emitState();
        return;
    }

    state.cycleLength = len;
    state.armed = true;
    state.baseline = reader.countAiReplies(c.chat);
    log(`engine armed | character=${state.identity.name} | layer=${layer} | preset=${preset.name} | cycle=${len} | AI replies=${state.baseline} | position=${scheduler.positionFor(state.baseline, len)}/${len}`);
    emitState();
}

function scheduleTick() {
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = setTimeout(tick, TICK_DELAY_MS);
}

async function tick() {
    if (!state.armed) return;
    if (state.running) {
        state.needTick = true;
        return;
    }
    const c = ctx();
    if (!c) return;

    const aiCount = reader.countAiReplies(c.chat);
    if (aiCount <= state.baseline) return;

    const { data, layer } = config.resolveConfig();
    if (layer !== 'character') {
        state.armed = false;
        state.cycleLength = 0;
        emitState();
        return;
    }
    const preset = config.getActivePreset(data);
    const startupTask = preset.startupTask;
    const tasks = preset.tasks;
    const len = scheduler.cycleLength(startupTask, tasks);
    if (len !== state.cycleLength) {
        state.cycleLength = len;
        log(`cycle length updated to ${len} (config changed)`);
    }
    if (len <= 0) {
        state.armed = false;
        emitState();
        return;
    }
    const from = state.baseline + 1;

    const batch = [];
    for (let cnt = from; cnt <= aiCount; cnt++) {
        const position = scheduler.positionFor(cnt, len);
        const tasksAtPos = scheduler.collectTasksAtPosition(startupTask, tasks, position, state.identity);
        for (const t of tasksAtPos) {
            const cycleRound = Math.ceil(cnt / len);
            const idemKey = `${cycleRound}_${position}_${t.type}`;
            if (state.triggered.has(idemKey)) {
                log(`idempotent skip: ${t.displayName} (round ${cycleRound} position ${position})`);
                continue;
            }
            state.triggered.add(idemKey);
            batch.push({ ...t, sourceFloor: cnt, source: 'auto' });
        }
    }
    state.baseline = aiCount;

    if (batch.length === 0) {
        log(`floor ${aiCount}: no task due (position ${scheduler.positionFor(aiCount, len)}/${len})`);
        return;
    }

    log(`auto trigger at AI reply ${aiCount}: ${batch.map((t) => t.displayName).join(', ')}`);
    await runPipeline(batch);

    if (state.needTick) {
        state.needTick = false;
        scheduleTick();
    }
}

export async function forceRun(kind, taskId) {
    const c = ctx();
    if (!c) throw new Error('SillyTavern context unavailable');
    if (state.running) throw new Error('已有分析任务正在执行中，请稍候');

    state.identity = config.getCharacterIdentity();
    if (!state.identity) throw new Error('请先打开一个角色对话');

    const { data, layer } = config.resolveConfig();
    if (layer !== 'character') throw new Error('当前配置未绑定角色卡：请先在面板中绑定到当前角色卡');
    const preset = config.getActivePreset(data);
    const aiCount = reader.countAiReplies(c.chat);
    const len = scheduler.cycleLength(preset.startupTask, preset.tasks) || 1;

    let batch = [];
    if (kind === 'startup') {
        if (!preset.startupTask?.enabled) throw new Error('开局任务未启用');
        batch = [{
            type: 'startup',
            config: preset.startupTask,
            displayName: preset.startupTask.displayName || '开局分析',
            triggeredAt: scheduler.positionFor(aiCount, len),
            sourceFloor: aiCount,
            source: 'force',
        }];
    } else if (kind === 'task') {
        const task = preset.tasks.find((t) => t.id === taskId && t.enabled);
        if (!task) throw new Error(`未找到启用的任务 #${taskId}`);
        batch = [{
            type: `task_${task.id}`,
            config: task,
            displayName: task.displayName || `任务#${task.id}`,
            triggeredAt: scheduler.positionFor(aiCount, len),
            sourceFloor: aiCount,
            source: 'force',
        }];
    } else if (kind === 'all') {
        batch = scheduler.allEnabledTasks(preset.startupTask, preset.tasks, state.identity)
            .map((t) => ({ ...t, triggeredAt: scheduler.positionFor(aiCount, len), sourceFloor: aiCount, source: 'force' }));
        if (batch.length === 0) throw new Error('没有已启用的任务');
    } else {
        throw new Error(`unknown forceRun kind: ${kind}`);
    }

    await runPipeline(batch);
    return `${batch.map((t) => t.displayName).join(', ')} 执行完毕`;
}

export async function runPipeline(taskBatch) {
    if (!taskBatch || taskBatch.length === 0) return;

    const c = ctx();
    const chatIdAtStart = c.getCurrentChatId?.();
    const characterIdAtStart = c.characterId;

    const { data: cfgData } = config.resolveConfig();
    const preset = config.getActivePreset(cfgData);
    const startupTask = preset.startupTask;
    const tasks = preset.tasks;
    const referencePool = preset.referencePool;
    // 生成参数默认不启用：未开启时传空对象，主API沿用酒馆预设采样、自定义端点沿用服务商默认
    const genParams = cfgData.gen?.enabled === true ? cfgData.gen : {};
    const customTags = cfgData.customContentTags || [];
    const charName = cfgData.charName || c.name2 || c.characters?.[c.characterId]?.name || '角色';
    const apiCfg = config.getApiConfig();

    state.running = true;
    emitState();

    let completedCount = 0;
    let failedCount = 0;

    try {
        const charBook = await worldbook.getCharBookName();
        const chatBook = await worldbook.getChatBookName();
        if (!charBook) {
            warn('character world book not found');
            notify('warning', 'RUBY：未找到角色世界书，无法执行分析');
            return;
        }
        log(`pipeline start | char book=${charBook} | chat book=${chatBook || '无'} | tasks=${taskBatch.length}`);

        const referenceValues = {};
        for (const ref of referencePool) {
            if (!ref.entryKey || !ref.varName) continue;
            const content = await worldbook.readEntry(charBook, chatBook, ref.entryKey, true);
            referenceValues[ref.varName] = content;
            if (content) log(`reference loaded: ${ref.varName}`);
        }

        const outputValues = {};
        if (startupTask?.outputKey) {
            outputValues.startupOutput = await worldbook.readEntry(charBook, chatBook, startupTask.outputKey, true);
        }
        for (const task of tasks) {
            if (task.outputKey) {
                const varName = task.outputVarName || `task_${task.id}_Output`;
                outputValues[varName] = await worldbook.readEntry(charBook, chatBook, task.outputKey, true);
            }
        }

        for (let taskIndex = 0; taskIndex < taskBatch.length; taskIndex++) {
            const current = taskBatch[taskIndex];
            const taskConfig = current.config;
            const taskKey = current.type;
            const taskDisplayName = current.displayName;

            try {
                if (c.getCurrentChatId?.() !== chatIdAtStart || c.characterId !== characterIdAtStart) {
                    warn('chat or character changed during pipeline, aborting remaining tasks');
                    return;
                }

                log(`task ${taskIndex + 1}/${taskBatch.length}: ${taskDisplayName} (${current.source})`);

                let inc = reader.incrementalRead(taskKey, customTags);
                log(`incremental read: floors ${inc.startFloor}-${inc.endFloor} (${inc.count} floors, ${(inc.text || '').length} chars)`);

                if (inc.count === 0 || !inc.text) {
                    if (current.source === 'force') {
                        reader.resetBookmark(taskKey);
                        inc = reader.incrementalRead(taskKey, customTags);
                        log(`force run: bookmark reset, re-reading ${inc.count} floors`);
                        if (inc.count === 0 || !inc.text) {
                            warn(`skip ${taskDisplayName}: no readable text in chat`);
                            continue;
                        }
                    } else {
                        log(`skip ${taskDisplayName}: no new floors (bookmark at ${inc.endFloor})`);
                        continue;
                    }
                }

                // 关键词扫描作用于完整增量正文（含将被截断的尾部），
                // 防止截断机制吞掉最新楼层里的触发关键词
                const keywordScan = current.source === 'force'
                    ? { run: true, keywords: [], matched: [] }
                    : scheduler.shouldRunByKeywordScan(taskConfig, inc.text);
                if (!keywordScan.run) {
                    log(`skip ${taskDisplayName}: keywords not matched in floors ${inc.startFloor}-${inc.endFloor} (${keywordScan.keywords.join(', ')}), bookmark held for rescan`);
                    continue;
                }
                if (taskConfig?.keywordScanEnabled && keywordScan.matched.length > 0) {
                    log(`keyword scan hit: ${keywordScan.matched.join(', ')}`);
                }

                // 20万字符上限：只截断对话正文（保留靠前部分、抛弃后续剩余正文）。
                // 参考条目池与历史分析输出在下方组装阶段追加，从不参与此上限，绝不因截断丢失。
                const capped = reader.capText(inc.text);
                if (capped.truncated > 0) {
                    warn(`body exceeds ${reader.MAX_INPUT_CHARS} chars: ${inc.text.length} chars, discarding last ${capped.truncated} chars of chat text (references unaffected)`);
                    inc.text = capped.text;
                    inc.truncatedChars = capped.truncated;
                    notify('warning', `RUBY：${taskDisplayName} 正文超过20万字符上限，末尾 ${capped.truncated} 字符已截断抛弃`);
                }

                const promptKey = taskConfig.promptKey;
                if (!promptKey) {
                    warn(`task ${taskDisplayName}: no prompt entry configured`);
                    failedCount++;
                    continue;
                }
                let promptTemplate = await worldbook.readEntry(charBook, chatBook, promptKey, false);
                if (!promptTemplate) {
                    warn(`prompt entry not found: ${promptKey}`);
                    notify('error', `RUBY：未找到提示词条目 ${promptKey}`);
                    failedCount++;
                    continue;
                }

                const variables = {
                    CHAR_NAME: charName,
                    recentMessages: inc.text,
                };
                const useRefs = Array.isArray(taskConfig.useReferences) ? taskConfig.useReferences : [];
                for (const varName of useRefs) {
                    if (referenceValues[varName] !== undefined) variables[varName] = referenceValues[varName];
                }
                const useOutputs = Array.isArray(taskConfig.useOutputs) ? taskConfig.useOutputs : [];
                for (const varName of useOutputs) {
                    if (outputValues[varName] !== undefined) variables[varName] = outputValues[varName];
                }

                const hasRecentMessagesPlaceholder = promptTemplate.includes('{{recentMessages}}');
                const bodySections = [];
                const refSections = [];

                if (!hasRecentMessagesPlaceholder && inc.text) {
                    const truncNote = inc.truncatedChars
                        ? `\n\n（⚠️ 本次正文超过20万字符上限，末尾约 ${inc.truncatedChars} 字符已被截断抛弃，仅上方保留部分为有效分析素材）`
                        : '';
                    bodySections.push(`【本次正文（增量，第${inc.startFloor}楼至第${inc.endFloor}楼，共${inc.count}楼${inc.truncatedChars ? '，已截断' : ''}）】\n${inc.text}${truncNote}\n\n（硬性约束：分析输出必须取材于上方正文的实际剧情；后文任务指令中的"示范/示例"仅用于说明格式与颗粒度，禁止把示例中的具体部位、项目、情节、数值当作分析结果输出）`);
                }

                for (const varName of useRefs) {
                    const content = variables[varName];
                    if (content && content !== '（未设定）') {
                        const refConfig = referencePool.find((r) => r.varName === varName);
                        const displayLabel = refConfig?.label || refConfig?.entryKey || varName;
                        refSections.push(`【${displayLabel}】\n${content}`);
                    }
                }

                for (const varName of useOutputs) {
                    const content = variables[varName];
                    if (content && content !== '（未设定）') {
                        let displayLabel = varName;
                        if (varName === 'startupOutput') {
                            displayLabel = startupTask.displayName || '开局分析结果';
                        } else {
                            const taskMatch = varName.match(/^task_(\d+)_Output$/);
                            if (taskMatch) {
                                const taskDef = tasks.find((t) => t.id === parseInt(taskMatch[1], 10));
                                displayLabel = taskDef?.displayName || `任务#${taskMatch[1]}结果`;
                            }
                        }
                        refSections.push(`【${displayLabel}】\n${content}`);
                    }
                }

                const assembledParts = [];
                if (bodySections.length > 0) assembledParts.push(bodySections.join('\n\n'));
                if (refSections.length > 0) {
                    assembledParts.push(`【历史分析参考（需根据上方正文更新，勿照搬）】\n${refSections.join('\n\n')}`);
                }
                if (assembledParts.length > 0) {
                    promptTemplate = `${assembledParts.join('\n\n')}\n\n[任务指令]\n${promptTemplate}`;
                    log(`prompt assembled: body(${inc.count} floors, ${(inc.text || '').length} chars) + refs(${refSections.length})`);
                }

                for (const [key, value] of Object.entries(variables)) {
                    const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
                    promptTemplate = promptTemplate.replace(regex, value || '（未设定）');
                }

                notify('info', `🔄 ${taskDisplayName} 分析中... (${taskIndex + 1}/${taskBatch.length})`, { timeOut: 3000 });
                const messages = buildMessages(taskDisplayName, promptTemplate, cfgData);
                const result = await ai.callModel({ apiCfg, genParams, messages, taskLabel: taskDisplayName });

                if (!result || result.trim().length < 2) {
                    warn(`${taskDisplayName}: result empty or too short`);
                    notify('error', `${taskDisplayName}分析失败：内容过短`);
                    failedCount++;
                    continue;
                }
                log(`generation done: ${result.length} chars`);

                if (c.getCurrentChatId?.() !== chatIdAtStart || c.characterId !== characterIdAtStart) {
                    warn(`${taskDisplayName}: chat changed during generation, result discarded`);
                    return;
                }

                const outputKey = taskConfig.outputKey;
                const outputVarName = taskConfig.outputVarName || (taskKey === 'startup' ? 'startupOutput' : `task_${taskConfig.id}_Output`);

                if (!outputKey) {
                    log(`${taskDisplayName}: no output entry configured, result kept in memory only`);
                    outputValues[outputVarName] = result.trim();
                    reader.saveBookmark(taskKey, inc.endFloor);
                    completedCount++;
                    continue;
                }

                if (!chatBook) {
                    warn('chat world book not found');
                    failedCount++;
                    continue;
                }

                await worldbook.writeOutputEntry(chatBook, {
                    key: outputKey,
                    extraKeys: taskConfig.extraKeys,
                    content: result,
                    constant: !!taskConfig.outputConstant,
                    disable: !!taskConfig.outputDisable,
                    noRecursion: !!taskConfig.noRecursion,
                    position: taskConfig.position ?? 0,
                    depth: taskConfig.depth ?? 4,
                    order: taskConfig.order ?? 100,
                    selective: !!taskConfig.selective,
                    selectiveKeys: taskConfig.selectiveKeys,
                });

                await worldbook.disableCharEntry(charBook, outputKey);
                outputValues[outputVarName] = result.trim();
                reader.saveBookmark(taskKey, inc.endFloor);
                completedCount++;
                log(`✅ ${taskDisplayName} done (bookmark at floor ${inc.endFloor})`);

            } catch (taskErr) {
                warn(`task ${taskDisplayName} failed: ${taskErr.message}`);
                notify('error', `${taskDisplayName} 失败: ${taskErr.message}`, { timeOut: 6000 });
                failedCount++;
            }
        }

        if (completedCount > 0 && chatBook) {
            await worldbook.persistBook(chatBook);
        }

        state.lastRunAt = Date.now();
        state.lastRunSummary = `${completedCount}/${taskBatch.length} 成功${failedCount > 0 ? `，${failedCount} 失败` : ''}`;

        if (taskBatch.length > 1) {
            if (failedCount === 0) notify('success', `✅ 全部 ${completedCount} 个任务完成`);
            else notify('warning', `⚠️ ${completedCount} 个成功, ${failedCount} 个失败`);
        } else if (completedCount > 0) {
            notify('success', `✅ ${taskBatch[0]?.displayName || '任务'} 完成`);
        }
        log(`pipeline finished: ${state.lastRunSummary}`);
    } catch (err) {
        state.lastError = err?.message || String(err);
        warn(`pipeline error: ${state.lastError}`, err?.stack);
        notify('error', `RUBY分析失败: ${state.lastError}`, { timeOut: 8000 });
    } finally {
        state.running = false;
        emitState();
    }
}
