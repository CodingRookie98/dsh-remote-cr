import { RemoteCrError } from "../backend/errors.js";
function shellQuote(value) {
    return "'" + value.split("'").join("'\\''") + "'";
}
/** 生成单条安装命令；版本缺失属于调用方 bug，直接抛。 */
export function buildInstallCommand(request) {
    if (request.version === null || request.version === '') {
        throw new RemoteCrError({
            code: 'remote/plugin-sync-unsupported',
            detail: '缺少本机已装版本，拒绝安装：' + request.name,
            nextActions: ['在面板里刷新插件清单后重试'],
        });
    }
    return ('PATH=' + shellQuote(request.nodeBin) + ':$PATH ' +
        shellQuote(request.dshCommand) + ' plugin --profile ' + shellQuote(request.profile) +
        ' add ' + shellQuote(request.name + '@' + request.version));
}
export async function applySync(request) {
    const profile = request.profile ?? 'web';
    const unsupported = request.entries.filter((entry) => entry.action !== 'install');
    if (unsupported.length > 0) {
        throw new RemoteCrError({
            code: 'remote/plugin-sync-unsupported',
            detail: '请求里包含不可同步项：' + unsupported.map((entry) => entry.name).join(', '),
            nextActions: ['只勾选「可同步」的项后重试'],
        });
    }
    const results = [];
    for (const entry of request.entries) {
        const command = buildInstallCommand({
            dshCommand: request.dshCommand,
            nodeBin: request.nodeBin,
            profile,
            name: entry.name,
            version: entry.localVersion,
        });
        const outcome = await request.exec(command, request.deadlineMs ?? 180_000);
        const result = outcome.code === 0
            ? { name: entry.name, ok: true }
            : {
                name: entry.name,
                ok: false,
                code: 'remote/plugin-sync-apply-failed',
                detail: '退出码 ' + String(outcome.code) + '：' + outcome.stderr.trim().slice(-300),
            };
        results.push(result);
        request.onResult?.(result);
    }
    return results;
}
//# sourceMappingURL=apply.js.map