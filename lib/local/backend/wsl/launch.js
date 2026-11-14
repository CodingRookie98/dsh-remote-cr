/**
 * 启动远端 `dsh` 并把它变成一个可用的端点。
 *
 * **通路走 ③ stdio 桥**（ADR-0002 定档的默认档）：我们 spawn 一个
 * `wsl.exe -d <distro> --exec node <cli> web …`，dsh 的 stdout 直接经管道回到本进程。
 * 好处是三个：
 * 1. **不需要日志文件**——启动过程中的每一行都在我们手里，超时/失败原因不需要再去
 *    远端 `cat` 一遍（也就不会因为 `/tmp` 不在 UNC 可达范围而卡住）。
 * 2. **句柄即生命周期**——真机 A7 实测：杀掉 Windows 侧的 `wsl.exe` 句柄，distro 侧的
 *    子进程就被回收。所以 `dispose()` 只 kill 自己起的句柄，绝不 `wsl --terminate`。
 * 3. **与后续 stdio 桥同构**——凭据反代走的就是这条管道，先在这里把它跑通。
 *
 * 这个文件**只做启动与回收**，日志解析交给 `../dsh-output.ts`（纯函数可单测），
 * 错误分类也交给它。
 */
import { spawn } from 'node:child_process';
import { TeleportError } from "../errors.js";
import { OwnedChildren } from "./children.js";
import { classifyStartFailure, parseDshEndpoint } from "../dsh-output.js";
/** `dsh web` 的 argv（不含 wsl 前缀）。抽出来是为了能在单测里断言，不用真起进程。 */
export function buildDshArgs(options) {
    return [
        options.nodeCommand ?? 'node',
        'apps/cli/lib/bin.js',
        'web',
        '--no-open',
        '--port',
        String(options.port),
        '--host',
        options.host ?? '127.0.0.1',
        ...(options.extraArgs ?? []),
    ];
}
/**
 * 完整 argv：`-d <distro> --cd <remoteRoot> --exec <node…>`。
 *
 * 三个细节都实测过：
 * - 发行版名是**一个** argv 元素（不经 shell），含空格/中文都安全；
 * - 工作目录必须用 `wsl --cd`，**不能**用 `spawn` 的 `cwd`——后者是 Windows 侧路径，
 *   而 `remoteRoot` 是 distro 内的 POSIX 路径，交给 spawn 只会 ENOENT；
 * - `--cd` 在 `-d` 前后都能生效，统一写在 `--exec` 之前。
 */
export function buildLaunchArgs(options) {
    return ['-d', options.distro, '--cd', options.remoteRoot, '--exec', ...buildWatchdogArgs(options)];
}
/** 关掉 stdin 之后给看门狗多久去 kill 子进程（实测脚本是毫秒级，留足余量）。 */
const STDIN_EOF_GRACE_MS = 300;
/** 看门狗脚本里那两个标记，回收实证靠它们从日志里确认走的是哪条路。 */
export const WATCHDOG_PID_MARK = 'TELEPORT_WATCHDOG_PID=';
export const WATCHDOG_KILLED_MARK = 'TELEPORT_WATCHDOG_KILLED';
/**
 * 把 `dsh web` 包进一个「stdin 一关就自杀」的 bash 看门狗。
 *
 * 为什么需要它：宿主崩溃/被强杀时走不到 `dispose()`，而 Windows 不会替我们
 * 杀掉 `wsl.exe` 的 distro 侧子进程 —— 远端 dsh 就成了孤儿，下次启动撞端口。
 * 实测（D:/Temp/watchdog-test.cjs）：宿主侧 `child.stdin.destroy()` 之后
 * `portBusy=false count=0`，日志末尾出现 `TELEPORT_WATCHDOG_KILLED`。
 *
 * 这条把「远端生命周期」绑到了「宿主是否还握着管道」上，比事后轮询扫孤儿可靠：
 * 宿主怎么死的都无所谓，管道一断，`cat` 读到 EOF，脚本就把子进程 kill 掉。
 *
 * 整个脚本必须是**单行**：`wsl.exe --exec` 把每个 argv 原样传过去，多行会被
 * bash 当成后续命令的输入。
 */
