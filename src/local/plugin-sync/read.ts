import { RemoteCrError } from '../backend/errors.ts'
import type { RemoteBundle } from '../../shared/plugin-sync.ts'

/**
 * 读远端已装的 bundle（RFC-0003 / T2）。
 *
 * 为什么是「自包含脚本 + 远端 node」而不是纯 shell：profile 的 `dsh.profile.bundles`
 * 是多行 JSON 数组，sed/tr 解析在转义上必然翻车；而 node 由引导器保证存在
 * （bootstrap 装 node 或远端本来就有）。实测见 spikes/m3-plugin-sync/README.md。
 *
 * 脚本用 **base64 投递**：`ssh host 'node -e "…"'` 会经过两层 shell，引号必被吃掉
 * （首跑就死在这）。写临时文件再执行，退出码与 stdout 都可判定。
 */

/** 与 `RemoteExec`（ssh/runtime.ts）结构兼容，方便 SSH / WSL 两侧注入。 */
export interface SyncExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export type SyncExec = (script: string, deadlineMs?: number) => Promise<SyncExecResult>

/**
 * 远端 dsh 检出里的 CLI 入口（相对检出根）。与 `ssh/runtime.ts`、`wsl/launch.ts` 是同一个约定：
 * 检出里跑 `node apps/cli/lib/bin.js`，而不是假设 `dsh` 在 PATH 上。
 */
export const DSH_CLI_RELATIVE = 'apps/cli/lib/bin.js'

export interface ReadBundlesRequest {
  readonly exec: SyncExec
  /** 远端 node 的可执行描述：绝对路径，或 'node'（依赖 PATH）。 */
  readonly nodeCommand: string
  /** DSH profile 名，默认 web。 */
  readonly profile?: string
  /** 远端 home（用于定位 `<home>/.dsh/profiles`）；空则由脚本用 os.homedir()。 */
  readonly homeDir?: string
  /**
   * 远端 dsh 检出根（WSL 的 `remoteRoot`、SSH 的 `remoteRoot`）。给了才在**同一次**往返里
   * 顺带探明检出形态的运行时（`dshCommand` + `interpreter`）；没给就只认 staging。
   */
  readonly checkoutRoot?: string
  readonly deadlineMs?: number
}

/** 远端脚本（CJS，无依赖）：把 profile 的 bundles 与已装版本打成 JSON。 */
const READER = [
  "const fs=require('fs'),path=require('path'),os=require('os')",
  "const root=process.argv[2]",
  "const profile=process.argv[3]||'web'",
  "const hint=process.argv[4]||''",
  "const stage=process.argv[5]||''",
  "const base=root&&root!==''?root:path.join(os.homedir(),'.dsh','profiles',profile)",
  "let manifest",
  "try{manifest=JSON.parse(fs.readFileSync(path.join(base,'package.json'),'utf8'))}catch(e){console.log(JSON.stringify({ok:false,reason:'manifest-unreadable',detail:String(e.code||e.message)}));process.exit(0)}",
  "const bundles=(manifest.dsh&&manifest.dsh.profile&&manifest.dsh.profile.bundles)||[]",
  "const rows=bundles.map(function(name){var version=null,error=null;try{version=JSON.parse(fs.readFileSync(path.join(base,'node_modules',name,'package.json'),'utf8')).version||null}catch(e){error=String(e.code||e.message)}return{name:name,version:version,error:error}})",
  "const home=os.homedir()",
  "let runtime=null",
  "if(hint){try{var cli=path.join(hint," + JSON.stringify(DSH_CLI_RELATIVE) + ");if(fs.existsSync(cli)){runtime={homeDir:home,nodeCommand:process.execPath,nodeBin:path.dirname(process.execPath),dshCommand:cli,interpreter:process.execPath,dshRoot:hint,source:'checkout'}}}catch(e){}}",
  "if(!runtime&&stage){try{var sdir=path.join(home,stage);if(fs.existsSync(path.join(sdir,'npm','bin','dsh'))){var nc=path.join(sdir,'bin','node');var hn=fs.existsSync(nc);runtime={homeDir:home,nodeCommand:hn?nc:'node',nodeBin:hn?path.join(sdir,'bin'):'$PATH',dshCommand:path.join(sdir,'npm','bin','dsh'),interpreter:null,dshRoot:sdir,source:'staging'}}}catch(e){}}",

  "var dshVersion=null;if(runtime){try{var cp=require(\"child_process\");var env=Object.assign({},process.env);if(runtime.nodeBin&&runtime.nodeBin!==\"$PATH\"){env.PATH=runtime.nodeBin+\":\"+env.PATH}var args=[runtime.dshCommand,\"--version\"];var opts={encoding:\"utf8\",timeout:8000};var rr=runtime.interpreter?cp.spawnSync(runtime.interpreter,args,opts):cp.spawnSync(runtime.dshCommand,args,Object.assign({},opts,{env:env}));if(rr&&typeof rr.stdout===\"string\"){dshVersion=String(rr.stdout).trim()||null}}catch(e){}}",
  "console.log(JSON.stringify({ok:true,root:base,profile:profile,bundles:rows,runtime:runtime,dshVersion:dshVersion}))",
].join(';')

