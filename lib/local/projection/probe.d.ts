/**
 * 会话取证：在**远端会话自己的终端里**跑一条命令，拿回证据。
 *
 * 这是 M1 验收「会话首个命令在远端执行（`pwd` + `uname -a` 断言）」的落点。
 * 为什么走 `terminal/*` 而不是 `session/prompt`：
 * - `prompt` 要走模型，慢且不确定；取证需要**确定性**，一次调用一次结果；
 * - `terminal/create` 的 cwd 由远端 `workingDirectory.ensure(agent)` 决定
 *   （`terminal-controller/src/index.ts:313-349`），也就是说终端天然落在**会话的
 *   远端工作目录**里 —— 这正好是我们要断言的东西；
 * - 反过来说，如果这条命令跑在本地，`$PWD` 会是 Windows 路径、`uname` 会不存在，
 *   断言自己就会红（这就是本探针的**可假性**）。
 *
 * 三条协议约束（都来自官方实现，写错就静默卡住）：
 * 1. 上行 `TerminalInput.sequence` 从 1 起**严格连续**，跳号抛
 *    `Terminal input sequence has a gap`（`terminal.ts:114-148`）；
 * 2. `attach` 的首帧是 `snapshot`（带已序列化的屏幕），之后才是 `output`；
 * 3. 回车必须是 `\r`（PTY 的行规程只认 CR），发 `\n` 会卡在提示符上。
 */
import type { ProjectionRpc } from './remote.ts';
/**
 * 探针命令的完成标记前缀。**真正的标记每轮带一个随机后缀**（见 `newDoneToken`）。
 *
 * 为什么必须是每轮唯一的：终端是**复用**的（`terminal/create` 对同 id 幂等，见
 * `PROBE_TERMINAL_ID`），而 `terminal/attach` 的首帧 `snapshot` 会带上这个终端
 * **上一轮的整屏 scrollback**。若完成标记是固定字面量，第二次取证时首帧里就已有
 * 上一轮的 `TPDONE`，解析器当场命中，**一条命令都没发**就"成功"返回上一轮的 cwd。
 * 这不是理论推演：2026-11-01 用最小假 rpc（首帧只给含旧结果的 snapshot、此后不再
 * 产出任何 output 帧）复现，`runSessionProbe` **2ms** 就返回了旧会话的 cwd。
 *
 * 带上每轮随机后缀之后，历史 scrollback 永远不含本轮标记，假命中在结构上不可能；
 * 而"输出里出现本轮标记"仍然只能由**本轮真实执行**产生，判据强度不降反升。
 */
export declare const PROBE_DONE_PREFIX = "TPDONE-";
/** 两个结果行的前缀；取值时**取完成标记之前最后一次出现的**，避免抓到输入回显。 */
export declare const PROBE_PWD = "TPPWD=";
export declare const PROBE_UNAME = "TPUNAME=";
/**
 * 取证命令。
 *
 * 刻意带前缀而不是裸 `pwd`/`uname`：终端里回显会把整条命令行打一遍，裸输出
 * 无法与回显区分；带前缀 + 取最后一次匹配就能稳定解析。
 *
 * **必须跨 shell 通用**：取证终端的 shell 由远端可用列表决定（见 `PROBE_SHELLS`），
 * 可能是 fish 也可能是 bash。所以只用两边都认的写法：`$PWD` 变量、`echo -n`、
 * 分号分隔，**不用**带命令替换的 `printf '...' "$(uname -a)"` —— fish 3.7 虽然
 * 支持 `$(...)`，但它的重绘会把带引号的长命令行拆成好几段，回显行跟着裂开
 * （实测该形态在 fish 下 6/6 解析失败，而这条 6/6 通过）。
 *
 * **命令长度不是这里的杠杆**（2026-11-01 真机对照，WSL `ubuntu_dev`，n=5/档，
 * 严格判据「某行 trim 后 === 完成标记」）：24 字符 p50 1675 / p90 1787，
 * 32 字符 1445 / 1719，66 字符 1481 / 1560 —— 全在噪声内。早先观察到「110 字符
 * 比 12 字符慢 6 倍」是**冷终端排队**造成的，不是行编辑器在给命令行上色。
 */
