import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export function readOptout(file) {
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (!Array.isArray(parsed.targets))
            return [];
        return parsed.targets.filter((item) => typeof item === 'string' && item !== '');
    }
    catch {
        return [];
    }
}
/**
 * 原子写：先写同目录临时文件再 rename（R1-S10）。
 *
 * 直接 `writeFileSync` 有截断窗口：两个面板并发写会丢 target，读侧在窗口内读到空文件还会
 * 静默当「没有任何静音」，表现为「不再提醒」自己失效。rename 在同一目录内是原子的。
 */
export function writeOptout(file, targets) {
    mkdirSync(dirname(file), { recursive: true });
    const payload = { version: 1, targets: [...new Set(targets)].sort() };
    const temp = file + '.tmp';
    try {
        writeFileSync(temp, JSON.stringify(payload, null, 1) + '\n');
        renameSync(temp, file);
    }
    catch (error) {
        // 失败时别留临时文件：下次读侧看到它只会更困惑。
        rmSync(temp, { force: true });
        throw error;
    }
}
/** 增删一个 target 的静音状态，返回最新列表。 */
export function setMuted(file, targetId, muted) {
    const current = readOptout(file);
    const next = muted ? [...current, targetId] : current.filter((item) => item !== targetId);
    writeOptout(file, next);
    return readOptout(file);
}
/** 文件是否存在（供诊断/doctor 用）。 */
export function optoutExists(file) {
    return existsSync(file);
}
//# sourceMappingURL=optout.js.map