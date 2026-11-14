/**
 * SSH 后端的 `RemoteBackend` 实现：把 S3–S9 攒下的自由函数收成接口形态。
 *
 * 与 WSL 版的差别只有三处，且都在实现里：
 * - 探测走 `probeSshTarget`（**首次接触就是 TOFU 发生的地方**，所以必须走 `connectRemote`）；
 * - 启动要 `target/auth/homeDir`（连接参数不是「一个发行版名」能表达的）；
 * - `dispose()` 收的是 `SshRemoteHandle`，它比中立的句柄多 `localPort` 等字段，
 *   但回收语义一样：只碰自己起的那个进程树。
 *
 * 刻意不做的事：**不在这里 bootstrap**。装包/上传是 `S9` 引导器的职责，后端只负责
 * 「在一个已经能跑 dsh 的目标上把它拉起来」；把安装混进来会让 probe 与 launch 的成功
 * 条件纠缠（装了但没装对，究竟算探测失败还是启动失败说不清）。
 */
import { TeleportError } from "../errors.js";
import { probeSshTarget } from "./probe.js";
import { launchSshDsh, } from "./launch.js";
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
export class SshRemoteBackend {
    kind = 'ssh';
    target;
    #homeDir;
    #target;
    #auth;
    #probeTimeoutMs;
    #options;
    #probe;
    #launch;
    #handles = [];
    constructor(options) {
        this.#homeDir = options.homeDir;
        this.#target = options.target;
        this.#auth = options.auth;
        this.#probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
        this.#options = options;
        this.#probe = options.probe ?? probeSshTarget;
        this.#launch = options.launch ?? launchSshDsh;
        // 目标标识就用人写的那个 `user@host:port`；它就是用户在配置里认得出的东西。
        this.target = options.target.alias;
    }
    async probe() {
        try {
            const result = await this.#probe({
                homeDir: this.#homeDir,
                target: this.#target,
                auth: this.#auth,
                ...(this.#options.sshExecutable === undefined ? {} : { sshExecutable: this.#options.sshExecutable }),
                ...(this.#options.askpassPath === undefined ? {} : { askpassPath: this.#options.askpassPath }),
                deadlineMs: this.#probeTimeoutMs,
            });
            return result.probe;
        }
        catch (error) {
            // 指纹不匹配、认证失败这类都是 TeleportError，原样上抛（phase 已由 errors.ts 分好）。
            // 只有「不是 TeleportError」的意外才包一层，避免上层拿到裸 Error 无从展示。
            if (isTeleportErrorLike(error))
                throw error;
            const message = error instanceof Error ? error.message : String(error);
            throw new TeleportError({
                code: 'remote/probe-incomplete',
                detail: '探测 SSH 目标 ' + this.target + ' 失败：' + message,
                nextActions: ['重试探测', '确认远端可达：ssh -v <目标>', '检查私钥权限与 known_hosts'],
            });
        }
    }
    async launch(request) {
        const handle = await this.#launch({
            homeDir: this.#homeDir,
            target: this.#target,
            auth: this.#auth,
            remoteRoot: request.remoteRoot,
            ...(this.#options.remotePort === undefined ? {} : { remotePort: this.#options.remotePort }),
            ...(this.#options.localPort === undefined ? {} : { localPort: this.#options.localPort }),
            ...(this.#options.proxyPort === undefined ? {} : { proxyPort: this.#options.proxyPort }),
            ...(request.nodeCommand === undefined ? {} : { nodeCommand: request.nodeCommand }),
            ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            ...(this.#options.sshExecutable === undefined ? {} : { sshExecutable: this.#options.sshExecutable }),
            ...(this.#options.askpassPath === undefined ? {} : { askpassPath: this.#options.askpassPath }),
        });
        this.#handles.push(handle);
        return handle;
    }
    /** 回收自己起的全部句柄；可重复调用。任一不干净 ⇒ `clean: false`。 */
    async dispose() {
        const handles = this.#handles;
        this.#handles = [];
        let clean = true;
        for (const handle of handles) {
            const ok = await handle.dispose();
            if (!ok)
                clean = false;
        }
        return { clean };
    }
}
/** 只判形状：`errors.ts` 的 TeleportError 有 code/phase/nextActions 三件套。 */
function isTeleportErrorLike(value) {
    return (typeof value === 'object' &&
        value !== null &&
        'code' in value &&
        'phase' in value &&
        'nextActions' in value);
}
//# sourceMappingURL=remote-backend.js.map