export declare function buildProbeCommand(doneToken: string): string;
/**
 * 生成本轮唯一的完成标记。
 *
 * 只用小写十六进制：它要原样进 shell 命令，不能有任何需要转义或会被 shell 解释的字符
 * （`$` / 反引号 / 空格 / 引号一个都不能有），否则 fish 与 bash 的解释就会分叉。
 * 8 字节够用：一轮一次，碰撞概率可忽略，同时命令行只长 17 个字符。
 */
export declare function newDoneToken(): string;
/** 终端尺寸给足，避免长命令行被折行拆成两行。 */
export declare const PROBE_COLS = 200;
export declare const PROBE_ROWS = 50;
export declare const PROBE_TERMINAL_ID = "remote-cr-probe";
export declare const DEFAULT_PROBE_TIMEOUT_MS = 20000;
/**
 * 取证终端优先用的 shell —— 按顺序取**远端真的装了的**第一个。
 *
 * 为什么值得换 shell：远端 bash 的 `~/.bashrc` 里有 `ble.sh`（行编辑器），它启动时
 * 要做整屏重绘、还要发 `ESC[>c`/`ESC[6n` 问终端能力并**等应答**。我们的 RPC 客户端
 * 不是真终端，不应答，于是它只能等到超时 —— 真机逐帧时间线（2026-11-01）：
 *
 * `+234ms 回显命令 → +1003ms 输出含 ESC[>c ESC[6n → +1778ms ble.sh 重绘 → +2183ms 才出现命令结果`
 *
 * 这 1.4–1.8s 与命令内容、命令长度、PTY 尺寸都无关（都做过对照），纯粹是 bash 启动。
 * 而 fish 不跑 ble.sh：同一台机器、同一条命令、同一套测量代码，
 *
 * | shell | 首命令 p50 / p90（冷终端，n=6）| n=12 复核 |
 * | --- | --- | --- |
 * | bash（默认）| 1789 / 2015 | — |
 * | fish | **204 / 406** | **150 / 161** |
 *
 * 取证是**只读的事实采集**（`$PWD` + `uname -a`），不依赖用户的交互式 shell 偏好，
 * 所以这里换 shell 不改变取证语义，只绕开远端 rc 的启动开销。
 *
 * 远端没装 fish 时回落到默认 shell，此时仍要靠下面的 `TERMINAL_WARMUP_MS` 兜底。
 */
export declare const PROBE_SHELL_PREFERENCE: readonly string[];
/**
 * 走「启动慢的 shell」（远端默认 bash + ble.sh）时，一个终端从**建立**到
 * 「能秒回命令」需要的时间。
 *
 * 这个数字不是猜的，是真机对照实测（2026-10-31 / 11-01，WSL `ubuntu_dev`，
 * 每次新会话 + 新终端，量「发命令 → 完成标记到达」）：
 *
 * | create 后已过 | 命令往返 |
 * | --- | --- |
 * | 0 ms | **1776 ms** |
 * | 500 ms | 1248 ms |
 * | 1500 ms | **364 ms** |
 * | 已跑过一条命令的终端 | **24 ms** |
 *
 * 也就是说：新建终端那一刻，远端 bash 还在跑 `~/.bashrc`（含 `ble.sh`），此时送进去
 * 的输入要排在初始化之后才被处理；**等它初始化完**再发，命令本身只要几百毫秒。
 *
 * 还试过「等首帧输出出现再发」（自适应）：首帧 705 ms 就到了，但那时初始化并未结束，
 * 命令仍要再等 818 ms。**首帧输出不是「终端就绪」的信号**。
 *
 * 注意：`PROBE_SHELL_PREFERENCE` 命中时（fish）**不需要**这段等待 —— 它没有 ble.sh，
 * 冷终端首命令只要 150 ms。等待只对回落路径生效，见 `remainingWarmup`。
 */
