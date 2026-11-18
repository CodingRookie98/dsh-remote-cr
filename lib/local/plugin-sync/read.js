import { RemoteCrError } from "../backend/errors.js";
/**
 * 远端 dsh 检出里的 CLI 入口（相对检出根）。与 `ssh/runtime.ts`、`wsl/launch.ts` 是同一个约定：
 * 检出里跑 `node apps/cli/lib/bin.js`，而不是假设 `dsh` 在 PATH 上。
 */
export const DSH_CLI_RELATIVE = 'apps/cli/lib/bin.js';
/** 远端脚本（CJS，无依赖）：把 profile 的 bundles 与已装版本打成 JSON。 */
const READER = [
    "const fs=require('fs'),path=require('path'),os=require('os')",
    "const root=process.argv[2]",
    "const profile=process.argv[3]||'web'",
    "const hint=process.argv[4]||''",
    "const base=root&&root!==''?root:path.join(os.homedir(),'.dsh','profiles',profile)",
    "let manifest",
    "try{manifest=JSON.parse(fs.readFileSync(path.join(base,'package.json'),'utf8'))}catch(e){console.log(JSON.stringify({ok:false,reason:'manifest-unreadable',detail:String(e.code||e.message)}));process.exit(0)}",
    "const bundles=(manifest.dsh&&manifest.dsh.profile&&manifest.dsh.profile.bundles)||[]",
    "const rows=bundles.map(function(name){var version=null,error=null;try{version=JSON.parse(fs.readFileSync(path.join(base,'node_modules',name,'package.json'),'utf8')).version||null}catch(e){error=String(e.code||e.message)}return{name:name,version:version,error:error}})",
    "const home=os.homedir()",
    "let runtime=null",
    "try{var stagingRoot=path.join(home,'.dsh-remote-cr','staging');var dirs=fs.readdirSync(stagingRoot).filter(function(id){return fs.existsSync(path.join(stagingRoot,id,'npm','bin','dsh'))});if(dirs.length>0){var dir=path.join(stagingRoot,dirs[0]);var nodeCandidate=path.join(dir,'bin','node');var hasNode=fs.existsSync(nodeCandidate);runtime={homeDir:home,nodeCommand:hasNode?nodeCandidate:'node',nodeBin:hasNode?path.join(dir,'bin'):'$PATH',dshCommand:path.join(dir,'npm','bin','dsh'),interpreter:null,dshRoot:dir,source:'staging'}}}catch(e){}",
    "if(!runtime&&hint){try{var cli=path.join(hint," + JSON.stringify(DSH_CLI_RELATIVE) + ");if(fs.existsSync(cli)){runtime={homeDir:home,nodeCommand:process.execPath,nodeBin:path.dirname(process.execPath),dshCommand:cli,interpreter:process.execPath,dshRoot:hint,source:'checkout'}}}catch(e){}}",
    "var dshVersion=null;if(runtime){try{var cp=require(\"child_process\");var env=Object.assign({},process.env);if(runtime.nodeBin&&runtime.nodeBin!==\"$PATH\"){env.PATH=runtime.nodeBin+\":\"+env.PATH}var args=[runtime.dshCommand,\"--version\"];var opts={encoding:\"utf8\",timeout:8000};var rr=runtime.interpreter?cp.spawnSync(runtime.interpreter,args,opts):cp.spawnSync(runtime.dshCommand,args,Object.assign({},opts,{env:env}));if(rr&&typeof rr.stdout===\"string\"){dshVersion=String(rr.stdout).trim()||null}}catch(e){}}",
    "console.log(JSON.stringify({ok:true,root:base,profile:profile,bundles:rows,runtime:runtime,dshVersion:dshVersion}))",
].join(';');
/**
 * 远端脚本正文。**导出给单测**：它是拼出来的 JS 源码，少一个括号只会在真机上变成
 * `SyntaxError: Unexpected token`（一次真机 debug 换来的教训），必须在单测里就红。
 */
