/**
 * 安装体检（doctor）。
 *
 * 由来：我们真的栽过一次「装上去缺入口」——`lib/` 曾被 ignore 排除，GitHub 安装拿到的包
 * 里没有 `lib/index.js`，宿主加载时才发现。这类问题的共同点是：**构建通过、单测全绿、
 * 装上就废**。所以体检直接查「装出来的这个包到底能不能用」，而不是查源码。
 *
 * 纯函数式：所有输入（包根、home）都由调用方给，便于用临时目录测试。
 */
export interface DoctorCheck {
    /** 机器可读的检查项 id。 */
    readonly id: string;
    /** ok = 没问题；warn = 能用但有隐患；fail = 必须修。 */
    readonly status: 'ok' | 'warn' | 'fail';
    /** 一句话结论（含取证细节）。 */
    readonly detail: string;
}
export interface DoctorOptions {
    /** 包根：装出来的那个目录（含 package.json）。 */
    readonly rootDir: string;
    /** 用户 home：状态根与迁移标记都在这下面。 */
    readonly homeDir: string;
}
export declare function runDoctor(options: DoctorOptions): DoctorCheck[];
export declare function formatDoctorReport(checks: readonly DoctorCheck[]): string;
/**
 * 本插件安装目录（包根）。
 *
 * 这个文件编译后在 `lib/local/doctor.js`，上两级就是包根（`package.json` 所在处）；
 * 面板的「诊断」区没必要让用户填路径，也不需要读 `process.cwd()`（那可能是任意目录）。
 * 仍保留注入口：路由测试传临时目录，不碰真实安装。
 */
export declare function packageRootOf(moduleUrl: string | URL): string;
export declare function installedRoot(): string;
/** CLI：`node lib/local/doctor.js`（也可 `pnpm doctor`）。 */
export declare function doctorMain(argv: readonly string[]): number;
//# sourceMappingURL=doctor.d.ts.map