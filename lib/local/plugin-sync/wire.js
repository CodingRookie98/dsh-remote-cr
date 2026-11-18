import { join } from 'node:path';
import { RemoteCrError } from "../backend/errors.js";
import { anchorIdFor, anchorTargetOf } from "../backend/ssh/anchors.js";
import { readSshConfig, resolveSshTarget } from "../backend/ssh/config.js";
import { knownHostsPath } from "../backend/ssh/known-hosts.js";
import { runSsh } from "../backend/ssh/transport.js";
import { dshSupported } from "../backend/ssh/bootstrap.js";
import { runInDistroChecked } from "../backend/wsl/exec.js";
import { DSH_CLI_RELATIVE } from "./read.js";
/** deadline 到点会杀掉句柄（distro 侧进程随之回收）；把这件事写进 stderr 尾巴，上层判读。 */
export const WSL_TIMEOUT_MARK = 'REMOTE_CR_TIMEOUT';
/**
 * WSL 侧单次 exec 的**最短**存活时长（地板）。
 *
 * 真机 2026-11-18（ubuntu_dev）：distro 冷启动后的一次读取要 **18.3 s**，热态只要 0.27 s；
 * 而读取的默认 deadline 是 20 s —— 冷启动只剩 1.7 s 余量，第一次点「同步」很容易死在冷启动上。
 * 地板只抬下限、不压上限：apply 传 180 s 仍是 180 s。
 */
export const WSL_MIN_EXEC_MS = 45_000;
/**
 * 默认执行面：`runInDistroChecked` 的结果摊平（诊断单独带上来）。
 *
 * 导出并留 `checked` 注入缝，是为了让「诊断真的被挂上」这件事**有执行级用例**——
 * 否则把这里换回 `runInDistro`（修复前那一行）全量测试照样全绿（Delta 复审 BLK-1）。
 */
