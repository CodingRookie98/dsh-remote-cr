const ANCHOR_ID = /^[A-Za-z0-9_-]+$/;
const INSTANCE_NAME = /^[A-Za-z0-9._-]+\.json$/;
/**
 * 从 sync 的 `stagingSuffix`（形如 `.dsh-remote-cr/staging/<anchorId>`）取出 anchor id。
 *
 * 只接受这一种形态：取不到就抛（宁可报错也不猜一个路径去删）。`undefined` 表示「整个 staging」（WSL：
 * 该 distro 下所有 target 共用同一个 staging 目录）。
 */
export function stagingIdOf(stagingSuffix) {
    if (stagingSuffix === undefined)
        return null;
    const match = /^\.dsh-remote-cr\/staging\/([A-Za-z0-9_-]+)$/.exec(stagingSuffix);
    const id = match?.[1];
    if (id === undefined || !ANCHOR_ID.test(id)) {
        throw new Error('stagingSuffix 不是 .dsh-remote-cr/staging/<id> 形态：' + stagingSuffix);
    }
    return id;
}
/**
 * `$HOME` 守卫：没有 HOME（或被设成空/相对）时**直接退出**，别拼出 `/.dsh-remote-cr/...` ——
 * 若远端以 root 跑且该目录存在，那会把删除打到根下（P4 Delta P2）。
 */
