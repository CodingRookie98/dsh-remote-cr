import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
export function writeOptout(file, targets) {
    mkdirSync(dirname(file), { recursive: true });
    const payload = { version: 1, targets: [...new Set(targets)].sort() };
    writeFileSync(file, JSON.stringify(payload, null, 1) + '\n');
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