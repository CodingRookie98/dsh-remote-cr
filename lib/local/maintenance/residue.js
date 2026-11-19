/**
 * 远端残留的**只读盘点**与显式清理（RFC-0006 Phase 2）。
 *
 * 纪律（与 RFC 的 D1–D4 一一对应）：
 * - 只碰两类路径：本 target 的 `~/.dsh-remote-cr/staging/<hash>`、`~/.dsh-remote-cr/instances/*.json`；
 * - purge 必须先有 `confirm`，且只在**没有连接**该 target 时执行；
 * - instances 只删「登记里的 pid 已经不在了」的那些：活着的实例是驻留模式的资产，不是垃圾。
 *
 * 这一层不碰连接与 HTTP：脚本与解析都是纯函数，路由只负责取 exec 与拼信封。
 */
import { posix } from 'node:path';
import { shellQuote } from "../backend/posix-probe.js";
/** 盘点脚本：只读（`du`/`sed`/`kill -0`），不写任何东西。 */
export function buildResidueScript(homeDir, stagingSuffix) {
    const root = posix.join(homeDir, '.dsh-remote-cr');
    const staging = stagingSuffix === undefined ? posix.join(root, 'staging') : posix.join(root, 'staging', stagingSuffix);
    const instances = posix.join(root, 'instances');
    return [
        'S=' + shellQuote(staging),
        'I=' + shellQuote(instances),
        'echo "STAGING="$S',
        'if [ -d "$S" ]; then echo STAGING_EXISTS=1; du -sk "$S" 2>/dev/null | cut -f1 | sed "s/^/STAGING_KB=/"; else echo STAGING_EXISTS=0; echo STAGING_KB=0; fi',
        'echo "INSTANCES="$I',
        'if [ -d "$I" ]; then',
        '  for f in "$I"/*.json; do',
        '    [ -e "$f" ] || continue',
        '    name=$(basename "$f")',
        '    kb=$(du -sk "$f" 2>/dev/null | cut -f1)',
        '    pid=$(sed -n "s/.*\"pid\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\\1/p" "$f" | head -n1)',
        '    alive=0',
        '    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then alive=1; fi',
        '    echo "INSTANCE=$name|$kb|$pid|$alive"',
        '  done',
        'fi',
        'echo DONE=1',
    ].join('\n');
}
function values(stdout) {
    const out = new Map();
    for (const line of stdout.split(/\r?\n/)) {
        const at = line.indexOf('=');
        if (at <= 0)
            continue;
        const key = line.slice(0, at);
        const value = line.slice(at + 1);
        const list = out.get(key) ?? [];
        list.push(value);
        out.set(key, list);
    }
    return out;
}
function first(map, key) {
    return map.get(key)?.[0];
}
function kbOf(raw) {
    const value = Number.parseInt(raw ?? '0', 10);
    return Number.isFinite(value) && value >= 0 ? value : 0;
}
/** 解析盘点输出。认不出的行跳过而不是编造（与 attach 的解析同一套纪律）。 */
export function parseResidue(stdout, targetId, checkedAt) {
    const map = values(stdout);
    const files = [];
    for (const entry of map.get('INSTANCE') ?? []) {
        const parts = entry.split('|');
        const name = parts[0] ?? '';
        if (name === '')
            continue;
        const pidText = parts[2] ?? '';
        const pid = pidText === '' ? null : Number.parseInt(pidText, 10);
        files.push({
            name,
            kb: kbOf(parts[1]),
            pid: pid !== null && Number.isFinite(pid) ? pid : null,
            alive: parts[3] === '1',
        });
    }
    return {
        targetId,
        staging: {
            path: first(map, 'STAGING') ?? '',
            exists: first(map, 'STAGING_EXISTS') === '1',
            kb: kbOf(first(map, 'STAGING_KB')),
        },
        instances: { path: first(map, 'INSTANCES') ?? '', files },
        checkedAt,
    };
}
/** 清理脚本：删 staging 目录 + 只删「pid 已死」的实例登记。 */
export function buildPurgeScript(homeDir, stagingSuffix) {
    const root = posix.join(homeDir, '.dsh-remote-cr');
    const staging = stagingSuffix === undefined ? posix.join(root, 'staging') : posix.join(root, 'staging', stagingSuffix);
    const instances = posix.join(root, 'instances');
    return [
        'S=' + shellQuote(staging),
        'I=' + shellQuote(instances),
        'if [ -d "$S" ]; then kb=$(du -sk "$S" 2>/dev/null | cut -f1); rm -rf "$S"; echo "REMOVED_STAGING=$S|$kb"; fi',
        'if [ -d "$I" ]; then',
        '  for f in "$I"/*.json; do',
        '    [ -e "$f" ] || continue',
        '    pid=$(sed -n "s/.*\"pid\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\\1/p" "$f" | head -n1)',
        '    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then continue; fi',
        '    kb=$(du -sk "$f" 2>/dev/null | cut -f1)',
        '    name=$(basename "$f")',
        '    rm -f "$f"',
        '    echo "REMOVED_INSTANCE=$name|$kb"',
        '  done',
        'fi',
        'echo DONE=1',
    ].join('\n');
}
/** 解析清理输出：返回被删的路径与释放的 KB（心跳不算，只统计真实删除）。 */
export function parsePurge(stdout) {
    const map = values(stdout);
    const removed = [];
    for (const entry of map.get('REMOVED_STAGING') ?? []) {
        const parts = entry.split('|');
        removed.push({ kind: 'staging', path: parts[0] ?? '', kb: kbOf(parts[1]) });
    }
    for (const entry of map.get('REMOVED_INSTANCE') ?? []) {
        const parts = entry.split('|');
        removed.push({ kind: 'instance', path: parts[0] ?? '', kb: kbOf(parts[1]) });
    }
    const freedKb = removed.reduce((sum, item) => sum + item.kb, 0);
    return { removed, freedKb };
}
//# sourceMappingURL=residue.js.map