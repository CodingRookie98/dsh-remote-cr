"use strict";
/**
 * 共享层：本地宿主半、浏览器半、远端 companion、引导器共同使用的常量与纯逻辑。
 *
 * 本文件只放**不依赖 cordis、不依赖 Node API** 的纯数据与纯函数，以便同一份
 * 源码能被两侧打包并且能被 `node --test` 直接跑。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SHARED_PROTOCOL_VERSION = void 0;
exports.describeShared = describeShared;
/**
 * 本地半与远端 companion 之间的握手协议版本。
 *
 * 语义：任一侧发现对方声明的主版本不同即拒绝继续（对应 requirements.md A10
 * 「版本不兼容要双向判定」）。改动本值必须同时改 `docs/design/architecture.md`
 * 的兼容性章节，属于契约变更。
 */
exports.SHARED_PROTOCOL_VERSION = 1;
/** 供日志/诊断展示的一行标识，稳定便于 grep。 */
function describeShared() {
    return `dsh-remote-cr shared protocol v${exports.SHARED_PROTOCOL_VERSION}`;
}