/**
 * 远端脚本正文。**导出给单测**：它是拼出来的 JS 源码，少一个括号只会在真机上变成
 * `SyntaxError: Unexpected token`（一次真机 debug 换来的教训），必须在单测里就红。
 */
export const READER_SOURCE = READER

/** 把脚本文本 base64 化：躲开两层 shell 的引号与换行。 */
export function encodeScript(script: string): string {
  return Buffer.from(script, 'utf8').toString('base64')
}

/**
 * 生成一次远端读取的 shell 脚本。
 *
 * `set -e` 会让失败以非零退出码回来；临时文件一定删（`trap`），否则反复连接会在
 * 远端 /tmp 里堆垃圾。
 */
export function buildReadScript(request: {
  readonly nodeCommand: string
  readonly profile: string
  readonly homeDir: string
  readonly checkoutRoot?: string
  readonly stagingSuffix?: string
}): string {
  const encoded = encodeScript(READER_SOURCE)
  const profileDir = request.homeDir === '' ? '' : request.homeDir + '/.dsh/profiles/' + request.profile
  // 第 4 个参数是「检出根」提示：与连接侧同一个优先级（检出优先），找不到才看第 5 个参数的 staging。
  const hintArg = request.checkoutRoot === undefined || request.checkoutRoot === '' ? '' : ' ' + shellQuote(request.checkoutRoot)
  // 第 5 个参数是 staging 的**相对**后缀（由调用方按目标算）：不给就传空串，脚本便不看 staging。
  const stageArg = request.stagingSuffix === undefined || request.stagingSuffix === '' ? " ''" : ' ' + shellQuote(request.stagingSuffix)
  // `auto`：我们还不知道远端 node 在哪（bootstrap 型远端只在 staging 里有）——由脚本自己找。
  // 顺序：PATH 上的 node → staging/<id>/bin/node。找不到就 exit 5，让上层报 read-failed。
  const invoke =
    request.nodeCommand === 'auto'
      ? [
          'N=$(command -v node 2>/dev/null || true)',
          // staging 的 node 也只认这台目标的那份（多目标共用 home 时不能扫到别人的）。
          '[ -z "$N" ] && [ -n "$stage" ] && [ -x "$HOME/$stage/bin/node" ] && N="$HOME/$stage/bin/node"',
          '[ -n "$N" ] && [ -x "$N" ] || { echo REMOTE_CR_NO_NODE >&2; exit 5; }',
          'PATH=$(dirname "$N"):$PATH "$N" "$f" ' + shellQuote(profileDir) + ' ' + shellQuote(request.profile) + hintArg + stageArg,
        ]
      : [
          'PATH=' + shellQuote(dirnameOf(request.nodeCommand)) + ':$PATH ' + shellQuote(request.nodeCommand) +
            ' "$f" ' + shellQuote(profileDir) + ' ' + shellQuote(request.profile) + hintArg + stageArg,
        ]
  return [
    'set -e',
    'f=$(mktemp)',
    'trap \'rm -f "$f"\' EXIT',
    'printf %s ' + shellQuote(encoded) + ' | base64 -d > "$f"',
    ...invoke,
  ].join('\n')
}

function dirnameOf(command: string): string {
  if (!command.includes('/')) return '.'
  return command.slice(0, command.lastIndexOf('/'))
}

function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'"
}

/** 远端「用哪个 node / 哪个 dsh」——同一次读取里探明，省掉第二次 exec。 */
export interface RemoteRuntimePaths {
  readonly homeDir: string
  readonly nodeCommand: string
  readonly nodeBin: string
  readonly dshCommand: string
  /**
   * 跑 `dshCommand` 的解释器：检出形态是 `node <bin.js>`（不假设 bin.js 有 +x），
   * staging 形态的 `dsh` 本身可执行 → null。
   */
  readonly interpreter: string | null
  /** dsh 的来源根：SSH 的 staging 目录，或（检出形态，WSL 常见）检出根目录。`dshCommand` 就在它里面。 */
  readonly dshRoot: string
  /** 来源形态：`staging` 可由 registry 升级；`checkout` 只能换检出（拒绝自动升级）。 */
  readonly source: 'staging' | 'checkout'
}

