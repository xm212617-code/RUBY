const scripts = new Map();

export function registerCardScript(script) {
    if (!script || !/^[a-z][a-z0-9-]{1,63}$/.test(String(script.id || ''))) {
        throw new TypeError('card script id must be a stable lowercase identifier');
    }
    if (typeof script.render !== 'function') throw new TypeError(`card script ${script.id} requires a UI renderer`);
    if (scripts.has(script.id)) throw new Error(`card script already registered: ${script.id}`);
    scripts.set(script.id, Object.freeze({
        id: script.id,
        name: String(script.name || script.id),
        description: String(script.description || ''),
        render: script.render,
    }));
}

export function getCardScripts() {
    return [...scripts.values()].map(({ id, name, description }) => ({ id, name, description }));
}

export function getCardScript(id) {
    return scripts.get(String(id || '')) || null;
}
