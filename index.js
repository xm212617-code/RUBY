import { ctx, log, warn, st } from './src/env.js';
import { initEngine, reinit, forceRun, getEngineState } from './src/engine.js';
import { initCardWriter, startSession, endSession, getState as getCwState, composeFromChat } from './src/cardwriter.js';
import { ensureOrb } from './src/orb.js';
import { initSettingsDrawer, initTheme } from './src/settings.js';
import { openPanel } from './src/panel.js';
import * as config from './src/config.js';
import * as worldbook from './src/worldbook.js';

let commandRegistered = false;

async function rubyCommandCallback(args, text) {
    // 子命令判定：无名参形式 /ruby <sub> ...（text 承载），或命名式 /ruby read="..."（text 为空，
    // ST 解析器在无名参之后不再解析命名参数——read 等必须走命名式，args.read 承载键名）。
    // RPC 通道（最稳）：/ruby "RPC~<sub>~key=...~var=...~json=true"——单个带引号无名参，不依赖
    // 命名参数解析；ST 解析器版本差异对其无影响。handler 自拆字段后复用原有取值路径。
    let rawText = String(text || args?.subcommand || '').trim();
    const payloadArgs = {};
    let payloadMode = false;
    if (rawText.startsWith('RPC~')) {
        payloadMode = true;
        const parts = rawText.slice(4).split('~').map((s) => s.trim()).filter(Boolean);
        rawText = '';
        var sub = parts.shift() || '';
        for (const p of parts) {
            const eq = p.indexOf('=');
            if (eq > 0) payloadArgs[p.slice(0, eq)] = p.slice(eq + 1);
            else payloadArgs[p] = 'true';
        }
        args = { ...(args || {}), ...payloadArgs };
    } else {
        var sub = rawText ? rawText.toLowerCase().split(/\s+/)[0] : '';
    }
    if (!sub) {
        for (const k of ['panel', 'open', 'status', 'preset', 'reload', 'reinit', 'run', 'read', 'write', 'cardwriter', 'cw']) {
            if (args?.[k] !== undefined && String(args[k]).trim() !== '') {
                sub = k === 'open' ? 'panel' : k;
                break;
            }
        }
    }
    log(`ruby cmd: sub=${sub} | mode=${payloadMode ? 'RPC' : 'parsed'} | argsKeys=${args && typeof args === 'object' ? Object.keys(args).filter((k) => !k.startsWith('_')).join(',') : '(none)'}`);

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
            if (action === 'compose' || action === 'build') {
                return await composeFromChat();
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
            // 两种调用形式：无名参 /ruby read <关键词>（注意：无名参之后的命名参数会被解析器吞进无名参，
            //   不可靠）与命名式 /ruby read="关键词"（推荐，键在 args.read）。
            const flag = (v) => String(v ?? '').toLowerCase() === 'true' || v === true;
            const positional = rawText.split(/\s+/).slice(1).join(' ').trim();
            const key = String(args?.key ?? args?.read ?? positional).trim();
            const asJson = flag(args?.json);
            const asAll = flag(args?.all);
            const raw = flag(args?.raw);
            const bookRaw = String(args?.book || 'chat').trim();
            const book = bookRaw.toLowerCase();
            try {
                let records;
                if (book === 'char') {
                    records = await worldbook.readCharBookEntries(key, { all: asAll });
                } else if (book === 'chat') {
                    records = await worldbook.readChatBookEntries(key, { all: asAll });
                    if (records.length === 0) {
                        // 回退1：登记簿——管线实际写入的聊天书（部分 ST 版本 /getchatbook 无参不认
                        // create=true 绑定的书名，按登记簿直接点名检索）
                        try {
                            const reg = (config.getGeneratedChatBooks() || [])
                                .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
                            for (const r of reg) {
                                if (!r.chatBookName) continue;
                                records = await worldbook.readBookEntriesByName(r.chatBookName, key, { all: asAll });
                                if (records.length > 0) break;
                            }
                        } catch { /* 登记簿回退失败不影响主流程 */ }
                    }
                    if (records.length === 0) {
                        // 回退2：角色书（防书错位兜底）
                        records = await worldbook.readCharBookEntries(key, { all: asAll });
                    }
                } else {
                    // 任意书名：全局导入的世界书（无需绑定）；书不存在返回 []
                    records = await worldbook.readBookEntriesByName(bookRaw, key, { all: asAll });
                }
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
        if (sub === 'write') {
            // /ruby write key=<关键词> [book=chat|char|<书名>] [var=<变量名>] [content=...] [keys=...] [comment=...] [constant=true|false] [order=N] [depth=N]
            // 消息内 HTML 前端的直写数据通道：不经分析 AI，把整份内容直接写进世界书条目
            //（不存在则创建，默认 @D4/order100/递归双禁；条目存在则只更新内容与状态字段）。
            // 典型用途：装甲叛客战斗结算——前端掷完骰子后把新敌情 YAML 整体覆写，
            // 完整度归零的敌机从内容里删掉即完成「删除」。写完派发 ruby:chatbooks-changed 通知前端重读。
            const flag = (v) => String(v ?? '').toLowerCase() === 'true' || v === true;
            // 键支持两种形式：key="..." 与命名式 write="..."（无名参后的命名参数会被解析器吞进无名参）
            const key = String(args?.key ?? args?.write ?? '').trim();
            if (!key) {
                return 'usage: /ruby write key=<关键词> [book=chat] [var=<变量名>] [content=...] [keys=逗号附加] [comment=...] [constant=true|false] [order=N] [depth=N]';
            }
            const bookRaw = String(args?.book || 'chat').trim();
            const book = bookRaw.toLowerCase();
            try {
                let bookName;
                if (book === 'chat') {
                    // 优先用已绑定的聊天书；未绑定则按 RUBY 输出书命名规则创建
                    bookName = (await worldbook.getExistingChatBookName()) || (await worldbook.getChatBookName());
                } else if (book === 'char') {
                    bookName = await worldbook.getCharBookName();
                } else {
                    bookName = bookRaw;
                }
                if (!bookName) return 'write failed: no world book available';

                // 内容来源：var= 临时变量（推荐，支持多行 YAML）> content= 内联单行
                let content = '';
                const varName = String(args?.var || '').trim();
                if (varName) {
                    content = String(await st(`/getvar ${varName}`) ?? '').trim();
                    // 用完即清，防变量残留
                    try { await st(`/setvar key=${varName} ""`); } catch { /* 清理失败不影响写入 */ }
                } else {
                    content = String(args?.content ?? '');
                }

                const result = await worldbook.writeEntryByKey(bookName, {
                    key,
                    content,
                    keys: String(args?.keys || ''),
                    comment: String(args?.comment || ''),
                    constant: flag(args?.constant),
                    order: parseInt(String(args?.order || '100'), 10) || 100,
                    depth: parseInt(String(args?.depth || '4'), 10) || 4,
                });

                // 与分析管线同款：写完即广播，前端状态栏/敌情面板即时重读
                try {
                    window.dispatchEvent(new CustomEvent('ruby:chatbooks-changed', {
                        detail: { key, keys: [key], source: 'write', book: bookName, uid: result.uid, created: result.created },
                    }));
                } catch { /* 事件失败不影响写入 */ }

                return JSON.stringify({ ok: true, book: bookName, uid: result.uid, created: result.created, key });
            } catch (e) {
                return `write failed: ${e?.message || e}`;
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
            const taskSpec = String(args?.task ?? args?.tasks ?? args?.run ?? '').trim();
            if (!taskSpec) {
                return 'usage: /ruby run task=<id|任务名|关键词>[,...] [json=true] | /ruby run startup=true | /ruby run all=true | /ruby run director=true';
            }
            return format(await forceRun('task', taskSpec));
        }
        return 'usage: /ruby [panel | status | run | reload | preset <名称> | read <关键词> [json=true] [all=true] [book=chat|char|<任意书名>] [raw=true] | write key=<关键词> [book=chat] [var=<变量名>] [content=...] | cw ...]  (run: task=<id> | startup=true | all=true | director=true)';
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
            c.SlashCommandNamedArgument.fromProps({
                name: 'read',
                description: 'named-style subcommand: /ruby read="<entry key>" json=true (named args must come before any unnamed token)',
                typeList: [c.ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
            c.SlashCommandNamedArgument.fromProps({
                name: 'write',
                description: 'named-style subcommand: /ruby write="<entry key>" var=<变量名>',
                typeList: [c.ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
            c.SlashCommandNamedArgument.fromProps({
                name: 'subcommand',
                description: 'unnamed subcommand captured for legacy /ruby <sub> ... form',
                typeList: [c.ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
            c.SlashCommandNamedArgument.fromProps({
                name: 'key',
                description: 'write: entry keyword to create or update',
                typeList: [c.ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
            c.SlashCommandNamedArgument.fromProps({
                name: 'book',
                description: 'write: chat (default) | char | any world book name',
                typeList: [c.ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
            c.SlashCommandNamedArgument.fromProps({
                name: 'var',
                description: 'write: temp variable name holding the content (supports multiline YAML)',
                typeList: [c.ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
            c.SlashCommandNamedArgument.fromProps({
                name: 'content',
                description: 'write: inline single-line content (prefer var= for multiline)',
                typeList: [c.ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
            c.SlashCommandNamedArgument.fromProps({
                name: 'keys',
                description: 'write: comma-separated extra keywords',
                typeList: [c.ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
            c.SlashCommandNamedArgument.fromProps({
                name: 'comment',
                description: 'write: entry comment/title',
                typeList: [c.ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
            c.SlashCommandNamedArgument.fromProps({
                name: 'constant',
                description: 'write: blue light (constant inject), default false',
                typeList: [c.ARGUMENT_TYPE.BOOLEAN],
                isRequired: false,
            }),
            c.SlashCommandNamedArgument.fromProps({
                name: 'order',
                description: 'write: insertion order for new entries, default 100',
                typeList: [c.ARGUMENT_TYPE.NUMBER],
                isRequired: false,
            }),
            c.SlashCommandNamedArgument.fromProps({
                name: 'depth',
                description: 'write: @D depth for new entries, default 4',
                typeList: [c.ARGUMENT_TYPE.NUMBER],
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
            helpString: 'RUBY analyzer control: open panel, check status, force-run tasks, reload config, switch presets, read/write worldbook entries.<br>Examples: <code>/ruby panel</code>, <code>/ruby status</code>, <code>/ruby run task=沛霖内心 json=true</code>, <code>/ruby read 沛霖内心 json=true</code>, <code>/ruby write key=装甲叛客_敌情 var=_rp_content</code>, <code>/ruby reload</code>',
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