export function buildWatchdogScript(options) {
    const argv = buildDshArgs({ remoteRoot: '.', ...options }).slice(1);
    const words = [...envAssignments(options.env), ...argv.map(shellWord)];
    return [
        words.join(' ') + ' &',
        'child=$!;',
        "printf '%s%s\\n' " + JSON.stringify(WATCHDOG_PID_MARK) + ' "$child";',
        'cat > /dev/null;',
        'kill $child 2>/dev/null;',
        "printf '%s\\n' " + JSON.stringify(WATCHDOG_KILLED_MARK),
    ].join(' ');
}
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** 一个 argv 词：安全字符裸露，其余单引号包起来（`'` 自己用 `'\\''` 收尾）。 */
export function shellWord(part) {
    return /^[A-Za-z0-9_./-]+$/.test(part) ? part : "'" + part.replace(/'/g, "'\\''") + "'";
}
/**
 * 环境变量 → `NAME=value` 前缀词。
 *
 * 名字与值都**先校验再拼**：脚本是单行 bash，一个换行就能把「设置变量」变成
 * 「执行第二条命令」。名字非法或值里有控制字符时直接抛，不做转义猜测。
 */
export function envAssignments(env) {
    if (env === undefined)
        return [];
    const words = [];
    for (const [name, value] of Object.entries(env)) {
        if (!ENV_NAME.test(name))
            throw new Error('环境变量名非法：' + JSON.stringify(name));
        if (/[\n\r\0]/.test(value))
            throw new Error('环境变量值里有控制字符：' + name);
        words.push(name + '=' + shellWord(value));
    }
    return words;
}
/** `bash -lc <看门狗脚本>` —— 与 `buildDshArgs` 一一对应，只是多了一层壳。 */
export function buildWatchdogArgs(options) {
    return ['bash', '-lc', buildWatchdogScript(options)];
}
/**
 * 启动远端 dsh，等到它打印带 token 的 URL 才 resolve。
 *
 * 绝不静默降级：超时、端口占用、缺 node 都会抛出 `TeleportError`，且带可复制的日志尾。
 */
export async function launchRemoteDsh(options) {
    const executable = options.executable ?? 'wsl.exe';
    const args = buildLaunchArgs(options);
    const timeoutMs = options.timeoutMs ?? 60_000;
    const child = spawn(executable, args, { shell: false, windowsHide: true });
    let buffer = '';
    const owned = new OwnedChildren();
    const endpoint = await new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
            child.stdout?.off('data', onData);
            child.stderr?.off('data', onData);
        };
        const finish = (run) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            run();
        };
        const onData = (chunk) => {
            buffer += chunk.toString('utf8');
            const found = parseDshEndpoint(buffer);
            if (found !== undefined)
                finish(() => resolve(found));
        };
        const onAbort = () => {
            try {
                child.kill();
            }
            catch {
                // 已退出
            }
            finish(() => reject(new TeleportError({
                code: 'remote/cancelled',
                detail: '用户取消了远端启动',
                nextActions: ['重试'],
                logTail: classifyStartFailure(buffer).logTail,
            })));
        };
        const timer = setTimeout(() => {
            try {
                child.kill();
            }
            catch {
                // 已退出
            }
            finish(() => reject(classifyStartFailure(`${buffer}\nTIMEOUT after ${timeoutMs}ms`)));
        }, timeoutMs);
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        child.on('error', (error) => {
            finish(() => reject(new TeleportError({
                code: 'remote/startup-failed',
                detail: `无法启动 ${executable}：${error.message}`,
                nextActions: ['确认 WSL 已安装且发行版存在', '重试'],
            })));
        });
        child.on('close', () => {
            // 进程在给出 URL 之前就退了 —— 让分类器从日志里读出原因。
            finish(() => reject(classifyStartFailure(buffer)));
        });
        options.signal?.addEventListener('abort', onAbort, { once: true });
    });
    owned.own({ label: `dsh:${options.distro}:${String(options.port)}`, child });
    return {
        endpoint,
        log: () => buffer,
        async dispose() {
            // 先关 stdin：看门狗读到 EOF 会自己 kill 掉 `dsh web`，这是**唯一**能
            // 确保 distro 侧子进程一起退出的路（只 kill `wsl.exe` 会留下 bash 的孙子进程）。
            // 给看门狗一点时间跑完，再按句柄兜底（它可能已经自己退了）。
            try {
                child.stdin?.end();
            }
            catch {
                // 管道已经断了
            }
            await new Promise((resolve) => setTimeout(resolve, STDIN_EOF_GRACE_MS));
            const report = await owned.dispose();
            return report.survivors.length === 0;
        },
    };
}
//# sourceMappingURL=launch.js.map