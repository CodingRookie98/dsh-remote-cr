/**
 * 锚点工作区 + 虚拟根映射（M2 的 SSH 身份方案）。
 *
 * 为什么需要这一层：DSH 的 workspaceRegistry 要求工作区是本机**真实存在的目录**
 * （create() 先 realpath 再 stat().isDirectory()，见 docs/design/architecture.md §4.1）。
 * 远端路径在本地文件系统里不存在，所以 SSH 后端必须在本地造一个**锚点目录**顶着工作区身份；
 * 但这样一来 session.header.cwd 就变成盘符路径（C:/Users/hui/.dsh-teleport/anchors/<id>/...），
 * 而模型要的是**远端**路径（/home/hui/workspace）。UNC 后端靠「share 根就是 POSIX 根」白拿了这个等价
 * （见 ui-design.md §9.1 V15），锚点后端没有这种运气（/etc/hostname 会被解析成 C:/etc/hostname），
 * 所以必须有一张显式的映射表，并且**提示词投影与工具层读同一张表**——两处各写一份就是两份真相。
 *
 * 三条设计上的硬决定：
 *
 * 1. **虚拟路径 ≡ 远端绝对路径**（默认 / → /）。锚点目录只是远端树的本地影子，虚拟路径不是另一套
 *    命名空间。这样模型看到的路径、工具层发给远端的目标、锚点里的落盘位置三者可直接换算，
 *    不会出现「提示词说 /home/x，工具却读 /x」对不上。
 * 2. **按路径段做最长前缀匹配**，不做字符串前缀：/a/bc 不能被 /a/b 命中。
 * 3. **上跳段（点点）一律拒绝越界**。锚点目录是模型可写的地方，跑出锚点就能顺着它摸到整块磁盘——
 *    这个方向必须堵死，代价是调用方拿到 undefined 而不是一个「差不多能读」的路径。
 *
 * 落盘位置：~/.dsh-teleport/anchors/<sha256("user@host:port") 前 16 位>/map.json。
 * hash 里带端口：同一台机器的 2222 与 22 常常是两台不同的机器（本机 config 就有这种形态）。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { TELEPORT_DIR_NAME, teleportDir } from "./known-hosts.js";
export const ANCHORS_DIR_NAME = 'anchors';
export const ANCHOR_MAP_FILENAME = 'map.json';
export const ANCHOR_MAP_VERSION = 1;
export function anchorTargetOf(target) {
    const descriptor = {
        user: target.user,
        host: target.hostName,
        port: target.port,
    };
    if (target.alias !== undefined && target.alias !== '')
        descriptor.alias = target.alias;
    return descriptor;
}
/**
 * 锚点 id：sha256("user@host:port") 的前 16 个十六进制字符。
 *
 * 没写 User 时用固定占位符而不是「本机当前用户」：后者会让同一份 config 在不同机器上
 * 生成不同锚点目录，映射表跟着漂移。
 */
export function anchorIdFor(target) {
    const key = (target.user ?? '(default)') + '@' + target.host + ':' + String(target.port);
    return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
}
export function anchorDirFor(homeDir, target) {
    return join(teleportDir(homeDir), ANCHORS_DIR_NAME, anchorIdFor(target));
}
export function anchorMapPath(anchorDir) {
    return join(anchorDir, ANCHOR_MAP_FILENAME);
}
/** 把反斜杠折成正斜杠并去掉尾部分隔符；用于本地路径比较，不改盘上真实写法。 */
export function normalizeLocalPath(value) {
    const slashed = value.split(String.fromCharCode(92)).join(fwdSlash);
    if (slashed === '/')
        return '/';
    let end = slashed.length;
    while (end > 1 && slashed.charAt(end - 1) === fwdSlash)
        end -= 1;
    return slashed.slice(0, end);
}
const fwdSlash = String.fromCharCode(47);
/**
 * 按路径段做词法规范化，并拒绝越界。
 *
 * /a/./b/../c → /a/c；/.. 与 /a/../../b → undefined（跑出根就是越界，不做「夹到 /」的宽松处理）。
 * 非绝对路径同样返回 undefined：这一层只接受绝对路径，相对路径该由 path.resolve 在锚点 cwd 上解决，
 * 混进来只会让两处判定分叉。
 */
