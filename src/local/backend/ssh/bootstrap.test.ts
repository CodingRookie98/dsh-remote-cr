import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { SshTarget } from './config.ts'
import {
  buildDshPackageScript,
  buildNodeRuntimeScript,
  buildStagingScript,
  buildTarPrecheckScript,
  compareVersions,
  decideBootstrap,
  DEFAULT_NODE_INSTALL_VERSION,
  DSH_ENGINE_HINT,
  dshSupported,
  emptyBootstrapState,
  markStep,
  NODE_ENGINE_HINT,
  nodeSupported,
  nodeTarballName,
  parseBootstrapState,
  parseVersion,
  pickMirror,
  planBootstrap,
  readBootstrapState,
  runBootstrap,
  stagingDirFor,
  summarizeMirrors,
  writeBootstrapState,
} from './bootstrap.ts'

const NL = String.fromCharCode(10)
const TARGET: SshTarget = {
  alias: 'syy',
  hostName: '198.51.100.8',
  user: 'hui',
  port: 22,
  identityFiles: [],
  proxyJump: [],
  source: { file: 'C:/Users/hui/.ssh/config', line: 20 },
}
const STATE = emptyBootstrapState('0123456789abcdef')

test('版本解析：v 前缀、预发布、build 元数据都要认', () => {
  assert.deepEqual(parseVersion('v24.22.1'), { major: 24, minor: 22, patch: 1, prerelease: [] })
  assert.deepEqual(parseVersion('0.2.1-rc.5+build.7'), { major: 0, minor: 2, patch: 1, prerelease: ['rc', '5'] })
  assert.equal(parseVersion('24.22'), undefined)
  assert.equal(parseVersion(''), undefined)
  assert.equal(parseVersion(undefined), undefined)
})

test('版本比较：rc.10 比 rc.5 新，正式版比任何预发布都新', () => {
  assert.ok(compareVersions('0.2.1-rc.10', '0.2.1-rc.5') > 0)
  assert.ok(compareVersions('0.2.1-rc.5', '0.2.1-rc.0') > 0)
  assert.ok(compareVersions('0.2.1', '0.2.1-rc.99') > 0)
  assert.equal(compareVersions('0.2.1-rc.5', '0.2.1-rc.5'), 0)
  assert.throws(() => compareVersions('nope', '0.2.1'), /不是合法的版本号/)
})

test('node 版本判定按 engines 那句 ^22.19.0 || >=24.0.0', () => {
  assert.equal(nodeSupported('v24.22.1'), true)
  assert.equal(nodeSupported('v22.19.0'), true)
  assert.equal(nodeSupported('v22.18.9'), false)
  assert.equal(nodeSupported('v23.1.0'), false)
  assert.equal(nodeSupported(undefined), false)
})

test('dsh 版本判定按 >=0.2.1-rc.0 <0.3.0', () => {
  assert.equal(dshSupported('0.2.1-rc.5'), true)
  assert.equal(dshSupported('0.2.1-rc.0'), true)
  assert.equal(dshSupported('0.2.1'), true)
  assert.equal(dshSupported('0.2.0-rc.3'), false)
  assert.equal(dshSupported('0.3.0'), false)
  assert.equal(dshSupported(undefined), false)
})

test('引擎范围文案与 package.json 逐字一致（两处漂移要在这里炸）', async () => {
  const text = await readFile('package.json', 'utf8')
  const manifest = JSON.parse(text) as { engines: { node: string; dsh: string }; dsh: { engines: { dsh: string } } }
  assert.equal(NODE_ENGINE_HINT, manifest.engines.node)
  assert.equal(DSH_ENGINE_HINT, manifest.dsh.engines.dsh)
})

test('远端两样都没有：两样都要装，理由分条写清', () => {
  const decision = decideBootstrap({ node: undefined, dsh: undefined })
  assert.equal(decision.needNode, true)
  assert.equal(decision.needDsh, true)
  assert.deepEqual(decision.reasons, ['远端没有 node', '远端没有 dsh'])
})

test('版本过低与没装要给不同理由：用户该做的动作不一样', () => {
  const decision = decideBootstrap({ node: 'v18.20.4', dsh: '0.1.9' })
  assert.equal(decision.needNode, true)
  assert.match(decision.reasons[0] ?? '', /v18\.20\.4 不满足/)
  assert.match(decision.reasons[1] ?? '', /0\.1\.9 不满足/)
})

