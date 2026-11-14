/**
 * 占位令牌的生成与识别（P3.6 的纯逻辑半边）。
 *
 * 为什么是「占位令牌」而不是「把真 key 送过去」：铁律 3 —— 真实 API key / 账号
 * token 只存在于本地进程，远端磁盘与环境里只允许出现占位串。远端拿占位串发起
 * 请求，本地代理把占位串换成真值后转发上游。
 *
 * 三个必须守住的点：
 * 1. **本模块不持有任何秘密**。它只维护 `ref ↔ 占位串` 的双向映射；真值由调用方
 *    注入的 `resolve` 按需取，取完即用、不落任何结构。这样即使把表 dump 出来
 *    也拿不到 key。
 * 2. **占位串必须对 YAML 与 HTTP 头都安全**：只允许小写字母、数字与连字符，不含
 *    冒号、引号、空白、`Bearer ` 前缀，也不会被 YAML 当成特殊标量。
 * 3. **确定性可复算**：`mintPlaceholder(ref, salt)` 是 `(salt, ref)` 的纯函数，
 *    进程重启后只要 salt 不变，占位串不变 —— 否则远端刚写进去的占位串在下次连接
 *    就失效了。
 */
/** 占位串的统一前缀；日志与抓包都能一眼认出来。 */
export declare const PLACEHOLDER_PREFIX = "dsh-teleport-";
/** 由 `(salt, ref)` 确定性地算出占位串。 */
export declare function mintPlaceholder(ref: string, salt: string): string;
/** 形状判定：这是不是一个占位串（不看它是否已登记）。 */
export declare function looksLikePlaceholder(value: string): boolean;
/**
 * `ref ↔ 占位串` 的双向索引。
 *
 * 只做映射，不存真值。同一个 ref 重复登记同一个占位串是幂等的；同一个占位串
 * 绑到两个不同 ref 是编程错误，直接抛。
 */
export declare class PlaceholderTable {
    #private;
    constructor(salt: string);
    /** 登记一个 ref 的占位串；不传 `placeholder` 时按 salt 确定性生成。 */
    register(ref: string, placeholder?: string): string;
    /** ref 对应的占位串；未登记返回 `undefined`。 */
    placeholderFor(ref: string): string | undefined;
    /** 占位串反查 ref；不是占位串或未登记都返回 `undefined`。 */
    refFor(placeholder: string): string | undefined;
    /** 已登记的 ref 列表（顺序稳定，供快照与诊断）。 */
    refs(): string[];
    get size(): number;
}
/** 一次取值替换的结果；`ref` 缺省表示「这不是我们的占位串」。 */
export interface SubstitutionResult {
    /** 要真正发给上游的头部值（`Bearer ` 之类的前缀原样保留）。 */
    readonly value: string;
    /** 命中的凭据 ref；未命中为 `undefined`。 */
    readonly ref: string | undefined;
    /** 是否发生了替换。 */
    readonly replaced: boolean;
}
/**
 * 把头部值里的占位串换成真值。
 *
 * 支持两种常见形态：`Bearer <placeholder>`（OpenAI/Anthropic 风格）与裸占位串
 * （`x-api-key` 风格）。**前缀原样保留**——上游看到的是 `Bearer sk-...`，
 * 不是 `sk-...`。
 *
 * 占位串已登记但取不到真值（本地也没配这个 ref）时抛 `proxy/credential-unresolved`：
 * 这是配置缺失，不能静默把占位串发上游（那样只会得到一个看不懂的 401）。
 */
export declare function substitutePlaceholder(rawValue: string, table: PlaceholderTable, resolve: (ref: string) => Promise<string | undefined>): Promise<SubstitutionResult>;
//# sourceMappingURL=placeholder.d.ts.map