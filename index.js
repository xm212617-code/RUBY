import { ctx, log, warn } from './src/env.js';
import { initEngine, reinit, forceRun, getEngineState } from './src/engine.js';
import { initCardWriter, startSession, endSession, getState as getCwState } from './src/cardwriter.js';
import { ensureOrb } from './src/orb.js';
import { initSettingsDrawer, initTheme } from './src/settings.js';
import { openPanel } from './src/panel.js';
import * as config from './src/config.js';
import * as worldbook from './src/worldbook.js';

let commandRegistered = false;

async function rubyCommandCallback(args, text) {
    const rawText = String(text || args?.subcommand || '').trim();
    const sub = rawText.toLowerCase().split(/\s+/)[0] || 'panel';

    try {
        if (sub === 'panel' || sub === 'open') {
            openPanel();
            return 'panel opened';
        }
        if (sub === 'cardwriter' || sub === 'cw') {
            const action = String(args?.action || '').trim().toLowerCase();
            if (action === 'start') {
                return await startSession(String(args?.step || 'StepW')) ? 'cardwriter session started' : 'cardwriter session start failed';
            }
            if (action === 'end') {
                return await endSession({ keepDrafts: true }) ? 'cardwriter session ended (drafts kept)' : 'cardwriter session end failed';
            }
            const cw = getCwState();
            if (action === 'status') {
                return `active: ${cw.active} | step: ${cw.stepId || 'none'} | drafts: ${cw.draftCount} | lastAction: ${cw.lastAction || 'none'}${cw.lastError ? ` | error: ${cw.lastError}` : ''}`;
            }
            openPanel('cardwriter');
            return 'cardwriter panel opened';
        }
        if (sub === 'preset') {
            // /ruby preset [名称|id] —— 前端开局选择 HTML 通过 runSlash 调用
            // 切换 activePresetId → 写卡（立即落盘）→ 引擎重武装
            const name = rawText.split(/\s+/).slice(1).join(' ').trim();
            const { data } = config.resolveConfig();
            const presets = Array.isArray(data?.presets) ? data.presets : [];
            if (!presets.length) return 'no presets configured';
            if (!name) {
                return 'presets: ' + presets.map((p) => `${p.name || p.id}${p.id === data.activePresetId ? ' [active]' : ''}`).join(' | ');
            }
            const target = presets.find((p) => p.id === name)
                || presets.find((p) => String(p.name || '') === name)
                || presets.find((p) => String(p.name || '').includes(name) || String(p.id).includes(name));
            if (!target) {
                return `preset not found: ${name} (available: ${presets.map((p) => p.name || p.id).join(', ')})`;
            }

            // 双版本条目组整备：preset 名含 老马版/小马版 后缀时，同步切换世界书条目组
            // （loadWorldInfo 取真实 uid 后逐条 /setentryfield，不做 uid 盲扫、不触发宿主 toastr）
            let versionNote = '';
            const presetName = String(target.name || '');
            if (presetName.includes('老马版') || presetName.includes('小马版')) {
                const suffix = presetName.includes('老马版') ? '老马版' : '小马版';
                try {
                    const charBookName = await worldbook.getCharBookName();
                    if (charBookName) {
                        const stats = await worldbook.setVersionEntryGroups(charBookName, suffix);
                        versionNote = ` | entries: ${suffix} 组已整备（孪生 ${stats.laoCount} 条：启停改动 lao=${stats.changedLao} xiao=${stats.changedXiao}）`;
                    }
                } catch (e) {
                    warn(`version entry groups toggle failed: ${e?.message || e}`);
                }
            }

            if (target.id === data.activePresetId) {
                reinit();
                return `preset already active: ${target.name || target.id}${versionNote} (engine re-armed)`;
            }
            data.activePresetId = target.id;
            config.saveConfigData(data);
            await config.flushCardPersistNow();
            reinit();
            const enabled = (target.tasks || []).filter((t) => t.enabled).length;
            return `preset switched: ${target.name || target.id} | tasks: ${enabled}/${(target.tasks || []).length} enabled${versionNote} | engine re-armed`;
        }
        if (sub === 'read') {
            // /ruby read <关键词> [key=...] [json=true] [all=true] [book=chat|char] [raw=true]
            // 消息内 HTML 前端的只读数据通道：检索世界书条目（RUBY 分析输出/写卡记录/设定），
            // loadWorldInfo 解析真实 uid，零 toastr、零副作用（不创建书、不写条目）。
            // 默认：聊天世界书（RUBY 分析输出所在）、最佳单条、content 经宏替换。
            // book=char 读角色（主）世界书；raw=true 保留 {{user}} 等宏原文；json=true 返回结构化记录。
            const flag = (v) => String(v ?? '').toLowerCase() === 'true' || v === true;
            const positional = rawText.split(/\s+/).slice(1).join(' ').trim();
            const key = String(args?.key ?? positional).trim();
            const asJson = flag(args?.json);
            const asAll = flag(args?.all);
            const raw = flag(args?.raw);
            const book = String(args?.book || 'chat').toLowerCase();
            try {
                const records = book === 'char'
                    ? await worldbook.readCharBookEntries(key, { all: asAll })
                    : await worldbook.readChatBookEntries(key, { all: asAll });
                if (records.length === 0) {
                    return asJson ? '[]' : (key ? `entry not found: ${key}` : 'no worldbook entries');
                }
                if (!raw) {
                    for (const r of records) r.content = worldbook.substitute(r.content);
                }
                if (asJson) {
                    return JSON.stringify(asAll ? records : records[0]);
                }
                return records.map((r) => String(r.content).trim()).filter(Boolean).join('\n\n---\n\n') || '(empty content)';
            } catch (e) {
                return `read failed: ${e?.message || e}`;
            }
        }
        if (sub === 'status') {
            const es = getEngineState();
            const lines = [
                `armed: ${es.armed}`,
                `running: ${es.running}`,
                `layer: ${es.layer}`,
                `character: ${es.charName || 'none'}`,
                `aiReplies: ${es.aiCount}`,
                `cycle: ${es.cycleLength > 0 ? `${es.position}/${es.cycleLength}` : 'not configured'}`,
                `lastRun: ${es.lastRunSummary || 'never'}`,
                es.director?.enabled
                    ? `director: ON round=${es.director.round} pos=${es.director.position}/${es.director.cycleLength} plan=${es.director.planReady ? `${es.director.planCount} tasks` : 'none'}${es.director.lastRunOk === false ? ` (last failed: ${es.director.lastRunReason})` : ''}`
                    : 'director: off',
                es.lastError ? `lastError: ${es.lastError}` : null,
            ].filter(Boolean);
            return lines.join(' | ');
        }
        if (sub === 'reload' || sub === 'reinit') {
            reinit();
            return 'engine reloaded';
        }
        if (sub === 'run') {
            // /ruby run task=<spec> [json=true] —— 手动执行接口（消息内 HTML 按钮的数据通道之一）。
            // spec：任务 id（1）/ displayName / promptKey / outputKey / 捕捉关键词，逗号分隔可批量：
            //   /ruby run task=沛霖内心,沛霖生理 json=true
            // 默认返回文本摘要；json=true 返回 {ok, summary, completed, failed, tasks:[{name, ok, outputKey}]}——
            // 前端拿 tasks[].outputKey 逐个 /ruby read 即可刷新面板。
            // await 到分析完成（AI 生成 + 世界书写入）才返回。
            const flag = (v) => String(v ?? '').toLowerCase() === 'true' || v === true;
            const asJson = flag(args?.json);
            const format = (r) => {
                if (r && typeof r === 'object') return asJson ? JSON.stringify(r) : r.summary;
                return String(r);
            };
            if (args?.startup || flag(args?.startup)) {
                return format(await forceRun('startup'));
            }
            if (args?.all) {
                return format(await forceRun('all'));
            }
            if (args?.director || flag(args?.director)) {
                return format(await forceRun('director'));
            }
            const taskSpec = String(args?.task ?? args?.tasks ?? '').trim();
            if (!taskSpec) {
                return 'usage: /ruby run task=<id|任务名|关键词>[,...] [json=true] | /ruby run startup=true | /ruby run all=true | /ruby run director=true';
            }
            return format(await forceRun('task', taskSpec));
        }
        return 'usage: /ruby [panel | status | run | reload | preset <名称> | read <关键词> [json=true] [all=true] [book=chat|char] [raw=true] | cw ...]  (run: task=<id> | startup=true | all=true | director=true)';
    } catch (e) {
        return `RUBY error: ${e.message}`;
    }
}