test('两样都满足就一个都不装', () => {
  const decision = decideBootstrap({ node: 'v24.22.1', dsh: '0.2.1-rc.5' })
  assert.equal(decision.needNode, false)
  assert.equal(decision.needDsh, false)
  assert.match(decision.reasons.join(' '), /满足/)
})

test('镜像测速取最快的可达源，全不可达不猜', () => {
  const npmjs = { name: 'npmjs', registry: 'https://registry.npmjs.org/' }
  const mirror = { name: 'npmmirror', registry: 'https://registry.npmmirror.com/' }
  const chosen = pickMirror([
    { mirror: npmjs, ms: 800 },
    { mirror, ms: 120 },
  ])
  assert.equal(chosen?.name, 'npmmirror')
  assert.equal(pickMirror([{ mirror: npmjs, ms: undefined }, { mirror, ms: 40 }])?.name, 'npmmirror')
  assert.equal(pickMirror([{ mirror: npmjs, ms: undefined }]), undefined)
  assert.equal(pickMirror([]), undefined)
  assert.deepEqual(
    summarizeMirrors([{ mirror: npmjs, ms: undefined }, { mirror, ms: 120.4 }]),
    ['npmjs：不可达', 'npmmirror：120ms'],
  )
})

test('断点账本：坏记录不当空账本，版本不认识要单独说', () => {
  assert.equal(parseBootstrapState(null).ok, false)
  const wrongVersion = parseBootstrapState({ version: 2, targetId: 'x', steps: {} })
  assert.equal(wrongVersion.ok, false)
  assert.equal(wrongVersion.ok === false ? wrongVersion.problem : '', 'state-unsupported-version')
  const wrongTarget = parseBootstrapState({ version: 1, targetId: 'other', steps: {} }, 'mine')
  assert.equal(wrongTarget.ok === false ? wrongTarget.problem : '', 'state-invalid')
  const badStep = parseBootstrapState({ version: 1, targetId: 'mine', steps: { tar: { at: 1 } } })
  assert.equal(badStep.ok === false ? badStep.problem : '', 'state-invalid')
})

