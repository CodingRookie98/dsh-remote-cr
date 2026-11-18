/**
 * 后端抽象：M1 只有 WSL 一家实现，但接口现在就要定型——M2 的 SSH、M5 的 Docker
 * 是同一组动词（探测 / 启动 / 回收），差别只在传输与工作区映射。把动词抽出来，
 * 上层（投影、凭据代理、断线重连）就只依赖动词，不依赖 `wsl.exe`。
 *
 * **不放进接口的东西**：任何跟 WSL 有关的细节（UTF-16LE、UNC、`--cd`）。那些是实现
 * 内部的private，泄漏到接口里就等于把 M2 挡在门外。
 */
/** 探测/启动可能失败的统一形态——上层只认这个，不用挨个 catch 杂七杂八。 */
export function isRemoteCrFailure(value) {
    return (typeof value === 'object' &&
        value !== null &&
        'code' in value &&
        'phase' in value &&
        'nextActions' in value);
}
//# sourceMappingURL=backend.js.map