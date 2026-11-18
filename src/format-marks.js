// Pure format-mark placement. Legacy marks retain line-based candidate priority.
export function resolveMarkVars(tag, vars, phaseOverride) {
    return String(tag || '').replace(/\{\{var:([^}]+)\}\}/g, (_, name) => {
        if (phaseOverride !== undefined && phaseOverride !== null && String(name).trim() === '_ruby_phase') {
            return String(phaseOverride);
        }
        const value = vars ? vars[String(name).trim()] : undefined;
        return value === undefined || value === null ? '' : String(value);
    });
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findAnchorLine(lines, relAnchor) {
    const candidates = String(relAnchor || '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const candidate of candidates) {
        const pattern = new RegExp(`<\\/?${escapeRegExp(candidate)}[\\s>/]`, 'i');
        for (let index = 0; index < lines.length; index++) {
            if (pattern.test(lines[index])) return index;
        }
    }
    return -1;
}

// Offsets are UTF-16 string offsets, immediately before/after the matched tag.
// Unlike the legacy line finder, precise candidates select the earliest match.
export function findAnchorOffset(text, relAnchor, { boundary = 'close', side = 'after' } = {}) {
    const candidates = String(relAnchor || '').split(',').map((s) => s.trim()).filter(Boolean);
    let first = null;
    for (const candidate of candidates) {
        const name = escapeRegExp(candidate);
        const pattern = boundary === 'close'
            ? new RegExp(`<\\/\\s*${name}\\s*>`, 'i')
            : new RegExp(`<\\/?${name}(?=[\\s>/])(?:[^>"']|"[^"]*"|'[^']*')*>`, 'i');
        const match = pattern.exec(text);
        if (match && (!first || match.index < first.index)) first = match;
    }
    if (!first) return -1;
    return first.index + (side === 'before' ? 0 : first[0].length);
}

export function applyFormatMarks(mes, marks, vars, phaseOverride) {
    const list = Array.isArray(marks) ? marks : [];
    const resolved = list
        .map((mark) => ({ ...mark, value: `<${resolveMarkVars(mark.tag, vars, phaseOverride)}>` }))
        .filter((mark) => mark.value !== '<>');
    if (!resolved.length) return { mes, tags: [] };

    // Keep the original line-splice semantics, including same-line ordering and blank lines.
    if (!resolved.some((mark) => mark.relBoundary === 'close')) {
        const lines = mes.split('\n');
        const inserts = [];
        const head = [];
        const tail = [];
        const tags = [];
        for (const mark of resolved) {
            const line = mark.relAnchor ? findAnchorLine(lines, mark.relAnchor) : -1;
            if (line >= 0) {
                inserts.push({ at: mark.relSide === 'after' ? line + 1 : line, value: mark.value });
            } else {
                if (mark.relAnchor && mark.relMissing === 'skip') continue;
                (mark.position === 'tail' ? tail : head).push(mark.value);
            }
            tags.push(mark.value);
        }
        inserts.sort((a, b) => b.at - a.at);
        for (const insert of inserts) lines.splice(insert.at, 0, insert.value);
        let out = lines.join('\n');
        if (head.length) out = `${head.join('\n')}\n${out}`;
        if (tail.length) out = `${out}\n${tail.join('\n')}`;
        return { mes: out, tags };
    }

    const lines = mes.split('\n');
    const starts = [0];
    for (let index = 0; index < lines.length - 1; index++) {
        starts.push(starts[index] + lines[index].length + 1);
    }
    const inserts = new Map();
    const fallbackHead = [];
    const fallbackTail = [];
    const tags = [];
    const newline = mes.includes('\r\n') ? '\r\n' : '\n';
    for (const mark of resolved) {
        if (mark.relAnchor) {
            const precise = mark.relBoundary === 'close';
            const line = precise ? -1 : findAnchorLine(lines, mark.relAnchor);
            const at = precise
                ? findAnchorOffset(mes, mark.relAnchor, { boundary: 'close', side: mark.relSide === 'after' ? 'after' : 'before' })
                : (line < 0 ? -1 : (mark.relSide === 'after' ? (starts[line + 1] ?? mes.length) : starts[line]));
            if (at >= 0) {
                const entry = inserts.get(at) || { values: [], prefix: '', suffix: '', newline: precise ? newline : '\n' };
                // Preserve the legacy splice order for several marks on one line.
                if (precise) entry.values.push(mark.value);
                else entry.values.unshift(mark.value);
                if (precise) {
                    if (at > 0 && mes[at - 1] !== '\n') entry.prefix = newline;
                    if (at < mes.length && mes[at] !== '\n' && mes.slice(at, at + 2) !== '\r\n') entry.suffix = newline;
                } else if (mark.relSide === 'after' && line === lines.length - 1) {
                    entry.prefix = '\n';
                } else {
                    entry.suffix = '\n';
                }
                inserts.set(at, entry);
                tags.push(mark.value);
                continue;
            }
            if (mark.relMissing === 'skip') continue;
        }
        (mark.position === 'tail' ? fallbackTail : fallbackHead).push(mark.value);
        tags.push(mark.value);
    }
    let out = mes;
    for (const [at, entry] of [...inserts].sort(([a], [b]) => b - a)) {
        out = out.slice(0, at) + entry.prefix + entry.values.join(entry.newline) + entry.suffix + out.slice(at);
    }
    if (fallbackHead.length) out = `${fallbackHead.join('\n')}\n${out}`;
    if (fallbackTail.length) out = `${out}\n${fallbackTail.join('\n')}`;
    return { mes: out, tags };
}
