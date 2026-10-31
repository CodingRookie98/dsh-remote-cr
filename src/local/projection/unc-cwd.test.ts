import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  linuxPathOf,
  projectContexts,
  projectSandboxPolicy,
  projectWorkingDirectory,
  SANDBOX_POLICY_CONTEXT,
  WORKING_DIRECTORY_CONTEXT,
} from './unc-cwd.ts'

const NEG = process.env.NEGATIVE_CONTROL === '1'

/**
 * 负控的变异点落在**输入**上，不落在期望值上。
 *
 * P37-5 / P37-6 的教训：期望值跟着负控开关走、或变异同时影响两个操作数，
 * 断言就恒真。这里把 UNC 前缀换成普通共享路径（`\\\\server\\share\\...`），
 * 实现按设计对它返回 undefined，观测值真的变，期望值一个字不改 —— 负控必红。
 */
const PREFIX = NEG ? '\\\\server\\share\\' : '\\\\wsl.localhost\\'

const UNC_WORKSPACE = PREFIX + 'ubuntu_dev\\home\\hui\\workspace'
const UNC_SHARE_ROOT = PREFIX + 'ubuntu_dev'
const UNC_DOLLAR = (NEG ? '\\\\server\\share\\' : '\\\\wsl$\\') + 'ubuntu_dev\\etc'

test('linuxPathOf：两种 UNC 前缀都折成 POSIX，share 根折成 /', () => {
  assert.equal(linuxPathOf(UNC_WORKSPACE), '/home/hui/workspace')
  assert.equal(linuxPathOf(UNC_SHARE_ROOT), '/')
  // \\wsl$\ 与 \\wsl.localhost\ 等价（wsl/unc.ts 的两个候选前缀）。
  assert.equal(linuxPathOf(UNC_DOLLAR), '/etc')
})

test('linuxPathOf：非 WSL UNC 一律 undefined（盘符 / POSIX / 普通共享）', () => {
  // 这三条是「投影器对非 WSL 后端退化成恒等函数」的判据。
  assert.equal(linuxPathOf('D:\\workspace\\projects'), undefined)
  assert.equal(linuxPathOf('/home/hui/workspace'), undefined)
  assert.equal(linuxPathOf('\\\\server\\share\\dir'), undefined)
  // 盘符路径里也有反斜杠与冒号，宽松匹配会把 D:\ 当成 share 名。
  assert.equal(linuxPathOf('C:\\'), undefined)
})

test('projectWorkingDirectory：整行锚定的 UNC 行被改写，其余原样', () => {
  const uncLine = 'Current working directory: ' + JSON.stringify(UNC_WORKSPACE) + '.'
  assert.equal(projectWorkingDirectory(uncLine), 'Current working directory: "/home/hui/workspace".')

  // 本地 Windows 工作区：必须是恒等（否则就是拿 WSL 的补丁污染本机后端）。
  const localLine = 'Current working directory: "D:\\\\workspace".'
  assert.equal(projectWorkingDirectory(localLine), localLine)

  // 形态不对（没有结尾句点 / 不是整行）时不动手：宁可少改，不可乱改。
  assert.equal(projectWorkingDirectory('Current working directory: "/home/hui".'), 'Current working directory: "/home/hui".')
  assert.equal(
    projectWorkingDirectory('prefix Current working directory: ' + JSON.stringify(UNC_WORKSPACE) + '.'),
    'prefix Current working directory: ' + JSON.stringify(UNC_WORKSPACE) + '.',
  )
  // JSON 解析不了的引号内容也不能炸。
  const broken = 'Current working directory: "\\wsl.localhost\\ubuntu_dev".'
  assert.equal(projectWorkingDirectory(broken), broken)
})

test('projectSandboxPolicy：只改 the session workspace 那一段，前后文原样', () => {
  const text = 'Sandbox: workspace-write. Files may be written inside the session workspace: '
    + JSON.stringify(UNC_WORKSPACE) + '; everything else is read-only.'
  const projected = projectSandboxPolicy(text)
  assert.equal(
    projected,
    'Sandbox: workspace-write. Files may be written inside the session workspace: '
      + JSON.stringify('/home/hui/workspace') + '; everything else is read-only.',
  )

  // 没有 marker / marker 后不是 JSON / 不是 UNC：三种都原样返回。
  const noMarker = 'Sandbox: read-only.'
  assert.equal(projectSandboxPolicy(noMarker), noMarker)
  const notJson = 'the session workspace: /home/hui/workspace'
  assert.equal(projectSandboxPolicy(notJson), notJson)
  const local = 'the session workspace: ' + JSON.stringify('D:\\\\workspace')
  assert.equal(projectSandboxPolicy(local), local)
})

test('projectContexts：两处都命中时给出两条改写记录，且不改动入参', () => {
  const contexts = [
    { name: WORKING_DIRECTORY_CONTEXT, text: 'Current working directory: ' + JSON.stringify(UNC_WORKSPACE) + '.' },
    { name: SANDBOX_POLICY_CONTEXT, text: 'the session workspace: ' + JSON.stringify(UNC_WORKSPACE) },
    { name: 'time-context', text: 'Now: 2026-10-31.' },
  ]
  const snapshot = JSON.stringify(contexts)
  const rewrites = projectContexts(contexts)
  assert.equal(rewrites.length, 2)
  assert.deepEqual(rewrites.map((entry) => entry.context), [WORKING_DIRECTORY_CONTEXT, SANDBOX_POLICY_CONTEXT])
  // before/after 都要留证：只有「改了几条」而不留原文，事后无法证明改对了。
  assert.equal(rewrites[0]?.after, 'Current working directory: "/home/hui/workspace".')
  assert.equal(rewrites[0]?.before, contexts[0]?.text)
  assert.equal(JSON.stringify(contexts), snapshot)
})

test('projectContexts：本地工作区一条都不改（恒等）', () => {
  const localCwd = 'Current working directory: ' + JSON.stringify('D:\\\\workspace') + '.'
  const localPolicy = 'the session workspace: ' + JSON.stringify('D:\\\\workspace')
  const rewrites = projectContexts([
    { name: WORKING_DIRECTORY_CONTEXT, text: localCwd },
    { name: SANDBOX_POLICY_CONTEXT, text: localPolicy },
  ])
  // NEGATIVE_CONTROL: 变异把 UNC 前缀换成普通共享路径，两条都折不出 POSIX，
  // 于是 rewrites 为空 —— 若实现退化成「无脑改写」，这里就会红。
  assert.deepEqual(rewrites, [])
})