function homeGuard() {
    return 'case "$HOME" in /*) ;; *) echo "HOME_INVALID=1"; exit 2 ;; esac';
}
/** 脚本里用的 staging 引用：永远是 `$HOME` 下的绝对路径，id 已校验。 */
/** 注意 `undefined` 也要按「整个 staging」处理：调用方从 env 取不到 id 时就是 undefined。 */
function stagingRef(id) {
    return id === null || id === undefined ? '"$HOME/.dsh-remote-cr/staging"' : '"$HOME/.dsh-remote-cr/staging/' + id + '"';
}
/** 盘点脚本：只读。实例文件原样 `cat` 出来，交给 TS 解析（不在 shell 里猜字段）。 */
export function buildResidueScript(id) {
    return [
        homeGuard(),
        'S=' + stagingRef(id),
        'I="$HOME/.dsh-remote-cr/instances"',
        'echo "STAGING="$S',
        'if [ -d "$S" ]; then echo STAGING_EXISTS=1; du -sk "$S" 2>/dev/null | cut -f1 | sed "s/^/STAGING_KB=/"; else echo STAGING_EXISTS=0; echo STAGING_KB=0; fi',
        'echo "INSTANCES="$I',
        'if [ -d "$I" ]; then',
        '  for f in "$I"/*.json; do',
        '    [ -e "$f" ] || continue',
        '    echo "INSTANCE_BEGIN=$(basename "$f")|$(du -sk "$f" 2>/dev/null | cut -f1)"',
        '    cat "$f" 2>/dev/null',
        '    echo',
        '    echo "INSTANCE_END"',
        '  done',
        'fi',
        'echo DONE=1',
    ].join('\n');
}
/** 判活脚本：pid 由 TS 校验成正整数后才拼进来。`/proc` 优先（权限无关），再退回 kill -0。 */
export function buildLivenessScript(pids) {
    const safe = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
    if (safe.length === 0)
        return 'echo DONE=1';
    return [
        'for p in ' + safe.join(' ') + '; do',
        '  if [ -d "/proc/$p" ] || kill -0 "$p" 2>/dev/null; then echo "ALIVE=$p"; fi',
        'done',
        'echo DONE=1',
    ].join('\n');
}
function values(stdout) {
    const out = new Map();
    for (const line of stdout.split(/\r?\n/)) {
        const at = line.indexOf('=');
        if (at <= 0)
            continue;
        const list = out.get(line.slice(0, at)) ?? [];
        list.push(line.slice(at + 1));
        out.set(line.slice(0, at), list);
    }
    return out;
}
function kbOf(raw) {
    const value = Number.parseInt(raw ?? '0', 10);
    return Number.isFinite(value) && value >= 0 ? value : 0;
}
/** 解析盘点输出。JSON 解析失败或 pid 不可信时 `pid=null`（purge 据此**不删**）。 */
export function parseResidue(stdout, targetId, checkedAt) {
    const lines = stdout.split(/\r?\n/);
    const files = [];
    let stagingPath = '';
    let stagingExists = false;
    let stagingKb = 0;
    let instancesPath = '';
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        if (line.startsWith('STAGING=')) {
            stagingPath = line.slice('STAGING='.length);
            continue;
        }
        if (line.startsWith('INSTANCES=')) {
            instancesPath = line.slice('INSTANCES='.length);
            continue;
        }
        if (line.startsWith('STAGING_EXISTS=')) {
            stagingExists = line.slice('STAGING_EXISTS='.length) === '1';
            continue;
        }
        if (line.startsWith('STAGING_KB=')) {
            stagingKb = kbOf(line.slice('STAGING_KB='.length));
            continue;
        }
        if (!line.startsWith('INSTANCE_BEGIN='))
            continue;
        const header = line.slice('INSTANCE_BEGIN='.length).split('|');
        const name = header[0] ?? '';
        const kb = kbOf(header[1]);
        const body = [];
        for (i += 1; i < lines.length; i += 1) {
            const current = lines[i] ?? '';
            if (current === 'INSTANCE_END')
                break;
            body.push(current);
        }
        if (!INSTANCE_NAME.test(name))
            continue;
        let version = null;
        let pid = null;
        try {
            const parsed = JSON.parse(body.join('\n'));
            if (typeof parsed.version === 'number' && Number.isInteger(parsed.version))
                version = parsed.version;
            if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0)
                pid = parsed.pid;
        }
        catch {
            // 坏 JSON：保留文件但 pid 未知（purge 不会删它）
        }
        files.push({ name, kb, pid, version, alive: false });
    }
    return {
        targetId,
        staging: { path: stagingPath, exists: stagingExists, kb: stagingKb },
        instances: { path: instancesPath, files },
        checkedAt,
    };
}
/** 把 liveness 结果合并进盘点（只认 `ALIVE=<pid>` 行）。 */
export function applyLiveness(report, stdout) {
    const alive = new Set();
    for (const raw of values(stdout).get('ALIVE') ?? []) {
        const pid = Number.parseInt(raw, 10);
        if (Number.isInteger(pid))
            alive.add(pid);
    }
    return {
        ...report,
        instances: {
            ...report.instances,
            files: report.instances.files.map((file) => ({ ...file, alive: file.pid !== null && alive.has(file.pid) })),
        },
    };
}
export function planPurge(report, stagingId = null) {
    // instances 目录是**跨 anchor 共享**的：按本 target 的 id 精确匹配，别去删别台的死登记（RFC D3）。
    // WSL 是 distro 级（id=null），此时才允许清全部死登记。
    const owned = (name) => stagingId === null || stagingId === undefined || name === stagingId + '.json';
    // **有活着的驻留实例时不删 staging**：它的 node/dsh 就在这个目录里，删了进程还在、端口还占着，
    // 但下次接入再也起不来（P4 Delta P1 实测：sleep 的 inode 变成 (deleted)）。
    // 用户要真删，先把那台实例「结束远端」（面板已有入口）。
    const residentAlive = report.instances.files.some((file) => file.alive);
    return {
        removeStaging: report.staging.exists && !residentAlive,
        skipReason: report.staging.exists && residentAlive ? 'resident-alive' : null,
        // 只删「版本认得出、pid 读得出、且确认已死」的登记；其余一律留着（宁可留垃圾，不删活句柄）。
        instances: report.instances.files.filter((file) => owned(file.name) && file.version === 1 && file.pid !== null && !file.alive),
    };
}
/** 清理脚本：逐条看 `rm` 的退出码，失败要能上报（v1 会无条件 echo「已删除」）。 */
export function buildPurgeScript(id, plan) {
    const lines = [homeGuard(), 'S=' + stagingRef(id), 'I="$HOME/.dsh-remote-cr/instances"'];
    if (plan.removeStaging) {
        lines.push('if [ -d "$S" ]; then', '  kb=$(du -sk "$S" 2>/dev/null | cut -f1)', '  if rm -rf "$S"; then echo "REMOVED_STAGING=$S|$kb"; else echo "FAILED_STAGING=$S"; fi', 'fi');
    }
    for (const file of plan.instances) {
        if (!INSTANCE_NAME.test(file.name))
            continue;
        lines.push('if rm -f "$I/' + file.name + '"; then echo "REMOVED_INSTANCE=' + file.name + '|' + String(file.kb) + '"; else echo "FAILED_INSTANCE=' + file.name + '"; fi');
    }
    lines.push('echo DONE=1');
    return lines.join('\n');
}
/** 解析清理输出：`failures` 非空表示「报了成功的地方其实没删掉」。 */
export function parsePurge(stdout) {
    const map = values(stdout);
    const removed = [];
    const failures = [];
    for (const entry of map.get('REMOVED_STAGING') ?? []) {
        const parts = entry.split('|');
        removed.push({ kind: 'staging', path: parts[0] ?? '', kb: kbOf(parts[1]) });
    }
    for (const entry of map.get('REMOVED_INSTANCE') ?? []) {
        const parts = entry.split('|');
        removed.push({ kind: 'instance', path: parts[0] ?? '', kb: kbOf(parts[1]) });
    }
    for (const entry of map.get('FAILED_STAGING') ?? [])
        failures.push('staging:' + entry);
    for (const entry of map.get('FAILED_INSTANCE') ?? [])
        failures.push('instance:' + entry);
    return { removed, freedKb: removed.reduce((sum, item) => sum + item.kb, 0), failures };
}
//# sourceMappingURL=residue.js.map