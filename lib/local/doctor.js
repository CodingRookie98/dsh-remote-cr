import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// 旧名常量只有一处定义（ADR-0006）：体检要报「旧根还在」，也走同一个常量，
// 免得把字面量又抄一份到迁移目录之外（check:boot 会红）。
import { LEGACY_HOME_DIR_NAME } from "./migration/legacy-names.js";
/** 入口文件非空：0 字节的入口比缺文件更难查。 */
function isNonEmptyFile(path) {
    try {
        return statSync(path).isFile() && statSync(path).size > 0;
    }
    catch {
        return false;
    }
}
/** 状态根可写：写一个探针文件再删掉，比看权限位可靠。 */
function isWritableDir(path) {
    try {
        mkdirSync(path, { recursive: true });
        const probe = join(path, '.doctor-probe');
        writeFileSync(probe, 'ok');
        rmSync(probe, { force: true });
        return true;
    }
    catch {
        return false;
    }
}
export function runDoctor(options) {
    const checks = [];
    const pkgPath = join(options.rootDir, 'package.json');
    let pkg = null;
    try {
        pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        checks.push({ id: 'package', status: 'ok', detail: String(pkg?.name) + '@' + String(pkg?.version) });
    }
    catch (error) {
        checks.push({ id: 'package', status: 'fail', detail: 'package.json 读不出来：' + String(error) });
    }
    // 入口：main 与 exports 里指向的每个文件都必须在、且非空。
    const main = pkg?.main ?? '';
    if (main === '') {
        checks.push({ id: 'entry', status: 'fail', detail: 'package.json 没有 main 字段' });
    }
    else if (!isNonEmptyFile(join(options.rootDir, main))) {
        checks.push({ id: 'entry', status: 'fail', detail: '入口缺失或为空：' + main + '（lib/ 是不是被 ignore 排除了？）' });
    }
    else {
        checks.push({ id: 'entry', status: 'ok', detail: main });
    }
    const exportPaths = collectExportPaths(pkg?.exports);
    const missing = exportPaths.filter((rel) => !isNonEmptyFile(join(options.rootDir, rel)));
    checks.push(missing.length === 0
        ? { id: 'exports', status: 'ok', detail: String(exportPaths.length) + ' 个导出目标都在' }
        : { id: 'exports', status: 'fail', detail: '导出目标缺失：' + missing.join(', ') });
    // 浏览器半：没有它侧栏就是空的。
    const clientBundle = join(options.rootDir, 'lib', 'client.js');
    checks.push(isNonEmptyFile(clientBundle)
        ? { id: 'client-bundle', status: 'ok', detail: 'lib/client.js ' + statSync(clientBundle).size + ' 字节' }
        : { id: 'client-bundle', status: 'fail', detail: 'lib/client.js 缺失或为空：跑 pnpm build:client' });
    // 补丁：没有它插件根本不会被加载。
    const patchRel = pkg?.dsh?.bundle?.patch ?? '';
    checks.push(patchRel !== '' && isNonEmptyFile(join(options.rootDir, patchRel))
        ? { id: 'patch', status: 'ok', detail: patchRel }
        : { id: 'patch', status: 'fail', detail: 'dsh.bundle.patch 缺失或文件不存在：' + (patchRel || '(未声明)') });
    checks.push({
        id: 'engines',
        status: pkg?.dsh?.engines?.dsh === undefined ? 'fail' : 'ok',
        detail: pkg?.dsh?.engines?.dsh ?? 'package.json#dsh.engines.dsh 未声明',
    });
    // 状态根：不存在是正常的（还没接入过），不可写才是问题。
    const stateRoot = join(options.homeDir, '.dsh-remote-cr');
    checks.push(isWritableDir(stateRoot)
        ? { id: 'state-root', status: 'ok', detail: stateRoot + ' 可写' }
        : { id: 'state-root', status: 'fail', detail: stateRoot + ' 不可写：迁移与锚点都会失败' });
    const legacyRoot = join(options.homeDir, LEGACY_HOME_DIR_NAME);
    checks.push(existsSync(legacyRoot)
        ? { id: 'legacy-root', status: 'warn', detail: '旧状态根仍在：' + legacyRoot + '（确认无回滚需求后可删）' }
        : { id: 'legacy-root', status: 'ok', detail: '没有旧状态根残留' });
    return checks;
}
/** `exports` 里所有 `./xxx` 形式的文件路径（展开嵌套条件）。 */
function collectExportPaths(exportsField) {
    const out = [];
    const visit = (value) => {
        if (typeof value === 'string') {
            // `./src/*` 这类通配透传不是具体文件，别当缺失报。
            if (value.startsWith('./') && !value.includes('*'))
                out.push(value.slice(2));
            return;
        }
        if (value !== null && typeof value === 'object') {
            for (const nested of Object.values(value))
                visit(nested);
        }
    };
    visit(exportsField);
    return out;
}
export function formatDoctorReport(checks) {
    const lines = checks.map((check) => {
        const mark = check.status === 'ok' ? 'ok  ' : check.status === 'warn' ? 'warn' : 'FAIL';
        return '  ' + mark + ' ' + check.id + ' — ' + check.detail;
    });
    const failed = checks.filter((check) => check.status === 'fail').length;
    return ['dsh-remote-cr doctor', ...lines, '', failed === 0 ? '结论：可以正常加载' : '结论：' + String(failed) + ' 项必须修'].join('\n');
}
/**
 * 本插件安装目录（包根）。
 *
 * 这个文件编译后在 `lib/local/doctor.js`，上两级就是包根（`package.json` 所在处）；
 * 面板的「诊断」区没必要让用户填路径，也不需要读 `process.cwd()`（那可能是任意目录）。
 * 仍保留注入口：路由测试传临时目录，不碰真实安装。
 */
export function packageRootOf(moduleUrl) {
    // 纯函数：只做「模块路径 → 上两级」。抽出来是为了能用 `file://` 样本把**两种布局**
    // （源码 `src/local/doctor.ts` / 产物 `lib/local/doctor.js`）都钉在测试里 ——
    // 生产跑的是产物，只测源码布局等于没测（P4 建议 3）。
    return resolve(dirname(fileURLToPath(moduleUrl)), '..', '..');
}
export function installedRoot() {
    return packageRootOf(import.meta.url);
}
/** CLI：`node lib/local/doctor.js`（也可 `pnpm doctor`）。 */
export function doctorMain(argv) {
    // 默认包根用与 `/doctor` 同一个 `installedRoot()`：以前是 `process.cwd()`，于是 `pnpm doctor`
    // 的结论取决于你在哪个目录敲命令，和面板看到的不是一件事（P4 建议 4）。
    const rootDir = argv[0] ?? installedRoot();
    // home 回退与路由一致（`USERPROFILE` → `os.homedir()`）：都没有时会探到相对路径 `./.dsh-remote-cr`。
    const homeDir = process.env['USERPROFILE'] ?? process.env['HOME'] ?? homedir();
    const checks = runDoctor({ rootDir, homeDir });
    console.log(formatDoctorReport(checks));
    return checks.some((check) => check.status === 'fail') ? 1 : 0;
}
// 直接执行时跑一遍；被 import 时不产生副作用。
if (process.argv[1] !== undefined && process.argv[1].replace(/\\/g, '/').endsWith('/lib/local/doctor.js')) {
    process.exitCode = doctorMain(process.argv.slice(2));
}
//# sourceMappingURL=doctor.js.map