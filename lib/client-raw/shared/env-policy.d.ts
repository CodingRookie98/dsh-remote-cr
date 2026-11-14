/**
 * 环境档位（`reuse` / `isolated` / `sync`）的**类型**放 shared。
 *
 * 为什么不在 `src/local/env-policy/` 里定义：面板快照的线上形状要用它，而 client 半
 * 一旦 import 本地半的任何模块，就会把 `node:crypto` 这类服务端依赖拖进浏览器构建
 * （tsconfig.client.json 直接报 `Cannot find name 'node:crypto'`）。
 *
 * 这里只放**词表**：真正的决策（路径怎么拼、会不会碰 `~/.dsh`）留在本地半。
 */
export declare const ENV_POLICY_NAMES: readonly ["reuse", "isolated", "sync"];
export type EnvPolicy = (typeof ENV_POLICY_NAMES)[number];
