/**
 * 浏览器半挂到 `globalThis.__TELEPORT__` 上的**诊断面类型**。
 *
 * 存在的理由和 M0 spike 的 `__TELEPORT_SPIKE__` 一样：让 CDP 断言能直接读到真实
 * 注册结果（哪几个 slot 真挂上了、`priority: -1` 有没有赢），而不是靠截图猜。
 *
 * 只读、不含凭据、不参与业务逻辑。类型放在普通 `.ts` 里而不是 `.d.ts`：`.d.ts`
 * 只能声明不能有实现，而这里要被 `plugin.ts`（实现）与 `env.d.ts`（全局声明）
 * 同时引用。
 */
import type { FlowState } from '../shared/flow.ts';
/** 一条已注册的 slot 记录。 */
export interface SlotRecord {
    readonly slot: string;
    readonly priority: number;
    readonly key: string | null;
    readonly id: string | null;
}
export interface TeleportDiagnostics {
    /** 当前仍挂着的 slot 名，按注册顺序。 */
    readonly mounted: readonly string[];
    /** 读某个 slot 的条目表（含别人的），用于证明 `priority: -1` 真的赢了。 */
    entries(slot: string): SlotRecord[];
    /** 面板当前持有的连接流程状态。 */
    flow(): FlowState;
    /** 最近一次可复制的错误报告文本；没有错误时为 null。 */
    report(): string | null;
}