export async function defaultWslRun(executable, distro, command, options, checked = runInDistroChecked) {
    const result = await checked(executable, distro, command, options);
    return { ...result.result, diagnosis: result.diagnosis };
}
/** 拼远端 POSIX 路径：win32 的 `join` 会产出反斜杠，远端当转义吃掉。 */
function posixJoin(root, relative) {
    return root.replace(/\/+$/, '') + '/' + relative;
}
/** 默认解析：读 ~/.ssh/config，把别名换成 OpenSSH 的解析结果（HostName/User/Port）。 */
function defaultResolveTarget(homeDir, alias) {
    const file = join(homeDir, '.ssh', 'config');
    const config = readSshConfig({ file, homeDir });
    return resolveSshTarget(config.parsed, alias, { file, homeDir }).target;
}
function shellQuote(value) {
    return "'" + value.split("'").join("'\\''") + "'";
}
export function createSyncRoutesOptions(options) {
    const profile = options.profile ?? 'web';
    const runner = options.runSsh ?? runSsh;
    return {
        profile,
        optoutFile: join(options.homeDir, '.dsh-remote-cr', 'sync-optout.json'),
        localProfileDir: join(options.homeDir, '.dsh', 'profiles', profile),
        async targetId(target) {
            // SSH：与 anchors / 隔离目录同一个 id（host+user+port 的 hash），避免「同机不同用户」互相静音
            // 发行版名大小写不敏感（`wsl.exe -d` 如此），静音粒度必须跟着不敏感，否则 `wsl:Ubuntu`
            // 与 `wsl:ubuntu` 会是两个 targetId：静音记不住，并发锁也挡不住（同一 distro 两路 pnpm 互踩）。
            if (target.backend !== 'ssh')
                return 'wsl:' + target.distro.toLowerCase();
            const resolveTarget = options.resolveTarget ?? ((alias) => defaultResolveTarget(options.homeDir, alias));
            const sshTarget = resolveTarget(target.alias);
            if (sshTarget === undefined) {
                throw new RemoteCrError({
                    code: 'remote/unknown',
                    detail: '~/.ssh/config 里找不到主机 ' + target.alias,
                    nextActions: ['在 ~/.ssh/config 里补一个 Host 块后重试'],
                });
            }
            return anchorIdFor(anchorTargetOf(sshTarget));
        },
        async resolve(target) {
            if (target.backend === 'wsl') {
                const run = options.runInDistro ?? defaultWslRun;
                const executable = options.wslExecutable ?? 'wsl.exe';
                return {
                    exec: async (script, deadlineMs) => {
                        // 脚本原样交给 `--exec`（见文件头第 2 点）；timeoutMs 就是「握着句柄的时长」。
                        const result = await run(executable, target.distro, ['sh', '-c', script], {
                            timeoutMs: Math.max(deadlineMs ?? WSL_MIN_EXEC_MS, WSL_MIN_EXEC_MS),
                        });
                        const timedOut = result.timedOut === true;
                        const diagnosis = result.diagnosis ?? null;
                        const log = [];
                        if (result.stderrText.trim() !== '')
                            log.push(result.stderrText.trim());
                        // `wsl.exe` 起不来的报错在 stdout（UTF-16LE），UTF-8 解是乱码 —— 用结构化诊断顶上，
                        // 否则 read-failed / apply-failed 只剩「退出码 1」和一条空 logTail（铁律 4）。
                        if (diagnosis !== null) {
                            log.push(diagnosis.detail);
                            if (diagnosis.logTail !== undefined && diagnosis.logTail.trim() !== '')
                                log.push(diagnosis.logTail.trim());
                        }
                        if (timedOut)
                            log.push(WSL_TIMEOUT_MARK);
                        return {
                            // 超时一律记 124：Windows 上 `child.kill()` 常回 exitCode 1 甚至 0，
                            // 只看 exitCode 会把「被杀」记成成功（半装当成功是最坏的形状）。
                            code: timedOut ? 124 : result.exitCode ?? 1,
                            stdout: result.stdoutText,
                            stderr: log.join('\n'),
                        };
                    },
                    // 真实路径由读取脚本回报（runtime），这里只是兜底：WSL 的 dsh 来自检出（node <bin.js>）。
                    nodeCommand: 'auto',
                    dshCommand: posixJoin(target.remoteRoot, DSH_CLI_RELATIVE),
                    nodeBin: '',
                    interpreter: null,
                    homeDir: '',
                    checkoutRoot: target.remoteRoot,
                    // WSL 上 dsh 只可能来自 staging 或检出（PATH 上没有 dsh，真机实测 NO_DSH）。
                    requiresRuntime: true,
                    hostVersion: options.hostVersion ?? null,
                    supported: dshSupported,
                    profile,
                };
            }
            const resolveTarget = options.resolveTarget ?? ((alias) => defaultResolveTarget(options.homeDir, alias));
            const sshTarget = resolveTarget(target.alias);
            if (sshTarget === undefined) {
                throw new RemoteCrError({
                    code: 'remote/unknown',
                    detail: '~/.ssh/config 里找不到主机 ' + target.alias,
                    nextActions: ['在 ~/.ssh/config 里补一个 Host 块后重试', '或改用 WSL 目标'],
                });
            }
            const exec = async (script, deadlineMs) => {
                const result = await runner({
                    target: sshTarget,
                    knownHostsFile: knownHostsPath(options.homeDir),
                    auth: { kind: 'key' },
                    command: ['sh', '-c', shellQuote(script)],
                    allowFailure: true,
                    deadlineMs: deadlineMs ?? 60_000,
                    ...(options.sshExecutable === undefined ? {} : { sshExecutable: options.sshExecutable }),
                });
                return { code: result.code, stdout: result.stdout, stderr: result.stderr };
            };
            return {
                exec,
                // 真实路径由读取脚本回报（runtime），这里只是兜底值。
                nodeCommand: 'auto',
                dshCommand: 'dsh',
                nodeBin: '.',
                homeDir: '',
                // 检出形态也要在同一次读取里探明（ssh/runtime.ts 的约定：remoteRoot 下就是检出）。
                checkoutRoot: target.remoteRoot,
                hostVersion: options.hostVersion ?? null,
                supported: dshSupported,
                profile,
            };
        },
    };
}
//# sourceMappingURL=wire.js.map