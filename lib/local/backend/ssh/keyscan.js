/**
 * `ssh-keyscan` 回退：当 `ssh` 自己不肯把指纹打在 stderr 上时，自己去问主机要。
 *
 * 触发条件是实测出来的：Windows 自带 OpenSSH 9.5p2 在 `-o LogLevel=VERBOSE` 下只打三行
 * INFO 日志，`Server host key:` 根本不存在。没有指纹就没有 TOFU 账本，指纹变更也就永远
 * 不会告警——那是「看起来在验证、其实没验证」的假安全。
 *
 * 两条边界必须说清：
 * 1. keyscan **不是**信任决策的来源。信任决策仍然由私有 known_hosts + `accept-new` 做，
 *    keyscan 只是把同一把钥匙的指纹抄下来记账；
 * 2. keyscan 失败**不**让连接失败。拿不到指纹就如实说「本次没取到证据」，
 *    而不是把一次本来能用的连接打成错误。
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { parseKeyscanOutput } from "./known-hosts.js";
/** 默认询问的算法；与服务端实际提供的有交集即可。 */
export const KEYSCAN_TYPES = 'rsa,ecdsa,ed25519';
export function buildKeyscanInvocation(target, keyscanExecutable = 'ssh-keyscan', timeoutSeconds = 5) {
    return {
        executable: keyscanExecutable,
        args: ['-T', String(timeoutSeconds), '-t', KEYSCAN_TYPES, '-p', String(target.port), target.hostName],
    };
}
export async function scanHostKeys(options) {
    const { executable, args } = buildKeyscanInvocation(options.target, options.keyscanExecutable ?? 'ssh-keyscan', options.timeoutSeconds ?? 5);
    const spawnProcess = options.spawn;
    const deadlineMs = options.deadlineMs ?? (options.timeoutSeconds ?? 5) * 1000 + 5000;
    return await new Promise((resolve) => {
        let settled = false;
        let stdout = '';
        let timer;
        const spawnImpl = spawnProcess ?? defaultSpawn;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            if (timer !== undefined)
                clearTimeout(timer);
            resolve(value);
        };
        let child;
        try {
            child = spawnImpl(executable, args, {});
        }
        catch {
            finish([]);
            return;
        }
        timer = setTimeout(() => {
            try {
                child.kill('SIGTERM');
            }
            catch {
            }
            finish([]);
        }, deadlineMs);
        child.stdout?.on('data', (chunk) => {
            if (settled)
                return;
            stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', () => {
        });
        child.on('error', () => finish([]));
        child.on('exit', () => finish(parseKeyscanOutput(stdout)));
    });
}
const defaultSpawn = (executable, args, env) => nodeSpawn(executable, [...args], {
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
});
//# sourceMappingURL=keyscan.js.map