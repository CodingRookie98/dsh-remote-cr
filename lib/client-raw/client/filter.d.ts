/**
 * 面板会话过滤的纯函数（M3 · P3.4）。
 *
 * 契约（下游面板接线依赖它，签名不要改）：
 *   filterSessions<T extends { readonly title: string }>(sessions, query): readonly T[]
 *
 * 语义：
 *   - `query` 先 trim；trim 后为空 → 原样返回全部（顺序保持，直接返回入参、不拷贝）；
 *   - 否则按 `title` 做**大小写不敏感**的**子串**匹配；
 *   - 保持输入顺序；不修改入参；不排序；不改变 title。
 *
 * 为什么用 `toLowerCase()` 而不是 `toLocaleLowerCase()`：后者跟着宿主 locale 走
 * （土耳其语的 I/ı 会让结果随环境漂移），过滤结果不该依赖运行环境。
 * 中文不受大小写影响，所以中文子串与 ASCII 大小写不敏感走的是同一条路径。
 */
export declare function filterSessions<T extends {
    readonly title: string;
}>(sessions: readonly T[], query: string): readonly T[];
