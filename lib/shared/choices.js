/**
 * 「添加工作区」四选一的**纯模型**：哪些来源可选、每个来源当前是否可用、不可用时
 * 为什么。放在共享层是因为两侧都要它——宿主半用它做校验（不接受未实现的来源），
 * 浏览器半用它渲染（灰显 + tooltip 原因）。
 *
 * 与 `docs/design/ui-design.md` §4 的偏差（**登记，供 P4 审查**）：ui-design 写
 * 「SSH 未灰」，但 M1 的验收项写「本机 / WSL / SSH-灰 / Docker-灰」。以 M1 验收为准
 * ——SSH 的实现在 M2，M1 里点它只会得到一个明确的「计划在 M2」，比给一个跑不起来的
 * 入口更符合铁律 4（失败要响）。M2 的 S9.5b-2b 起，**只要 `~/.ssh/config` 里真有主机**
 * 就转为 `available`；没有主机时灰显并说明「config 里没有主机」，而不是笼统的「计划在 M2」。
 */
/** 四个来源，顺序即 UI 里的展示顺序。 */
export const WORKSPACE_SOURCES = ['local', 'wsl', 'ssh', 'docker'];
/**
 * 由「本机能力」推导出四选一的展示状态。
 *
 * `wslAvailable` 是探测结果（`wsl.exe --list` 能不能跑通），**不是配置项**：
 * 用户机器上没装 WSL 时，把 WSL 显示成可选只会在下一步炸。
 */
export function sourceOptions(input) {
    return [
        { id: 'local', label: '本机目录', availability: 'available', reason: '' },
        input.wslAvailable
            ? { id: 'wsl', label: 'WSL 发行版', availability: 'available', reason: '' }
            : {
                id: 'wsl',
                label: 'WSL 发行版',
                availability: 'unavailable',
                reason: '未检测到可用的 wsl.exe，或 wsl.exe 无法列出发行版',
            },
        input.sshAvailable === true
            ? { id: 'ssh', label: 'SSH 远端', availability: 'available', reason: '' }
            : {
                id: 'ssh',
                label: 'SSH 远端',
                availability: 'unavailable',
                reason: '~/.ssh/config 里没有可用的主机（写一个 Host 块后刷新）',
            },
        { id: 'docker', label: 'Docker 容器', availability: 'planned', reason: '计划在 M5' },
    ];
}
/** 当前可点的来源 id 列表——宿主半用它拒绝未实现的来源。 */
export function selectableSources(options) {
    return options.filter((option) => option.availability === 'available').map((option) => option.id);
}
/** 供日志与断言的一行稳定描述。 */
export function describeSource(option) {
    const suffix = option.availability === 'available' ? '' : ` (${option.availability}: ${option.reason})`;
    return `${option.id}=${option.label}${suffix}`;
}
//# sourceMappingURL=choices.js.map