test('断点账本：读不到与坏 JSON 分别记账，round-trip 保真', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-cr-state-'))
  try {
    const file = join(dir, 'state.json')
    const missing = await readBootstrapState(file)
    assert.equal(missing.ok === false ? missing.problem : '', 'state-unreadable')

    await writeFile(file, '{ not json', 'utf8')
    const corrupted = await readBootstrapState(file)
    assert.equal(corrupted.ok === false ? corrupted.problem : '', 'state-corrupted')

    const marked = markStep(emptyBootstrapState('mine'), 'dsh', 'dsh 0.2.1-rc.5 已装', '2026-11-12T00:00:00.000Z')
    assert.deepEqual(STATE.steps, {}, 'markStep 不许改入参')
    await writeBootstrapState(file, marked)
    const loaded = await readBootstrapState(file, 'mine')
    assert.equal(loaded.ok, true)
    assert.equal(loaded.ok === true ? loaded.state.steps['dsh']?.detail : '', 'dsh 0.2.1-rc.5 已装')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('staging 目录跟着目标身份走，且绝不落在 /tmp', () => {
  const first = stagingDirFor('C:/Users/hui', TARGET)
  const second = stagingDirFor('C:/Users/hui', { ...TARGET, alias: 'ipy' })
  assert.equal(first, second, '别名不该改变目录')
  assert.match(first.replace(/\\/g, '/'), /\/\.dsh-remote-cr\/staging\/[0-9a-f]{16}$/)
  const other = stagingDirFor('C:/Users/hui', { ...TARGET, hostName: '198.51.100.9' })
  assert.notEqual(first, other)
  assert.equal(first.includes('/tmp'), false)
})

test('staging 脚本：建目录 + 收紧到 0700 + 回一个标记', () => {
  const script = buildStagingScript('/home/hui/.dsh-remote-cr/staging/abc')
  assert.match(script, /mkdir -p '\/home\/hui\/\.dsh-remote-cr\/staging\/abc'/)
  assert.match(script, /chmod 700 /)
  assert.match(script, /REMOTE_CR_STAGING_OK/)
})

test('tar 预检：缺 tar 当场退出 3 并打标记，让人一眼看出是环境问题', () => {
  const script = buildTarPrecheckScript()
  assert.match(script, /command -v tar/)
  assert.match(script, /REMOTE_CR_MISSING_TAR/)
  assert.match(script, /exit 3/)
  assert.match(script, /REMOTE_CR_TAR_OK/)
})

test('node 分发文件名按官方命名规则拼', () => {
  assert.equal(nodeTarballName('v24.22.1', 'linux', 'x64'), 'node-v24.22.1-linux-x64.tar.xz')
  assert.equal(nodeTarballName('v24.22.1', 'linux', 'arm64'), 'node-v24.22.1-linux-arm64.tar.xz')
})

test('node 安装脚本：有 curl 用 curl、没有就 wget、都没有退出 4，且只在缺 node 时下载', () => {
  const script = buildNodeRuntimeScript({
    stagingDir: '/home/hui/.dsh-remote-cr/staging/abc',
    version: DEFAULT_NODE_INSTALL_VERSION,
    platform: 'linux',
    arch: 'x64',
  })
  assert.match(script, /https:\/\/nodejs\.org\/dist\/v24\.22\.1\/node-v24\.22\.1-linux-x64\.tar\.xz/)
  assert.match(script, /command -v curl/)
  assert.match(script, /command -v wget/)
  assert.match(script, /REMOTE_CR_NO_DOWNLOADER/)
  assert.match(script, /exit 4/)
  // `=1` 后面不能跟逗号：曾经是 `=1,`，GNU tar 会把它读成元素个数 `1,` 直接失败。
  assert.match(script, /tar -xJf .* --strip-components=1(?!,)/)
  assert.match(script, /if \[ ! -x '\/home\/hui\/\.dsh-remote-cr\/staging\/abc'\/bin\/node \]; then/)
  assert.match(script, /REMOTE_CR_NODE_OK/)
})

test('dsh 安装脚本：源写进 NPM_CONFIG_REGISTRY，缺 npm 退出 5', () => {
  const script = buildDshPackageScript({ registry: 'https://registry.npmmirror.com/', dshHome: '/home/hui/.dsh', version: '0.2.1-rc.5' })
  assert.match(script, /NPM_CONFIG_REGISTRY='https:\/\/registry\.npmmirror\.com\/'/)
  // 包名必须带 scope：无 scope 的 dsh 是别人写的 JS shell（真机首跑装错的那个）。
  assert.match(script, /npm install --global --no-audit --no-fund '@deepseek-ai\/dsh@0\.2\.1-rc\.5'/)
  assert.equal(script.includes(" 'dsh@"), false, '不能装成无 scope 的 dsh')
  assert.match(script, /REMOTE_CR_MISSING_NPM/)
  assert.match(script, /exit 5/)
  const bare = buildDshPackageScript({ registry: 'https://registry.npmjs.org/', dshHome: '/home/hui/.dsh' })
  assert.match(bare, /npm install --global --no-audit --no-fund '@deepseek-ai\/dsh@latest'/)
})

test('dsh 装进 staging 前缀：非 root 也能装，且 PATH 指过去', () => {
  const script = buildDshPackageScript({
    registry: 'https://registry.npmjs.org/',
    dshHome: '/home/hui/.dsh',
    version: '0.2.1-rc.5',
    prefix: '/home/hui/.dsh-remote-cr/staging/abc/npm',
  })
  assert.match(script, /mkdir -p '\/home\/hui\/\.dsh-remote-cr\/staging\/abc\/npm'/)
  assert.match(script, /NPM_CONFIG_PREFIX='\/home\/hui\/\.dsh-remote-cr\/staging\/abc\/npm'/)
  assert.match(script, /export PATH='\/home\/hui\/\.dsh-remote-cr\/staging\/abc\/npm\/bin':\$PATH/)
  assert.ok(
    script.indexOf('mkdir -p') < script.indexOf('install --global'),
    '前缀目录必须先建出来，否则 npm 会因为父目录不存在而自己猜路径',
  )
  assert.ok(
    script.indexOf('install --global') < script.indexOf('export PATH'),
    'PATH 必须在装完之后才生效——否则 command -v dsh 看到的是系统里那份',
  )
  // 没给 prefix 时不能凭空写 NPM_CONFIG_PREFIX（会污染用户的全局 npm 配置）
  const noPrefix = buildDshPackageScript({ registry: 'https://registry.npmjs.org/', dshHome: '/home/hui/.dsh' })
  assert.ok(!noPrefix.includes('NPM_CONFIG_PREFIX'))
})

test('计划：staging 与 tar 永远排在最前，node 满足就不排', () => {
  const plan = planBootstrap({
    facts: { node: 'v24.22.1', dsh: '0.2.1-rc.5' },
    state: STATE,
    stagingDir: '/home/hui/.dsh-remote-cr/staging/abc',
  })
  assert.deepEqual(plan.steps.map((step) => step.id), ['staging', 'tar'])
  assert.deepEqual(plan.skipped.map((entry) => entry.id), ['node', 'dsh'])
})

test('计划：缺 dsh 就排安装，且账本记过也要重装（这次仍然没探到）', () => {
  const state = markStep(STATE, 'dsh', 'dsh 0.2.1-rc.2 曾装过')
  const plan = planBootstrap({
    facts: { node: 'v24.22.1', dsh: undefined },
    state,
    stagingDir: '/home/hui/.dsh-remote-cr/staging/abc',
    mirror: 'https://registry.npmmirror.com/',
  })
  const dsh = plan.steps.find((step) => step.id === 'dsh')
  assert.ok(dsh)
  assert.match(dsh.reuseReason ?? '', /dsh 0\.2\.1-rc\.2 曾装过/)
  assert.match(dsh.script, /registry\.npmmirror\.com/)
  // 计划层必须把前缀钉到 staging 里，否则远端非 root 装不动
  assert.match(dsh.script, /NPM_CONFIG_PREFIX='\/home\/hui\/\.dsh-remote-cr\/staging\/abc\/npm'/)
})

test('执行：任一步失败就停，后续步骤不跑，失败尾巴带出来', async () => {
  const ran: string[] = []
  const plan = planBootstrap({
    facts: { node: undefined, dsh: undefined },
    state: STATE,
    stagingDir: '/home/hui/.dsh-remote-cr/staging/abc',
    dshHome: '/home/hui/.dsh',
  })
  const outcome = await runBootstrap(plan, async (script) => {
    ran.push(script.split(NL)[0] ?? '')
    if (ran.length === 2) return { code: 3, stdout: '', stderr: 'REMOTE_CR_MISSING_TAR' + NL }
    return { code: 0, stdout: 'ok', stderr: '' }
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.failed?.id, 'tar')
  assert.equal(outcome.failed?.code, 3)
  assert.match(outcome.failed?.tail ?? '', /REMOTE_CR_MISSING_TAR/)
  assert.deepEqual(outcome.executed, ['staging'])
  assert.equal(ran.length, 2, '失败之后不许继续跑')
})

test('执行：全绿时按 staging → tar → node → dsh 顺序记账', async () => {
  const plan = planBootstrap({
    facts: { node: undefined, dsh: undefined },
    state: STATE,
    stagingDir: '/home/hui/.dsh-remote-cr/staging/abc',
    dshHome: '/home/hui/.dsh',
  })
  const outcome = await runBootstrap(plan, async () => ({ code: 0, stdout: '', stderr: '' }))
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.executed, ['staging', 'tar', 'node', 'dsh'])
})

test('复用系统 node 时 dsh 安装走 PATH 上的 npm，不去调 staging/bin/npm（真机 127 回归）', async () => {
  const { planBootstrap } = await import('./bootstrap.ts')
  const plan = planBootstrap({
    facts: { node: 'v22.22.1', dsh: '' },
    state: emptyBootstrapState('0123456789abcdef'),
    stagingDir: '/home/hui/.dsh-remote-cr/staging/abcdef',
    dshHome: '/home/hui/.dsh',
  })
  const dshStep = plan.steps.find((step) => step.id === 'dsh')
  assert.ok(dshStep, 'node 已满足时仍然要排 dsh 安装步骤')
  assert.ok(!dshStep.script.includes('/bin/npm'), 'node 步骤没跑过，staging/bin/npm 根本不存在')
  assert.match(dshStep.script, /npm install --global/)
  assert.ok(plan.skipped.some((step) => step.id === 'node'))
})

test('需要自装 node 时，dsh 安装走 staging/bin 里那份 npm', async () => {
  const { planBootstrap } = await import('./bootstrap.ts')
  const plan = planBootstrap({
    facts: { node: '', dsh: '' },
    state: emptyBootstrapState('0123456789abcdef'),
    stagingDir: '/home/hui/.dsh-remote-cr/staging/abcdef',
    dshHome: '/home/hui/.dsh',
  })
  const dshStep = plan.steps.find((step) => step.id === 'dsh')
  assert.ok(dshStep)
  assert.match(dshStep.script, /\/staging\/abcdef\/bin\/npm/)
})

test('buildDshPackageScript：没有 nodeBin 时不做 prefix/bin/npm 的无用探测', () => {
  const script = buildDshPackageScript({ registry: 'https://registry.npmjs.org/', dshHome: '/home/hui/.dsh', prefix: '/s/npm' })
  assert.ok(!script.includes('/s/npm/bin/npm'), script)
  assert.match(script, /command -v npm/)
  assert.match(script, /npm install --global/)
})
