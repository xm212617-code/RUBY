import { ctx, log, warn } from './src/env.js';
import { initEngine, reinit, forceRun, getEngineState } from './src/engine.js';
import { ensureOrb } from './src/orb.js';
import { initSettingsDrawer } from './src/settings.js';
import { openPanel } from './src/panel.js';

let commandRegistered = false;

async function rubyCommandCallback(args, text) {
    const sub = String(text || args?.subcommand || '').trim().toLowerCase() || 'panel';

    try {
        if (sub === 'panel' || sub === 'open') {
            openPanel();
            return 'panel opened';
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
                es.lastError ? `lastError: ${es.lastError}` : null,
            ].filter(Boolean);
            return lines.join(' | ');
        }
        if (sub === 'reload' || sub === 'reinit') {
            reinit();
            return 'engine reloaded';
        }
        if (sub === 'run') {
            const taskArg = args?.task;
            if (args?.startup || String(args?.startup ?? '').toLowerCase() === 'true') {
                return await forceRun('startup');
            }
            if (args?.all) {
                return await forceRun('all');
            }
            const taskId = parseInt(String(taskArg ?? ''), 10);
            if (!Number.isFinite(taskId)) {
                return 'usage: /ruby run task=1 | /ruby run startup=true | /ruby run all=true';
            }
            return await forceRun('task', taskId);
        }
        return 'usage: /ruby [panel | status | run | reload]  (run: task=<id> | startup=true | all=true)';
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
                description: 'task id to force-run',
                typeList: [c.ARGUMENT_TYPE.NUMBER],
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
            helpString: 'RUBY analyzer control: open panel, check status, force-run tasks, reload config.<br>Examples: <code>/ruby panel</code>, <code>/ruby status</code>, <code>/ruby run task=1</code>, <code>/ruby run startup=true</code>, <code>/ruby reload</code>',
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
    ensureOrb();
    initSettingsDrawer();
    log('RUBY Analyzer extension loaded (independent edition)');
}

bootstrap();

window.addEventListener('error', (e) => {
    if (String(e?.filename || '').includes('ruby-analyzer')) {
        warn('uncaught error:', e.message);
    }
});
