import { join } from 'node:path';
import { RemoteCrError } from "../backend/errors.js";
import { readSshConfig, resolveSshTarget } from "../backend/ssh/config.js";
import { knownHostsPath } from "../backend/ssh/known-hosts.js";
import { runSsh } from "../backend/ssh/transport.js";
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
        async resolve(target) {
            if (target.backend !== 'ssh') {
                throw new RemoteCrError({
                    code: 'remote/plugin-sync-unsupported',
                    detail: '插件同步目前只支持 SSH 目标（WSL 目标请先在远端手动安装）',
                    nextActions: ['改用 SSH 接入这台远端后重试', '或在远端执行 dsh plugin --profile web add <name>@<version>'],
                });
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
                profile,
            };
        },
    };
}
//# sourceMappingURL=wire.js.map