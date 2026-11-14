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
export const WORKING_DIRECTORY_CONTEXT = 'working-directory:current';
/** 渲染 cwd 的第二处 context 名（`packages/sandbox/sandbox-policy/src/index.ts:42-56`）。 */
export const SANDBOX_POLICY_CONTEXT = 'sandbox:policy';
/** `sandbox:policy` 里引用工作区路径的固定前缀。 */
export const SANDBOX_WORKSPACE_MARKER = 'the session workspace: ';
/**
 * `working-directory:current` 的整行形态。
 *
 * 整行锚定（`^` + `$`）是刻意的：这条 context 的正文就是这一句，宽松匹配会把
 * 别处出现的同名片段也改掉，而那种改动没有任何断言能发现。
 */
const WORKING_DIRECTORY_PATTERN = /^Current working directory: ("(?:[^"\\]|\\.)*")\.$/;
/** UNC 前缀（`\\wsl.localhost\` 与 `\\wsl$\` 两种都认，与 `wsl/unc.ts` 一致）。 */
const UNC_PATTERN = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(?:\\(.*))?$/;
/** 一段 JSON 字符串字面量里的**字符串值**；不是字符串就返回 undefined。 */
function parseQuoted(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    return typeof parsed === 'string' ? parsed : undefined;
}
/**
 * 把 WSL UNC 路径折成 distro 内的 POSIX 绝对路径。
 *
 * `\\\\wsl.localhost\\ubuntu_dev\\home\\hui\\w` → `/home/hui/w`；
 * share 根（`\\\\wsl.localhost\\ubuntu_dev`）→ `/`。
 * 不是 WSL UNC（盘符路径、`\\\\server\\share`、POSIX 路径）一律 undefined ——
 * 这条判据让投影器对非 WSL 后端自动退化成恒等函数。
 */
export function linuxPathOf(value) {
    const match = UNC_PATTERN.exec(value);
    if (match === null)
        return undefined;
    const tail = match[2] ?? '';
    return tail === '' ? '/' : '/' + tail.split('\\').join('/');
}
/** 改写 `working-directory:current` 的正文；认不出 cwd 就原样返回。 */
export function projectWorkingDirectory(text, projector = linuxPathOf) {
    const match = WORKING_DIRECTORY_PATTERN.exec(text);
    if (match === null)
        return text;
    const quoted = match[1];
    if (quoted === undefined)
        return text;
    const cwd = parseQuoted(quoted);
    if (cwd === undefined)
        return text;
    const linux = projector(cwd);
    if (linux === undefined)
        return text;
    return 'Current working directory: ' + JSON.stringify(linux) + '.';
}
/** 改写 `sandbox:policy` 里 `the session workspace: <json>` 那一段；认不出 cwd 就原样返回。 */
export function projectSandboxPolicy(text, projector = linuxPathOf) {
    const at = text.indexOf(SANDBOX_WORKSPACE_MARKER);
    if (at < 0)
        return text;
    const start = at + SANDBOX_WORKSPACE_MARKER.length;
    const quoted = /^("(?:[^"\\]|\\.)*")/.exec(text.slice(start));
    if (quoted === null)
        return text;
    const literal = quoted[1];
    if (literal === undefined)
        return text;
    const cwd = parseQuoted(literal);
    if (cwd === undefined)
        return text;
    const linux = projector(cwd);
    if (linux === undefined)
        return text;
    return text.slice(0, start) + JSON.stringify(linux) + text.slice(start + literal.length);
}
/**
 * 对一组 context 做投影，返回**新的**改写记录列表（不改动入参）。
 *
 * 返回值而不是就地改写：调用方（cordis 监听器）需要知道到底改没改、改了哪几条，
 * 才能把事实记录下来；而「改了几条」正是负控要断言的量。
 */
export function projectContexts(contexts, projector = linuxPathOf) {
    const rewrites = [];
    for (const entry of contexts) {
        if (entry.name === WORKING_DIRECTORY_CONTEXT) {
            const after = projectWorkingDirectory(entry.text, projector);
            if (after !== entry.text)
                rewrites.push({ context: WORKING_DIRECTORY_CONTEXT, before: entry.text, after });
        }
        else if (entry.name === SANDBOX_POLICY_CONTEXT) {
            const after = projectSandboxPolicy(entry.text, projector);
            if (after !== entry.text)
                rewrites.push({ context: SANDBOX_POLICY_CONTEXT, before: entry.text, after });
        }
    }
    return rewrites;
}
//# sourceMappingURL=unc-cwd.js.map