export declare const TERMINAL_WARMUP_MS = 1500;
/** 终端回滚缓冲上限：远端异常刷屏时不能把本地内存吃光。 */
export declare const MAX_TRANSCRIPT_CHARS: number;
/** 取证所需的全部外部能力。 */
export interface ProbeDeps {
    readonly rpc: ProjectionRpc;
}
/**
 * 提前把取证终端建出来，让预热窗口在**用户还没点取证**的时候就开始走。
 *
 * 为什么值得单独一步：终端初始化的代价是「每个终端一次」的（实测同一终端第二条
 * 命令 24ms），而它一旦开始就不需要我们再做什么 —— 只要时间过去。会话一建好就
 * 建终端，等用户真去点「取证」时窗口早已走完，量到的就是 364ms 而不是 1776ms。
 *
 * 换成 fish 之后这段等待本身也不需要了（冷终端 150ms），但**先建终端**仍然值得：
 * 它把「建终端」的那次远端往返（实测 33–254ms）挪出用户等待窗口。
 *
 * 失败会**抛出去**，不吞：终端是取证的唯一通道，建不出终端等于取证必然失败，
 * 在会话建立时就说清楚，比让用户在取证按钮上等 20s 超时好（铁律 4「失败要响」）。
 */
export declare function preheatProbe(deps: ProbeDeps, sessionId: string, options?: {
    readonly terminalId?: string;
    readonly signal?: AbortSignal;
}): Promise<string>;
export interface ProbeOptions {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    /** 终端 id；同一会话重复取证会幂等命中（`terminal/create` 对同 id 幂等）。 */
    readonly terminalId?: string;
    /** 覆盖预热等待；单测与对照实验用，产品路径走 `TERMINAL_WARMUP_MS`。 */
    readonly warmupMs?: number;
}
export interface ProbeResult {
    readonly sessionId: string;
    readonly terminalId: string;
    /** 远端会话工作目录（POSIX 绝对路径）。 */
    readonly cwd: string;
    /** `uname -a` 的整行输出。 */
    readonly uname: string;
    /** 截断后的完整终端文本，供「可复制日志」用。 */
    readonly transcript: string;
}
/**
 * 去掉终端控制序列。
 *
 * 真机取证踩到的坑：远端 shell 是带主题的 zsh/bash 提示符，一段「真实输出」
 * 前面往往挂着 ESC[?25h ESC[?2004l ESC[?25h 这类控制序列，于是
 * line.startsWith(PROBE_PWD) 永远不成立 —— 解析器静默返回 undefined，
 * 探针一路等到超时，最后报成「没有回显完成标记」（症状与病因差得很远）。
 * 所以取值前必须先剥控制序列。
 */
export declare function stripAnsi(text: string): string;
/**
 * 从终端文本里解析取证结果。
 *
 * 解析方向是**从后往前**：先找最后一处独占一行的完成标记，再在它之前找两个前缀
 * 最后一次出现的位置。这样输入回显（命令行本身也含前缀字面量）永远被真正的输出覆盖。
 *
 * `doneToken` 必须是**本轮**生成的（`newDoneToken`），不能是固定字面量：终端复用 +
 * snapshot 带历史 scrollback 时，固定标记会让上一轮的结论冒充本轮结论。
 */
export declare function parseProbeTranscript(transcript: string, doneToken: string): {
    cwd: string;
    uname: string;
} | undefined;
/**
 * 在远端会话的终端里跑一次取证命令。
 *
 * 终端用完**不删**（`terminal/close`）：它是用户能看到的证据，删掉反而让人无法复核。
 * 同一 `terminalId` 重复调用会复用同一个终端（`terminal/create` 幂等），
 * 所以反复取证不会把远端终端数量刷到上限。
 */
export declare function runSessionProbe(deps: ProbeDeps, sessionId: string, options?: ProbeOptions): Promise<ProbeResult>;
/** 会话首个命令是否**真的**跑在远端：cwd 是 POSIX 绝对路径，且内核串是 Linux。 */
export declare function assertRemoteExecution(result: ProbeResult): {
    readonly cwd: string;
    readonly uname: string;
};
//# sourceMappingURL=probe.d.ts.map