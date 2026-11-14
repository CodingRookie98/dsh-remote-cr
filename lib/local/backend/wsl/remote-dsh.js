/**
 * 远端 `dsh` 的**纯解析**层：从日志里认出「它起来了」还是「它为什么没起来」。
 *
 * 这一层不 spawn、不 sleep，只做文本 → 结构化事实，所以能在任何机器上单测。
 * 所有正则的根据都来自真机日志（原文见 `spikes/m1/p32-launch/README.md`）：
 *
 * - 成功：`dsh web: http://127.0.0.1:8899/?token=<token>`
 * - 端口占用：`Error: listen EADDRINUSE: address already in use 127.0.0.1:8899`
 *   （外层还有 `dsh: startup failed: 2 required plugins did not activate`）
 * - 无 node：`nohup: failed to run command 'node': No such file or directory`
 */
import { TeleportError, portInUseError } from "../errors.js";
const URL_LINE = /dsh web:\s+(https?:\/\/[^\s]+)/;
const EADDRINUSE = /EADDRINUSE: address already in use (\S+):(\d+)/;
/**
 * 「找不到可执行文件」有两种真实形态，都要认：
 * - `--exec` 直派：`WSL (172982 - Relay) ERROR: CreateProcessCommon:875: execvpe(node-missing-teleport) failed: No such file or directory`
 * - 经 shell + nohup：`nohup: failed to run command 'node': No such file or directory`
 * 两种都是真机实测输出（前者见 P32-6 首跑失败、后者见 T6-3），不能只认一种。
 */
const NO_SUCH_COMMAND = /execvpe\(([^)]+)\) failed: No such file or directory|failed to run command '([^']+)': No such file or directory/;
const STARTUP_FAILED = /startup failed:\s*(.+)/;
/**
 * 从日志全文里找 dsh 自己打印的访问 URL。
 * 找不到返回 `undefined` —— 调用方据此判定「还在启动」或「启动失败」，不猜。
 */
export function parseDshEndpoint(logText) {
    const match = URL_LINE.exec(logText);
    if (match === null)
        return undefined;
    const raw = match[1];
    if (raw === undefined)
        return undefined;
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        return undefined;
    }
    const token = url.searchParams.get('token');
    if (token === null || token === '')
        return undefined;
    const port = Number.parseInt(url.port, 10);
    if (!Number.isInteger(port) || port <= 0)
        return undefined;
    return { host: url.hostname, port, token };
}
/** 取日志最后 `lines` 行，供「复制日志」使用。 */
export function tailLines(logText, lines = 40) {
    const all = logText.split('\n').filter((line) => line.trim() !== '');
    return all.slice(Math.max(0, all.length - lines)).join('\n');
}
/** 把失败日志拆成可判定的结构化事实；认不出的部分留空，不臆造。 */
export function readStartFailure(logText) {
    const facts = {};
    const busy = EADDRINUSE.exec(logText);
    if (busy !== null) {
        const port = Number.parseInt(busy[2] ?? '', 10);
        if (Number.isInteger(port) && port > 0) {
            facts.portInUse = { host: busy[1] ?? '127.0.0.1', port };
        }
    }
    const missing = NO_SUCH_COMMAND.exec(logText);
    if (missing !== null) {
        const command = missing[1] ?? missing[2];
        if (command !== undefined && command !== '')
            facts.missingCommand = command;
    }
    const failed = STARTUP_FAILED.exec(logText);
    if (failed !== null && failed[1] !== undefined)
        facts.startupFailed = failed[1].trim();
    return facts;
}
/**
 * 启动失败的分类：把日志事实翻成**用户能照着做**的结构化错误。
 *
 * 顺序有讲究——先判最具体的原因（端口占用、缺 node），再落到泛化的 startup-failed，
 * 否则所有失败都会被「2 required plugins did not activate」这层包装吞掉，用户拿不到
 * 「是端口被占了」这种能立刻动手的信息（铁律 4「失败要响」）。
 */
export function classifyStartFailure(logText) {
    const facts = readStartFailure(logText);
    const tail = tailLines(logText);
    if (facts.portInUse !== undefined) {
        return portInUseError(facts.portInUse.port, tail);
    }
    if (facts.missingCommand !== undefined) {
        return new TeleportError({
            code: 'remote/node-missing',
            detail: `远端找不到可执行文件 ${facts.missingCommand}`,
            nextActions: ['安装 Node 22+ 到远端', '或用引导器安装远端运行时后重试'],
            logTail: tail,
        });
    }
    if (facts.startupFailed !== undefined) {
        return new TeleportError({
            code: 'remote/startup-failed',
            detail: `远端 dsh 启动失败：${facts.startupFailed}`,
            nextActions: ['查看完整日志确认哪个插件没起来', '重试', '换个远端目录作为 DSH_HOME'],
            logTail: tail,
        });
    }
    return new TeleportError({
        code: 'remote/startup-failed',
        detail: '远端 dsh 没有打印访问 URL，也没有给出可识别的原因',
        nextActions: ['查看完整日志', '重试'],
        logTail: tail,
    });
}
//# sourceMappingURL=remote-dsh.js.map