interface ReaderPayload {
  readonly ok?: boolean
  readonly reason?: string
  readonly detail?: string
  readonly root?: string
  readonly bundles?: readonly { readonly name?: string; readonly version?: string | null; readonly error?: string | null }[]
  readonly runtime?: Partial<RemoteRuntimePaths> | null
  readonly dshVersion?: string | null
}

/**
 * 读一次远端 bundle 清单。
 *
 * 只在「脚本跑不动 / 输出不是 JSON / ok=false」时抛结构化错误；单个包读不到版本
 * 是**正常事实**（官方包在 profile 里就是 ENOENT），交给 diff 判定。
 */
export interface RemoteProfileRead {
  readonly bundles: readonly RemoteBundle[]
  /** 远端既没有 staging 也没有检出时为 null（此时同步应当提示「先接入一次」）。 */
  readonly runtime: RemoteRuntimePaths | null
  /** 远端 dsh 自报的版本（同一次 exec 里问的）；读不到为 null。 */
  readonly dshVersion: string | null
}

export async function readRemoteProfile(request: ReadBundlesRequest): Promise<RemoteProfileRead> {
  const profile = request.profile ?? 'web'
  const script = buildReadScript({
    nodeCommand: request.nodeCommand,
    profile,
    homeDir: request.homeDir ?? '',
    ...(request.checkoutRoot === undefined ? {} : { checkoutRoot: request.checkoutRoot }),
  })
  const result = await request.exec(script, request.deadlineMs ?? 20_000)
  if (result.code !== 0) {
    throw new RemoteCrError({
      code: 'remote/plugin-sync-read-failed',
      detail: '读取远端插件清单失败（退出码 ' + String(result.code) + '）',
      nextActions: ['重试', '先确认这台远端能正常接入', '复制日志查看远端 stderr'],
      logTail: result.stderr.trim().slice(-400),
    })
  }
  let payload: ReaderPayload
  try {
    payload = JSON.parse(result.stdout.trim()) as ReaderPayload
  } catch (error) {
    throw new RemoteCrError({
      code: 'remote/plugin-sync-read-failed',
      detail: '远端返回的不是可解析的 JSON：' + String(error instanceof Error ? error.message : error),
      nextActions: ['重试', '复制日志贴进 issue'],
      logTail: result.stdout.trim().slice(-400),
    })
  }
  if (payload.ok !== true) {
    throw new RemoteCrError({
      code: 'remote/plugin-sync-read-failed',
      detail: '远端 profile 读不出来（' + String(payload.reason ?? 'unknown') + '）',
      nextActions: ['确认远端已接入过至少一次', '检查远端 ~/.dsh/profiles/' + profile + '/package.json'],
      logTail: String(payload.detail ?? ''),
    })
  }
  const rows = payload.bundles ?? []
  const bundles = rows
    .filter((row) => typeof row.name === 'string' && row.name !== '')
    .map((row) => ({ name: String(row.name), version: typeof row.version === 'string' ? row.version : null }))
  return {
    bundles,
    runtime: readRuntime(payload.runtime),
    dshVersion: typeof payload.dshVersion === 'string' && payload.dshVersion !== '' ? payload.dshVersion : null,
  }
}

/** 把脚本回报的 runtime 收窄成可信形状；缺字段就整体当 null（不猜路径）。 */
function readRuntime(raw: Partial<RemoteRuntimePaths> | null | undefined): RemoteRuntimePaths | null {
  if (raw === null || raw === undefined) return null
  const { homeDir, nodeCommand, nodeBin, dshCommand, dshRoot, interpreter, source } = raw
  if (source !== 'staging' && source !== 'checkout') return null
  if ([homeDir, nodeCommand, nodeBin, dshCommand, dshRoot].some((value) => typeof value !== 'string' || value === '')) {
    return null
  }
  // `interpreter` 是后加的字段：老脚本不报时按 null（staging 形态）；报了就必须是非空字符串。
  const runner = interpreter === undefined || interpreter === null ? null : interpreter
  if (runner !== null && (typeof runner !== 'string' || runner === '')) return null
  return {
    homeDir: String(homeDir),
    nodeCommand: String(nodeCommand),
    nodeBin: String(nodeBin),
    dshCommand: String(dshCommand),
    interpreter: runner === null ? null : String(runner),
    dshRoot: String(dshRoot),
    source,
  }
}

/** 兼容入口：只要清单。 */
export async function readRemoteBundles(request: ReadBundlesRequest): Promise<readonly RemoteBundle[]> {
  const profile = await readRemoteProfile(request)
  return profile.bundles
}
