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
    // PATH 前缀只在知道 nodeBin 时加：`PATH=''` 会把当前目录塞进搜索路径，那不是「不知道」的语义。
    const prefix = request.nodeBin === '' ? '' : 'PATH=' + shellQuote(request.nodeBin) + ':$PATH ';
    const interpreter = request.interpreter ?? null;
    const entry = interpreter === null
        ? shellQuote(request.dshCommand)
        : shellQuote(interpreter) + ' ' + shellQuote(request.dshCommand);
    return (prefix + entry + ' plugin --profile ' + shellQuote(request.profile) +
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
            interpreter: request.interpreter ?? null,
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
                // 失败必须带下一步（铁律 4）：把**可照抄的命令**也给出，用户不必猜 shlex。
                nextActions: [
                    '重试这一条',
                    '检查远端 npm 网络（能否访问 registry）',
                    '在远端手动执行：' + command,
                ],
            };
        results.push(result);
        request.onResult?.(result);
    }
    return results;
}
//# sourceMappingURL=apply.js.map