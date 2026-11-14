/**
 * UNC → POSIX 的**提示词投影**（纯函数，零 IO，两侧共用不上——只在宿主半）。
 *
 * 为什么需要：WSL 后端把工作区注册成本机 UNC 路径（`\\\\wsl.localhost\\<distro>\\<path>`），
 * 因为 DSH 的工作区必须是**本机真实目录**（`realpath` + `stat().isDirectory()`，见
 * `docs/design/architecture.md` §4.1）。代价是模型看到的 cwd 是 UNC 形态，
 * 在 distro 里根本不存在这种路径，模型据此推理会错。
 *
 * 投影是**提示词层**，不是身份层：`session.header.cwd` / `ctx.fs` 的真实目标 /
 * `workingDirectory.get()` 全部保持 UNC，只有组装出来的提示词文本被改写。
 *
 * 两处**必须都改**（M0 实测 V7）：只改 `working-directory:current` 时，同一会话的
 * `sandbox:policy` 仍写着 UNC 工作区，模型会以为写权限边界是那个 UNC 路径。
 *
 * 非 UNC 输入**原样返回**：本地 Windows 工作区与将来的锚点后端都走这条，
 * 投影器对它们必须是恒等函数（否则就是拿一个后端的补丁去污染另一个后端）。
 */
/** 渲染 cwd 的第一处 context 名（`packages/session/working-directory/src/index.ts:99`）。 */
export declare const WORKING_DIRECTORY_CONTEXT = "working-directory:current";
/** 渲染 cwd 的第二处 context 名（`packages/sandbox/sandbox-policy/src/index.ts:42-56`）。 */
export declare const SANDBOX_POLICY_CONTEXT = "sandbox:policy";
/** `sandbox:policy` 里引用工作区路径的固定前缀。 */
export declare const SANDBOX_WORKSPACE_MARKER = "the session workspace: ";
/**
 * 把 WSL UNC 路径折成 distro 内的 POSIX 绝对路径。
 *
 * `\\\\wsl.localhost\\ubuntu_dev\\home\\hui\\w` → `/home/hui/w`；
 * share 根（`\\\\wsl.localhost\\ubuntu_dev`）→ `/`。
 * 不是 WSL UNC（盘符路径、`\\\\server\\share`、POSIX 路径）一律 undefined ——
 * 这条判据让投影器对非 WSL 后端自动退化成恒等函数。
 */
export declare function linuxPathOf(value: string): string | undefined;
/**
 * 本地 cwd 路径 → 模型该看到的路径。认不出就返回 undefined（投影器据此退化成恒等）。
 *
 * 默认实现是 WSL UNC 的折法；SSH 锚点后端传自己的映射（锚点路径 → 远端绝对路径），
 * 这样 UNC 与锚点共用同一套改写逻辑与本文件的边界处理。
 */
export type CwdProjector = (value: string) => string | undefined;
/** 改写 `working-directory:current` 的正文；认不出 cwd 就原样返回。 */
export declare function projectWorkingDirectory(text: string, projector?: CwdProjector): string;
/** 改写 `sandbox:policy` 里 `the session workspace: <json>` 那一段；认不出 cwd 就原样返回。 */
export declare function projectSandboxPolicy(text: string, projector?: CwdProjector): string;
/** 一次改写的事实记录（诊断与真机取证用，不含 sessionId）。 */
export interface ContextRewrite {
    readonly context: typeof WORKING_DIRECTORY_CONTEXT | typeof SANDBOX_POLICY_CONTEXT;
    readonly before: string;
    readonly after: string;
}
/** 一个待投影的 context（只取需要的两个字段）。 */
export interface ProjectableContext {
    readonly name: string;
    text: string;
}
/**
 * 对一组 context 做投影，返回**新的**改写记录列表（不改动入参）。
 *
 * 返回值而不是就地改写：调用方（cordis 监听器）需要知道到底改没改、改了哪几条，
 * 才能把事实记录下来；而「改了几条」正是负控要断言的量。
 */
export declare function projectContexts(contexts: readonly ProjectableContext[], projector?: CwdProjector): ContextRewrite[];
//# sourceMappingURL=unc-cwd.d.ts.map