export const READER_SOURCE = READER;
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
    const encoded = encodeScript(READER_SOURCE);
    const profileDir = request.homeDir === '' ? '' : request.homeDir + '/.dsh/profiles/' + request.profile;
    // 第 4 个参数是「检出根」提示：脚本用它找 `apps/cli/lib/bin.js`，找不到就退回 staging 的结论。
    const hintArg = request.checkoutRoot === undefined || request.checkoutRoot === '' ? '' : ' ' + shellQuote(request.checkoutRoot);
    // `auto`：我们还不知道远端 node 在哪（bootstrap 型远端只在 staging 里有）——由脚本自己找。
    // 顺序：PATH 上的 node → staging/<id>/bin/node。找不到就 exit 5，让上层报 read-failed。
    const invoke = request.nodeCommand === 'auto'
        ? [
            'N=$(command -v node 2>/dev/null || true)',
            '[ -z "$N" ] && N=$(ls -d "$HOME"/.dsh-remote-cr/staging/*/bin/node 2>/dev/null | head -1)',
            '[ -n "$N" ] && [ -x "$N" ] || { echo REMOTE_CR_NO_NODE >&2; exit 5; }',
            'PATH=$(dirname "$N"):$PATH "$N" "$f" ' + shellQuote(profileDir) + ' ' + shellQuote(request.profile) + hintArg,
        ]
        : [
            'PATH=' + shellQuote(dirnameOf(request.nodeCommand)) + ':$PATH ' + shellQuote(request.nodeCommand) +
                ' "$f" ' + shellQuote(profileDir) + ' ' + shellQuote(request.profile) + hintArg,
        ];
    return [
        'set -e',
        'f=$(mktemp)',
        'trap \'rm -f "$f"\' EXIT',
        'printf %s ' + shellQuote(encoded) + ' | base64 -d > "$f"',
        ...invoke,
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
export async function readRemoteProfile(request) {
    const profile = request.profile ?? 'web';
    const script = buildReadScript({
        nodeCommand: request.nodeCommand,
        profile,
        homeDir: request.homeDir ?? '',
        ...(request.checkoutRoot === undefined ? {} : { checkoutRoot: request.checkoutRoot }),
    });
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
    const bundles = rows
        .filter((row) => typeof row.name === 'string' && row.name !== '')
        .map((row) => ({ name: String(row.name), version: typeof row.version === 'string' ? row.version : null }));
    return {
        bundles,
        runtime: readRuntime(payload.runtime),
        dshVersion: typeof payload.dshVersion === 'string' && payload.dshVersion !== '' ? payload.dshVersion : null,
    };
}
/** 把脚本回报的 runtime 收窄成可信形状；缺字段就整体当 null（不猜路径）。 */
function readRuntime(raw) {
    if (raw === null || raw === undefined)
        return null;
    const { homeDir, nodeCommand, nodeBin, dshCommand, dshRoot, interpreter, source } = raw;
    if (source !== 'staging' && source !== 'checkout')
        return null;
    if ([homeDir, nodeCommand, nodeBin, dshCommand, dshRoot].some((value) => typeof value !== 'string' || value === '')) {
        return null;
    }
    // `interpreter` 是后加的字段：老脚本不报时按 null（staging 形态）；报了就必须是非空字符串。
    const runner = interpreter === undefined || interpreter === null ? null : interpreter;
    if (runner !== null && (typeof runner !== 'string' || runner === ''))
        return null;
    return {
        homeDir: String(homeDir),
        nodeCommand: String(nodeCommand),
        nodeBin: String(nodeBin),
        dshCommand: String(dshCommand),
        interpreter: runner === null ? null : String(runner),
        dshRoot: String(dshRoot),
        source,
    };
}
/** 兼容入口：只要清单。 */
export async function readRemoteBundles(request) {
    const profile = await readRemoteProfile(request);
    return profile.bundles;
}
//# sourceMappingURL=read.js.map