function registerRubyCommand() {
    if (commandRegistered) return;
    const c = ctx();
    if (!c?.SlashCommandParser || !c?.SlashCommand) return;

    const namedArgs = [];
    if (c.SlashCommandNamedArgument?.fromProps) {
        namedArgs.push(
            c.SlashCommandNamedArgument.fromProps({
                name: 'task',
                description: 'task to force-run: id, displayName, promptKey, outputKey or scan keyword; comma-separated for multiple',
                typeList: [c.ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
            c.SlashCommandNamedArgument.fromProps({
                name: 'tasks',
                description: 'alias of task',
                typeList: [c.ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
            c.SlashCommandNamedArgument.fromProps({
                name: 'json',
                description: 'return structured JSON result (for HTML frontends)',
                typeList: [c.ARGUMENT_TYPE.BOOLEAN],
                isRequired: false,
            }),
            c.SlashCommandNamedArgument.fromProps({
                name: 'startup',
                description: 'force-run the startup task',
                typeList: [c.ARGUMENT_TYPE.BOOLEAN],
                isRequired: false,
            }),
            c.SlashCommandNamedArgument.fromProps({
                name: 'all',
                description: 'force-run all enabled tasks',
                typeList: [c.ARGUMENT_TYPE.BOOLEAN],
                isRequired: false,
            }),
        );
    }

    let unnamedArgs = [];
    try {
        unnamedArgs = [c.SlashCommandArgument.fromProps({
            description: 'subcommand: panel, status, run, reload',
            typeList: [c.ARGUMENT_TYPE.STRING],
            isRequired: false,
        })];
    } catch {
        unnamedArgs = [];
    }

    try {
        c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
            name: 'ruby',
            returns: 'status text',
            unnamedArgumentList: unnamedArgs,
            namedArgumentList: namedArgs,
            helpString: 'RUBY analyzer control: open panel, check status, force-run tasks, reload config, switch presets, read worldbook entries.<br>Examples: <code>/ruby panel</code>, <code>/ruby status</code>, <code>/ruby run task=沛霖内心 json=true</code>, <code>/ruby read 沛霖内心 json=true</code>, <code>/ruby reload</code>',
            aliases: ['rubyanalyzer'],
            callback: rubyCommandCallback,
        }));
        commandRegistered = true;
        log('slash command /ruby registered');
    } catch (e) {
        warn('slash command registration failed:', e);
    }
}

function bootstrap() {
    if (!window.SillyTavern?.getContext) {
        warn('SillyTavern global not available yet');
        setTimeout(bootstrap, 1000);
        return;
    }
    registerRubyCommand();
    initEngine();
    initCardWriter();
    ensureOrb();
    initSettingsDrawer();
    initTheme();
    log('RUBY Analyzer extension loaded (independent edition)');
}

bootstrap();

window.addEventListener('error', (e) => {
    if (String(e?.filename || '').includes('ruby-analyzer')) {
        warn('uncaught error:', e.message);
    }
});
