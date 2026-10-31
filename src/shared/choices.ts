/**
 * 「添加工作区」四选一的**纯模型**：哪些来源可选、每个来源当前是否可用、不可用时
 * 为什么。放在共享层是因为两侧都要它——宿主半用它做校验（不接受未实现的来源），
 * 浏览器半用它渲染（灰显 + tooltip 原因）。
 *
 * 与 `docs/design/ui-design.md` §4 的偏差（**登记，供 P4 审查**）：ui-design 写
 * 「SSH 未灰」，但 M1 的验收项写「本机 / WSL / SSH-灰 / Docker-灰」。以 M1 验收为准
 * ——SSH 的实现在 M2，M1 里点它只会得到一个明确的「计划在 M2」，比给一个跑不起来的
 * 入口更符合铁律 4（失败要响）。M2 落地时把 `ssh` 改成 `available` 即可，UI 不需要改。
 */

/** 四个来源，顺序即 UI 里的展示顺序。 */
export const WORKSPACE_SOURCES = ['local', 'wsl', 'ssh', 'docker'] as const

export type WorkspaceSource = (typeof WORKSPACE_SOURCES)[number]

/**
 * `available` = 现在就能连；`planned` = 已排期但未实现（灰显并说明里程碑）；
 * `unavailable` = 本机能力不足（例如没有 `wsl.exe`），需要用户先装东西。
 */
export type SourceAvailability = 'available' | 'planned' | 'unavailable'

export interface SourceOption {
  readonly id: WorkspaceSource
  /** 面板上的短标签。 */
  readonly label: string
  readonly availability: SourceAvailability
  /** 灰显/禁用时的原因，同时作为 tooltip 与无障碍描述；可用时为空串。 */
  readonly reason: string
}

/**
 * 由「本机能力」推导出四选一的展示状态。
 *
 * `wslAvailable` 是探测结果（`wsl.exe --list` 能不能跑通），**不是配置项**：
 * 用户机器上没装 WSL 时，把 WSL 显示成可选只会在下一步炸。
 */
export function sourceOptions(input: { readonly wslAvailable: boolean }): SourceOption[] {
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
    { id: 'ssh', label: 'SSH 远端', availability: 'planned', reason: '计划在 M2' },
    { id: 'docker', label: 'Docker 容器', availability: 'planned', reason: '计划在 M5' },
  ]
}

/** 当前可点的来源 id 列表——宿主半用它拒绝未实现的来源。 */
export function selectableSources(options: readonly SourceOption[]): WorkspaceSource[] {
  return options.filter((option) => option.availability === 'available').map((option) => option.id)
}

/** 供日志与断言的一行稳定描述。 */
export function describeSource(option: SourceOption): string {
  const suffix = option.availability === 'available' ? '' : ` (${option.availability}: ${option.reason})`
  return `${option.id}=${option.label}${suffix}`
}