export function normalizePosixPath(value) {
    if (!value.startsWith('/'))
        return undefined;
    const stack = [];
    for (const segment of value.split('/')) {
        if (segment === '' || segment === '.')
            continue;
        if (segment === '..') {
            if (stack.length === 0)
                return undefined;
            stack.pop();
            continue;
        }
        stack.push(segment);
    }
    return '/' + stack.join('/');
}
function isSegmentPrefix(prefix, path) {
    if (prefix === '/')
        return true;
    if (path === prefix)
        return true;
    return path.startsWith(prefix + '/');
}
/** 最长虚拟根优先；同长度按书写顺序先到先得。 */
function hitMapping(map, virtualPath) {
    let best;
    for (const mapping of map.mappings) {
        if (!isSegmentPrefix(mapping.virtualRoot, virtualPath))
            continue;
        const relative = mapping.virtualRoot === '/' ? virtualPath.slice(1) : virtualPath.slice(mapping.virtualRoot.length + 1);
        if (best !== undefined && mapping.virtualRoot.length <= best.mapping.virtualRoot.length)
            continue;
        best = { mapping, relative };
    }
    return best;
}
/** 虚拟路径 → 远端绝对路径（工具层发出去的目标）。 */
export function virtualToRemote(map, virtualPath) {
    const normalized = normalizePosixPath(virtualPath);
    if (normalized === undefined)
        return undefined;
    const hit = hitMapping(map, normalized);
    if (hit === undefined)
        return undefined;
    const root = normalizePosixPath(hit.mapping.remoteRoot);
    if (root === undefined)
        return undefined;
    if (hit.relative === '')
        return root;
    return root === '/' ? '/' + hit.relative : root + '/' + hit.relative;
}
/** 虚拟路径 → 本地锚点里的落盘路径（工作区身份与 ctx.fs 用的那一侧）。 */
export function virtualToLocal(map, virtualPath) {
    const normalized = normalizePosixPath(virtualPath);
    if (normalized === undefined)
        return undefined;
    if (hitMapping(map, normalized) === undefined)
        return undefined;
    const anchorDir = normalizeLocalPath(map.anchorDir);
    return normalized === '/' ? anchorDir : anchorDir + normalized;
}
/** 本地锚点路径 → 虚拟路径（提示词投影用：把锚点里的 /home/hui/w 折回 /home/hui/w）。 */
export function localToVirtual(map, localPath) {
    const anchorDir = normalizeLocalPath(map.anchorDir);
    const target = normalizeLocalPath(localPath);
    if (target === anchorDir)
        return '/';
    if (!target.startsWith(anchorDir + '/'))
        return undefined;
    const virtual = normalizePosixPath(target.slice(anchorDir.length));
    if (virtual === undefined)
        return undefined;
    if (hitMapping(map, virtual) === undefined)
        return undefined;
    return virtual;
}
/** 本地锚点路径 → 远端绝对路径（工具层一次性换算）。 */
export function localToRemote(map, localPath) {
    const virtual = localToVirtual(map, localPath);
    if (virtual === undefined)
        return undefined;
    return virtualToRemote(map, virtual);
}
/**
 * 提示词投影器：喂给 system-prompt 投影层，把锚点里的本地 cwd 折成远端路径。
 *
 * 工具层用 localToRemote，提示词用这一条——两者读同一张 map，这就是「一份映射两处共用」的落点。
 */
