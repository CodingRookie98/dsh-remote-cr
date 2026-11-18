/**
 * `scripts/check-client-cjk.mjs` 的类型声明：门禁脚本被单测直接 import（Delta-5 N5′），
 * 而它是 .mjs（没有自己的 d.ts），这里补一份最小面。
 */
declare module '*/check-client-cjk.mjs' {
  /** 扫出被算作界面文案的中文片段。 */
  export function scanSource(source: string, fileName?: string): { runs: { text: string; line: number }[] }
}
