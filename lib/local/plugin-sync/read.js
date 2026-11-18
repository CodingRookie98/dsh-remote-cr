import { RemoteCrError } from "../backend/errors.js";
/** 远端脚本（CJS，无依赖）：把 profile 的 bundles 与已装版本打成 JSON。 */
const READER = [
    "const fs=require('fs'),path=require('path'),os=require('os')",
    "const root=process.argv[2]",
    "const profile=process.argv[3]||'web'",
    "const base=root&&root!==''?root:path.join(os.homedir(),'.dsh','profiles',profile)",
    "let manifest",
    "try{manifest=JSON.parse(fs.readFileSync(path.join(base,'package.json'),'utf8'))}catch(e){console.log(JSON.stringify({ok:false,reason:'manifest-unreadable',detail:String(e.code||e.message)}));process.exit(0)}",
    "const bundles=(manifest.dsh&&manifest.dsh.profile&&manifest.dsh.profile.bundles)||[]",
    "const rows=bundles.map(function(name){var version=null,error=null;try{version=JSON.parse(fs.readFileSync(path.join(base,'node_modules',name,'package.json'),'utf8')).version||null}catch(e){error=String(e.code||e.message)}return{name:name,version:version,error:error}})",
    "console.log(JSON.stringify({ok:true,root:base,profile:profile,bundles:rows}))",
].join(';');
/** 把脚本文本 base64 化：躲开两层 shell 的引号与换行。 */
export function encodeScript(script) {
    return Buffer.from(script, 'utf8').toString('base64');
}
/**
 * 生成一次远端读取的 shell 脚本。
 *
 * `set -e` 会让失败以非零退出码回来；临时文件一定删（`trap`），否则反复连接会在
 * 远端 /tmp 里堆垃圾。
 */
export function buildReadScript(request) {
    const encoded = encodeScript(READER);
    const profileDir = request.homeDir === '' ? '' : request.homeDir + '/.dsh/profiles/' + request.profile;
    return [
        'set -e',
        'f=$(mktemp)',
        'trap \'rm -f "$f"\' EXIT',
        'printf %s ' + shellQuote(encoded) + ' | base64 -d > "$f"',
        'PATH=' + shellQuote(dirnameOf(request.nodeCommand)) + ':$PATH ' + shellQuote(request.nodeCommand) +
            ' "$f" ' + shellQuote(profileDir) + ' ' + shellQuote(request.profile),
    ].join('\n');
}
function dirnameOf(command) {
    if (!command.includes('/'))
        return '.';
    return command.slice(0, command.lastIndexOf('/'));
}
function shellQuote(value) {
    return "'" + value.split("'").join("'\\''") + "'";
}
/**
 * 读一次远端 bundle 清单。
 *
 * 只在「脚本跑不动 / 输出不是 JSON / ok=false」时抛结构化错误；单个包读不到版本
 * 是**正常事实**（官方包在 profile 里就是 ENOENT），交给 diff 判定。
 */
export async function readRemoteBundles(request) {
    const profile = request.profile ?? 'web';
    const script = buildReadScript({ nodeCommand: request.nodeCommand, profile, homeDir: request.homeDir ?? '' });
    const result = await request.exec(script, request.deadlineMs ?? 20_000);
    if (result.code !== 0) {
        throw new RemoteCrError({
            code: 'remote/plugin-sync-read-failed',
            detail: '读取远端插件清单失败（退出码 ' + String(result.code) + '）',
            nextActions: ['重试', '先确认这台远端能正常接入', '复制日志查看远端 stderr'],
            logTail: result.stderr.trim().slice(-400),
        });
    }
    let payload;
    try {
        payload = JSON.parse(result.stdout.trim());
    }
    catch (error) {
        throw new RemoteCrError({
            code: 'remote/plugin-sync-read-failed',
            detail: '远端返回的不是可解析的 JSON：' + String(error instanceof Error ? error.message : error),
            nextActions: ['重试', '复制日志贴进 issue'],
            logTail: result.stdout.trim().slice(-400),
        });
    }
    if (payload.ok !== true) {
        throw new RemoteCrError({
            code: 'remote/plugin-sync-read-failed',
            detail: '远端 profile 读不出来（' + String(payload.reason ?? 'unknown') + '）',
            nextActions: ['确认远端已接入过至少一次', '检查远端 ~/.dsh/profiles/' + profile + '/package.json'],
            logTail: String(payload.detail ?? ''),
        });
    }
    const rows = payload.bundles ?? [];
    return rows
        .filter((row) => typeof row.name === 'string' && row.name !== '')
        .map((row) => ({ name: String(row.name), version: typeof row.version === 'string' ? row.version : null }));
}
//# sourceMappingURL=read.js.map