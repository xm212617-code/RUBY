export const ctx = () => window.SillyTavern?.getContext?.() ?? null;

export async function st(command) {
    const c = ctx();
    if (!c || typeof c.executeSlashCommandsWithOptions !== 'function') {
        throw new Error('SillyTavern context unavailable');
    }
    const result = await c.executeSlashCommandsWithOptions(command);
    if (result?.isError) {
        throw new Error(String(result?.errorMessage || `command failed: ${command.slice(0, 100)}`));
    }
    return String(result?.pipe ?? '');
}

export const q = (s) => `"${String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\|/g, '｜')}"`;

export const log = (...args) => console.log('%c[RUBY]', 'color:#2C5530;font-weight:bold', ...args);
export const warn = (...args) => console.warn('[RUBY]', ...args);

export const h = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
