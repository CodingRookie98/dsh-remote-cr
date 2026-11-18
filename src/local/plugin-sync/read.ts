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

export interface ReadBundlesRequest {
  readonly exec: SyncExec
  /** 远端 node 的可执行描述：绝对路径，或 'node'（依赖 PATH）。 */
  readonly nodeCommand: string
  /** DSH profile 名，默认 web。 */
  readonly profile?: string
  /** 远端 home（用于定位 `<home>/.dsh/profiles`）；空则由脚本用 os.homedir()。 */
  readonly homeDir?: string
  readonly deadlineMs?: number
}

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
  "const home=os.homedir()",
  "let runtime=null",
  "try{var stagingRoot=path.join(home,'.dsh-remote-cr','staging');var dirs=fs.readdirSync(stagingRoot).filter(function(id){return fs.existsSync(path.join(stagingRoot,id,'npm','bin','dsh'))});if(dirs.length>0){var dir=path.join(stagingRoot,dirs[0]);var nodeCandidate=path.join(dir,'bin','node');var hasNode=fs.existsSync(nodeCandidate);runtime={homeDir:home,nodeCommand:hasNode?nodeCandidate:'node',nodeBin:hasNode?path.join(dir,'bin'):'$PATH',dshCommand:path.join(dir,'npm','bin','dsh'),stagingDir:dir}}}catch(e){}",
  "console.log(JSON.stringify({ok:true,root:base,profile:profile,bundles:rows,runtime:runtime}))",
].join(';')

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
}): string {
  const encoded = encodeScript(READER)
  const profileDir = request.homeDir === '' ? '' : request.homeDir + '/.dsh/profiles/' + request.profile
  return [
    'set -e',
    'f=$(mktemp)',
    'trap \'rm -f "$f"\' EXIT',
    'printf %s ' + shellQuote(encoded) + ' | base64 -d > "$f"',
    'PATH=' + shellQuote(dirnameOf(request.nodeCommand)) + ':$PATH ' + shellQuote(request.nodeCommand) +
      ' "$f" ' + shellQuote(profileDir) + ' ' + shellQuote(request.profile),
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
  readonly stagingDir: string
}

interface ReaderPayload {
  readonly ok?: boolean
  readonly reason?: string
  readonly detail?: string
  readonly root?: string
  readonly bundles?: readonly { readonly name?: string; readonly version?: string | null; readonly error?: string | null }[]
  readonly runtime?: Partial<RemoteRuntimePaths> | null
}

/**
 * 读一次远端 bundle 清单。
 *
 * 只在「脚本跑不动 / 输出不是 JSON / ok=false」时抛结构化错误；单个包读不到版本
 * 是**正常事实**（官方包在 profile 里就是 ENOENT），交给 diff 判定。
 */
export interface RemoteProfileRead {
  readonly bundles: readonly RemoteBundle[]
  /** 远端 staging 里没装 dsh 时为 null（此时同步应当提示「先接入一次」）。 */
  readonly runtime: RemoteRuntimePaths | null
}

export async function readRemoteProfile(request: ReadBundlesRequest): Promise<RemoteProfileRead> {
  const profile = request.profile ?? 'web'
  const script = buildReadScript({ nodeCommand: request.nodeCommand, profile, homeDir: request.homeDir ?? '' })
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
  return { bundles, runtime: readRuntime(payload.runtime) }
}

/** 把脚本回报的 runtime 收窄成可信形状；缺字段就整体当 null（不猜路径）。 */
function readRuntime(raw: Partial<RemoteRuntimePaths> | null | undefined): RemoteRuntimePaths | null {
  if (raw === null || raw === undefined) return null
  const { homeDir, nodeCommand, nodeBin, dshCommand, stagingDir } = raw
  if ([homeDir, nodeCommand, nodeBin, dshCommand, stagingDir].some((value) => typeof value !== 'string' || value === '')) {
    return null
  }
  return {
    homeDir: String(homeDir),
    nodeCommand: String(nodeCommand),
    nodeBin: String(nodeBin),
    dshCommand: String(dshCommand),
    stagingDir: String(stagingDir),
  }
}

/** 兼容入口：只要清单。 */
export async function readRemoteBundles(request: ReadBundlesRequest): Promise<readonly RemoteBundle[]> {
  const profile = await readRemoteProfile(request)
  return profile.bundles
}
