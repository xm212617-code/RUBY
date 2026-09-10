export function taskPositions(task) {
    if (Array.isArray(task?.cyclePositions) && task.cyclePositions.length > 0) {
        return task.cyclePositions.filter((n) => Number.isFinite(n) && n > 0);
    }
    const pos = task?.cyclePosition || task?.triggerFloor || 0;
    return pos > 0 ? [pos] : [];
}

export function startupPositions(startupTask) {
    if (Array.isArray(startupTask?.cyclePositions) && startupTask.cyclePositions.length > 0) {
        return startupTask.cyclePositions;
    }
    if (Array.isArray(startupTask?.triggerFloors) && startupTask.triggerFloors.length > 0) {
        return startupTask.triggerFloors;
    }
    return [1];
}

export function cycleLength(startupTask, tasks) {
    let max = 0;
    if (startupTask?.enabled) {
        for (const pos of startupPositions(startupTask)) {
            if (pos > max) max = pos;
        }
    }
    for (const task of tasks || []) {
        if (!task?.enabled) continue;
        for (const pos of taskPositions(task)) {
            if (pos > max) max = pos;
        }
    }
    return max;
}

export function positionFor(aiReplyCount, len) {
    if (!len || len <= 0 || aiReplyCount <= 0) return 0;
    return ((aiReplyCount - 1) % len) + 1;
}

/**
 * 任务级角色过滤已移除：该比对拿"当前打开的角色卡名"匹配，容易被误解为正文检索，
 * 且多卡场景毫无必要——配置本身已按角色卡绑定，卡内任务天然只在该卡生效。
 * 函数保留为恒真占位以兼容调用方；导入旧模板携带的 characters 字段在读取时静默丢弃。
 */
export function taskMatchesCharacter() {
    return true;
}

export function collectTasksAtPosition(startupTask, tasks, position, identity) {
    const result = [];
    if (!position || position <= 0) return result;

    if (startupTask?.enabled && taskMatchesCharacter(startupTask, identity)) {
        if (startupPositions(startupTask).includes(position)) {
            result.push({
                type: 'startup',
                config: startupTask,
                displayName: startupTask.displayName || '开局分析',
                triggeredAt: position,
                source: 'auto',
            });
        }
    }

    for (const task of tasks || []) {
        if (!task?.enabled) continue;
        if (!taskMatchesCharacter(task, identity)) continue;
        if (taskPositions(task).includes(position)) {
            result.push({
                type: `task_${task.id}`,
                config: task,
                displayName: task.displayName || `任务#${task.id}`,
                triggeredAt: position,
                source: 'auto',
            });
        }
    }
    return result;
}

export function allEnabledTasks(startupTask, tasks, identity) {
    const list = [];
    if (startupTask?.enabled && taskMatchesCharacter(startupTask, identity)) {
        list.push({ type: 'startup', config: startupTask, displayName: startupTask.displayName || '开局分析' });
    }
    for (const task of tasks || []) {
        if (!task?.enabled) continue;
        if (!taskMatchesCharacter(task, identity)) continue;
        list.push({ type: `task_${task.id}`, config: task, displayName: task.displayName || `任务#${task.id}` });
    }
    return list;
}

export function nextTaskPosition(current, startupTask, tasks, identity) {
    const positions = new Set();
    if (startupTask?.enabled && taskMatchesCharacter(startupTask, identity)) {
        startupPositions(startupTask).forEach((p) => positions.add(p));
    }
    for (const task of tasks || []) {
        if (!task?.enabled || !taskMatchesCharacter(task, identity)) continue;
        taskPositions(task).forEach((p) => positions.add(p));
    }
    const sorted = [...positions].sort((a, b) => a - b);
    for (const pos of sorted) {
        if (pos > current) return pos;
    }
    return sorted.length > 0 ? `${sorted[0]}（下周期）` : '无';
}

export function shouldRunByKeywordScan(taskConfig, scanText) {
    if (!taskConfig?.keywordScanEnabled) return { run: true, keywords: [], matched: [] };
    const keywords = Array.isArray(taskConfig.keywordScanKeywords)
        ? taskConfig.keywordScanKeywords.map((k) => String(k || '').trim()).filter(Boolean)
        : [];
    if (keywords.length === 0) return { run: true, keywords, matched: [] };
    const text = String(scanText || '').toLowerCase();
    const matched = keywords.filter((keyword) => text.includes(keyword.toLowerCase()));
    return { run: matched.length > 0, keywords, matched };
}
