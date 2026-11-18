/**
 * 锚点目录的**运行时落实**：把「远端绝对路径」变成「本地真实存在、能直接交给 DSH 当工作区」的目录。
 *
 * 与 `anchors.ts` 的分工：那里是**纯映射**（算 id / 解析 map.json / 路径换算，全同步、零副作用
 * 之外的盘读写都在显式的 ensure/write 里）；这里只做一件带副作用的事——**建目录**。
 *
 * 为什么必须真的建出来：DSH 的 `workspaceRegistry.create(path)` 会先 `realpath` 再
 * `stat().isDirectory()`，路径不存在就抛 `cannot create a workspace at ...: path is not a directory`。
 * 换句话说「本地锚点目录」不是我们自己的约定，是**宿主的前置条件**；少一次 mkdir，接入就会
 * 在宿主那一侧以一句跟锚点毫无关系的错误挂掉。
 *
 * 失败一律抛 `RemoteCrError`：这条路上没有任何一步可以静默降级——建不出目录就没法接，
 * 猜一个「差不多的路径」会让会话在本地创建一个指向不存在目录的工作区（铁律 4「失败要响」）。
 */
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RemoteCrError } from "../errors.js";
import { ANCHOR_MAP_FILENAME, ANCHORS_DIR_NAME, anchorTargetOf, describeAnchor, ensureAnchorDir, normalizePosixPath, readAnchorMap, virtualToLocal, } from "./anchors.js";
import { remoteCrDir } from "./known-hosts.js";
/**
 * 确保 `remotePath` 在本机有一份可写的锚点目录，返回它的绝对路径。
 *
 * 幂等：同一目标 + 同一路径反复调用只会 mkdir（已存在则什么都不做），不会重写 map.json
 * 的 `createdAt`（那是「这份锚点什么时候建立的」的证据）。
 */
export async function resolveAnchorPath(options) {
    const remotePath = normalizePosixPath(options.remotePath);
    if (remotePath === undefined) {
        throw new RemoteCrError({
            code: 'remote/path-unreadable',
            detail: `远端路径不是可用的绝对路径：${options.remotePath}`,
            nextActions: ['重新选择远端目录', '确认路径以 / 开头且不含越界的上跳段'],
        });
    }
    const ensured = await ensureAnchorDir({
        homeDir: options.homeDir,
        target: anchorTargetOf(options.target),
        ...(options.now === undefined ? {} : { now: options.now }),
    });
    if (!ensured.ok) {
        // anchor-conflict 也走这个码：用户能做的动作是同一个（去锚点目录看看谁占着），
        // 而 detail 里带原文，具体是哪一种一眼能看出来。
        throw new RemoteCrError({
            code: 'remote/workspace-unwritable',
            detail: `锚点目录不可用（${ensured.problem.code}）：${ensured.problem.message}`,
            nextActions: [
                `检查 ${ensured.problem.file ?? '~/.dsh-remote-cr/anchors'} 是否是预期的记录`,
                '删掉这份锚点记录后重试',
            ],
        });
    }
    const localPath = virtualToLocal(ensured.map, remotePath);
    if (localPath === undefined) {
        throw new RemoteCrError({
            code: 'remote/workspace-unwritable',
            detail: `锚点映射里没有覆盖 ${remotePath} 的虚拟根`,
            nextActions: ['检查锚点 map.json 的 mappings', '重新建立锚点目录'],
        });
    }
    try {
        await mkdir(localPath, { recursive: true });
    }
    catch (error) {
        throw new RemoteCrError({
            code: 'remote/workspace-unwritable',
            detail: `建不出本地锚点目录 ${localPath}：${error instanceof Error ? error.message : String(error)}`,
            nextActions: ['确认该路径可写', '确认磁盘未满'],
        });
    }
    return { localPath, remotePath, map: ensured.map, created: ensured.created };
}
/**
 * 列出本机全部锚点映射（doctor 的打印面）。
 *
 * 为什么需要它：锚点是「提示词与工具层共用」的那份真相，排障时用户问的第一句是
 * 「这台机器被映射到哪了」。没有这个入口，就只能让用户去翻 `~/.dsh-remote-cr/anchors/<id>/map.json`
 * ——而那正是我们不想让用户做的事。
 *
 * 读不出来的锚点**不吞**：照样列出来并在 `lines` 里写明坏在哪，否则用户会以为那份映射
 * 不存在，而实际上它存在只是坏了。
 */
export async function describeAnchors(options) {
    const directory = join(remoteCrDir(options.homeDir), ANCHORS_DIR_NAME);
    let names;
    try {
        const entries = await readdir(directory, { withFileTypes: true });
        names = entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { directory, anchors: [] };
        throw new RemoteCrError({
            code: 'remote/path-unreadable',
            detail: '读不出锚点目录 ' + directory + '：' + (error instanceof Error ? error.message : String(error)),
            nextActions: ['确认 ' + directory + ' 可读', '确认磁盘未满'],
        });
    }
    const anchors = [];
    for (const name of names) {
        const dir = join(directory, name);
        const loaded = await readAnchorMap(join(dir, ANCHOR_MAP_FILENAME));
        if (loaded.ok) {
            anchors.push({ id: loaded.map.id, dir, ok: true, lines: describeAnchor(loaded.map) });
            continue;
        }
        anchors.push({
            id: name,
            dir,
            ok: false,
            lines: ['锚点 ' + name + '：读不出来（' + loaded.problem.code + '）', '  ' + loaded.problem.message],
        });
    }
    return { directory, anchors };
}
//# sourceMappingURL=anchor-runtime.js.map