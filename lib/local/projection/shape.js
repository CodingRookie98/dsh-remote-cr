/**
 * 远端返回值的**窄化助手**（投影层共用）。
 *
 * 远端是另一个进程、另一个版本，返回的 JSON 只能当不可信输入看待：
 * 形状不对就抛结构化错误，绝不把 `undefined` 当空值塞进投影表
 * （那会让面板显示成「远端什么都没有」，而不是「远端答得不对」）。
 *
 * 三个助手都刻意**不做类型断言**：`as Record<string, unknown>` 那种写法会把
 * 校验责任悄悄丢掉，而这里每一个返回值都必须先过 `typeof` 检查。
 */
import { TeleportError } from "../backend/errors.js";
/** 形状不对：带上端点名，让用户能定位到是哪一次远端调用。 */
export function badShape(endpoint, detail) {
    throw new TeleportError({
        code: 'remote/unknown',
        detail: '远端 ' + endpoint + ' 的返回值形状不对：' + detail,
        nextActions: ['确认远端 dsh 版本与本地一致', '重连后重试'],
    });
}
/** 只认普通对象：数组、null、函数一律不认（它们的字段语义与对象不同）。 */
export function asRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    return value;
}
/** 非空字符串；空串与缺失同样处理（远端用空串表示「没有」时不该被当成值）。 */
export function asString(value) {
    return typeof value === 'string' && value !== '' ? value : undefined;
}
/** 有限数字；`NaN`/`Infinity` 当缺失，避免把脏值写进投影表。 */
export function asNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
/** 字符串数组；认不出的条目**跳过而不是编造**。 */
export function asStringArray(value) {
    if (!Array.isArray(value))
        return [];
    const found = [];
    for (const entry of value) {
        const text = asString(entry);
        if (text !== undefined)
            found.push(text);
    }
    return found;
}
//# sourceMappingURL=shape.js.map