export function anchorPathProjector(map) {
    return (localPath) => localToVirtual(map, localPath);
}
/** 默认映射：虚拟根就是远端根。 */
export function defaultAnchorMap(options) {
    const id = anchorIdFor(options.target);
    return {
        version: ANCHOR_MAP_VERSION,
        id,
        target: options.target,
        anchorDir: anchorDirFor(options.homeDir, options.target),
        createdAt: (options.now ?? new Date()).toISOString(),
        mappings: [{ virtualRoot: '/', remoteRoot: '/' }],
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function readTarget(value) {
    if (!isRecord(value))
        return undefined;
    const user = value['user'];
    const host = value['host'];
    const port = value['port'];
    if (user !== undefined && (typeof user !== 'string' || user === ''))
        return undefined;
    if (typeof host !== 'string' || host === '')
        return undefined;
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535)
        return undefined;
    const alias = value['alias'];
    const target = { user, host, port };
    if (typeof alias === 'string' && alias !== '')
        target.alias = alias;
    return target;
}
function readMappings(value) {
    if (!Array.isArray(value) || value.length === 0)
        return undefined;
    const mappings = [];
    for (const item of value) {
        if (!isRecord(item))
            return undefined;
        const virtualRoot = item['virtualRoot'];
        const remoteRoot = item['remoteRoot'];
        if (typeof virtualRoot !== 'string' || typeof remoteRoot !== 'string')
            return undefined;
        const virtual = normalizePosixPath(virtualRoot);
        const remote = normalizePosixPath(remoteRoot);
        if (virtual === undefined || remote === undefined)
            return undefined;
        mappings.push({ virtualRoot: virtual, remoteRoot: remote });
    }
    return mappings;
}
/** 校验一份未知 JSON 是否是本版本的锚点记录；不认识就明确说「不认识」，不猜。 */
export function parseAnchorMap(value, file) {
    const fail = (code, message) => {
        const problem = { code, message };
        if (file !== undefined)
            problem.file = file;
        return { ok: false, problem };
    };
    if (!isRecord(value))
        return fail('map-invalid', '锚点映射不是对象');
    const version = value['version'];
    if (version !== ANCHOR_MAP_VERSION) {
        return fail('map-unsupported-version', '锚点映射版本是 ' + String(version) + '，本版本只认 ' + String(ANCHOR_MAP_VERSION));
    }
    const id = value['id'];
    const anchorDir = value['anchorDir'];
    const createdAt = value['createdAt'];
    const target = readTarget(value['target']);
    const mappings = readMappings(value['mappings']);
    if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id))
        return fail('map-invalid', '锚点 id 不是 16 位十六进制');
    if (typeof anchorDir !== 'string' || anchorDir === '')
        return fail('map-invalid', '锚点目录缺失');
    if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt)))
        return fail('map-invalid', 'createdAt 不是可用时间');
    if (target === undefined)
        return fail('map-invalid', '目标信息不完整（user/host/port）');
    if (mappings === undefined)
        return fail('map-invalid', '映射表为空或含非绝对路径');
    if (anchorIdFor(target) !== id)
        return fail('map-invalid', '锚点 id 与目标不一致（记录被改过）');
    return { ok: true, map: { version: ANCHOR_MAP_VERSION, id, target, anchorDir, createdAt, mappings } };
}
export async function readAnchorMap(file) {
    let text;
    try {
        text = await readFile(file, 'utf8');
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT') {
            return { ok: false, problem: { code: 'map-unreadable', message: '锚点映射文件不存在', file } };
        }
        return {
            ok: false,
            problem: { code: 'map-unreadable', message: '读不到锚点映射文件：' + String(error.message ?? error), file },
        };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        return {
            ok: false,
            problem: { code: 'map-corrupted', message: '锚点映射文件不是合法 JSON：' + String(error.message ?? error), file },
        };
    }
    return parseAnchorMap(parsed, file);
}
/** 临时文件 + rename：中途崩掉不会留下半份映射表。 */
export async function writeAnchorMap(file, map) {
    await mkdir(dirname(file), { recursive: true });
    const body = JSON.stringify(map, null, 2) + String.fromCharCode(10);
    const temp = file + '.tmp-' + String(process.pid);
    await writeFile(temp, body, 'utf8');
    await rename(temp, file);
}
function sameTarget(left, right) {
    return left.user === right.user && left.host === right.host && left.port === right.port;
}
/**
 * 建锚点目录并落 map.json；已存在且指向同一目标就复用。
 *
 * 指向**不同**目标时返回 anchor-conflict 且一个字节都不改：id 是 hash，撞上的概率可以忽略，
 * 真撞上说明记录被手工改过——这时候静默改写，等于把另一个会话的工作区身份换掉。
 */
export async function ensureAnchorDir(options) {
    const dir = anchorDirFor(options.homeDir, options.target);
    const file = anchorMapPath(dir);
    const existing = await readAnchorMap(file);
    if (existing.ok) {
        if (!sameTarget(existing.map.target, options.target) || existing.map.id !== anchorIdFor(options.target)) {
            return {
                ok: false,
                problem: {
                    code: 'anchor-conflict',
                    message: '锚点目录已记录另一台机器（' +
                        (existing.map.target.user ?? '(默认用户)') +
                        '@' +
                        existing.map.target.host +
                        ':' +
                        String(existing.map.target.port) +
                        '），拒绝覆盖',
                    file,
                },
            };
        }
        return { ok: true, map: existing.map, dir: existing.map.anchorDir, file, created: false };
    }
    if (existing.problem.code !== 'map-unreadable') {
        return { ok: false, problem: existing.problem };
    }
    const map = defaultAnchorMap(options);
    await writeAnchorMap(file, map);
    return { ok: true, map, dir, file, created: true };
}
/**
 * doctor 输出：一段人能读的锚点摘要。
 *
 * 之所以由本模块生成而不是面板自己拼：映射表是「提示词与工具层共用」的那一份真相，
 * 排障时必须打印同一份数据，而不是另写一套解读。
 */
export function describeAnchor(map) {
    const target = map.target;
    const label = (target.user ?? '(默认用户)') + '@' + target.host + ':' + String(target.port);
    const alias = target.alias === undefined ? '' : '（' + target.alias + '）';
    const lines = [
        '锚点 ' + map.id + '：' + label + alias,
        '  目录：' + normalizeLocalPath(map.anchorDir),
        '  建立：' + map.createdAt,
    ];
    for (const mapping of map.mappings) {
        lines.push('  映射：' + mapping.virtualRoot + ' → ' + mapping.remoteRoot);
    }
    return lines;
}
export { TELEPORT_DIR_NAME };
//# sourceMappingURL=anchors.js.map