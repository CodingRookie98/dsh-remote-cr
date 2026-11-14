import { dirname, posix } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { anchorIdFor, anchorTargetOf } from "./anchors.js";
import { shellQuote } from "../posix-probe.js";
/** 与 package.json 的 engines 保持同一句话；两处不一致时以 package.json 为准（有测试对照）。 */
export const NODE_ENGINE_HINT = '^22.19.0 || >=24.0.0';
export const DSH_ENGINE_HINT = '>=0.2.1-rc.0 <0.3.0';
/** 远端没有 node 时安装的版本（与 M1 真机验证过的版本一致）。 */
export const DEFAULT_NODE_INSTALL_VERSION = 'v24.22.1';
/**
 * 宿主的 npm 包名。**必须带 scope**：npm 上无 scope 的 `dsh` 是另一个人写的 JS shell
 * （infusion/node-dsh，描述是 'A shell written in JavaScript'）。2026-11-12 真机首跑就是
 * 照 `dsh@latest` 装的，装完 `npm/lib/node_modules/dsh/package.json` 里写着 "shell"，
 * 而我们的检查只看 `<prefix>/bin/dsh` 存不存在——于是「装好了」但装的是别的软件。
 */
export const DSH_PACKAGE_NAME = '@deepseek-ai/dsh';
export const STAGING_DIR_NAME = 'staging';
export const BOOTSTRAP_STATE_FILENAME = 'state.json';
export const BOOTSTRAP_STATE_VERSION = 1;
/** 解析 `v24.22.1` / `24.22.1` / `0.2.1-rc.5` / `0.2.1-rc.5+build`；解析不了返回 undefined。 */
export function parseVersion(value) {
    if (value === undefined)
        return undefined;
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
    if (match === null)
        return undefined;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch))
        return undefined;
    const prerelease = match[4] === undefined ? [] : match[4].split('.');
    return { major, minor, patch, prerelease };
}
/** 数字段顺序比较；预发布标识里数字比字母小，缺预发布（正式版）比任何预发布大。 */
function compareIdentifiers(a, b) {
    for (const key of ['major', 'minor', 'patch']) {
        if (a[key] !== b[key])
            return a[key] < b[key] ? -1 : 1;
    }
    if (a.prerelease.length === 0 && b.prerelease.length === 0)
        return 0;
    if (a.prerelease.length === 0)
        return 1;
    if (b.prerelease.length === 0)
        return -1;
    const length = Math.max(a.prerelease.length, b.prerelease.length);
    for (let index = 0; index < length; index += 1) {
        const left = a.prerelease[index];
        const right = b.prerelease[index];
        if (left === undefined)
            return -1;
        if (right === undefined)
            return 1;
        const leftNumeric = /^\d+$/.test(left);
        const rightNumeric = /^\d+$/.test(right);
        if (leftNumeric && rightNumeric) {
            const delta = Number(left) - Number(right);
            if (delta !== 0)
                return delta < 0 ? -1 : 1;
        }
        else if (leftNumeric) {
            return -1;
        }
        else if (rightNumeric) {
            return 1;
        }
        else if (left !== right) {
            return left < right ? -1 : 1;
        }
    }
    return 0;
}
/** `compareVersions('0.2.1-rc.10','0.2.1-rc.5') > 0`；任何一侧解析不了就抛错（不猜）。 */
export function compareVersions(left, right) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (a === undefined)
        throw new Error('不是合法的版本号：' + left);
    if (b === undefined)
        throw new Error('不是合法的版本号：' + right);
    return compareIdentifiers(a, b);
}
/** `^22.19.0 || >=24.0.0`。 */
export function nodeSupported(version) {
    const parsed = parseVersion(version);
    if (parsed === undefined)
        return false;
    if (parsed.major === 22)
        return parsed.minor >= 19;
    return parsed.major >= 24;
}
/** `>=0.2.1-rc.0 <0.3.0`。 */
export function dshSupported(version) {
    const parsed = parseVersion(version);
    if (parsed === undefined)
        return false;
    if (parsed.major !== 0 || parsed.minor !== 2)
        return false;
    return compareIdentifiers(parsed, { major: 0, minor: 2, patch: 1, prerelease: ['rc', '0'] }) >= 0;
}
/**
 * 决定远端要不要装东西。
 *
 * 只回答「装不装」，不回答「怎么装」——装法是 `planBootstrap` 的事。
 * 版本不在范围内一律按「没有」处理，但理由分开写：用户看到「版本过低」和看到
 * 「没装」会采取完全不同的动作。
 */
export function decideBootstrap(facts) {
    const reasons = [];
    const needNode = !nodeSupported(facts.node);
    if (facts.node === undefined)
        reasons.push('远端没有 node');
    else if (needNode)
        reasons.push('远端 node ' + facts.node + ' 不满足 ' + NODE_ENGINE_HINT);
    else
        reasons.push('远端 node ' + facts.node + ' 满足 ' + NODE_ENGINE_HINT);
    const needDsh = !dshSupported(facts.dsh);
    if (facts.dsh === undefined)
        reasons.push('远端没有 dsh');
    else if (needDsh)
        reasons.push('远端 dsh ' + facts.dsh + ' 不满足 ' + DSH_ENGINE_HINT);
    else
        reasons.push('远端 dsh ' + facts.dsh + ' 满足 ' + DSH_ENGINE_HINT);
    return { needNode, needDsh, reasons };
}
export function emptyBootstrapState(targetId) {
    return { version: BOOTSTRAP_STATE_VERSION, targetId, steps: {} };
}
/** 解析落盘的断点账本；**坏记录不当空账本**，否则重装会从第一步重来。 */
export function parseBootstrapState(value, targetId) {
    if (value === null || typeof value !== 'object') {
        return { ok: false, problem: 'state-invalid', message: '断点账本不是对象。' };
    }
    const record = value;
    const version = record['version'];
    if (typeof version !== 'number' || !Number.isInteger(version)) {
        return { ok: false, problem: 'state-invalid', message: '断点账本缺少合法的 version。' };
    }
    if (version !== BOOTSTRAP_STATE_VERSION) {
        return { ok: false, problem: 'state-unsupported-version', message: '断点账本版本 ' + String(version) + ' 不认识（当前 ' + String(BOOTSTRAP_STATE_VERSION) + '）。' };
    }
    const id = record['targetId'];
    if (typeof id !== 'string' || id === '') {
        return { ok: false, problem: 'state-invalid', message: '断点账本缺少 targetId。' };
    }
    if (targetId !== undefined && id !== targetId) {
        return { ok: false, problem: 'state-invalid', message: '断点账本属于 ' + id + '，不是 ' + targetId + '。' };
    }
    const rawSteps = record['steps'];
    if (rawSteps === null || typeof rawSteps !== 'object') {
        return { ok: false, problem: 'state-invalid', message: '断点账本缺少 steps。' };
    }
    const steps = {};
    for (const [key, entry] of Object.entries(rawSteps)) {
        if (entry === null || typeof entry !== 'object') {
            return { ok: false, problem: 'state-invalid', message: '步骤 ' + key + ' 的记录不是对象。' };
        }
        const at = entry['at'];
        const detail = entry['detail'];
        if (typeof at !== 'string' || typeof detail !== 'string') {
            return { ok: false, problem: 'state-invalid', message: '步骤 ' + key + ' 缺少 at 或 detail。' };
        }
        steps[key] = { at, detail };
    }
    const mirror = record['mirror'];
    if (mirror !== undefined && typeof mirror !== 'string') {
        return { ok: false, problem: 'state-invalid', message: '断点账本的 mirror 不是字符串。' };
    }
    const state = mirror === undefined
        ? { version, targetId: id, steps }
        : { version, targetId: id, steps, mirror };
    return { ok: true, state };
}
export async function readBootstrapState(file, targetId) {
    let text;
    try {
        text = await readFile(file, 'utf8');
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT')
            return { ok: false, problem: 'state-unreadable', message: '还没有断点账本：' + file };
        return { ok: false, problem: 'state-unreadable', message: '读不到断点账本：' + file + '（' + error.message + '）' };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        return { ok: false, problem: 'state-corrupted', message: '断点账本不是合法 JSON：' + file };
    }
    return parseBootstrapState(parsed, targetId);
}
export async function writeBootstrapState(file, state) {
    await mkdir(dirname(file), { recursive: true });
    const temporary = file + '.tmp-' + String(process.pid);
    await writeFile(temporary, JSON.stringify(state, null, 2) + String.fromCharCode(10), 'utf8');
    await rename(temporary, file);
}
/** 记一步完成；返回新对象，不改入参（断点账本要能随时回滚到上一份）。 */
export function markStep(state, step, detail, at = new Date().toISOString()) {
    return { ...state, steps: { ...state.steps, [step]: { at, detail } } };
}
export function stagingDirFor(homeDir, target) {
    // staging 与锚点共用同一个目标身份（sha256(user@host:port) 前 16 位），否则同一个远端会有两套目录。
    // homeDir 是**远端** home（探测拿到的 facts.home），不是本机 homedir()：
    // 传本地路径时远端会得到一个名为 C:/Users/... 的相对目录，每条 mkdir 都 exit 0，
    // 于是「引导成功」而 staging 里空无一物——2026-11-12 真机首跑就是这么假通过的。
    // 必须是 posix.join：这里的 homeDir 是**远端** home，Windows 上 win32 join 会产出
    // `/home/hui\.dsh-teleport\staging\<id>`，远端 bash 把反斜杠当转义符，mkdir 于是
    // 建出一个名字诡异的目录而退出码仍是 0（2026-11-12 真机 S9 就是这么假通过的）。
    return posix.join(homeDir, '.dsh-teleport', STAGING_DIR_NAME, anchorIdFor(anchorTargetOf(target)));
}
export function bootstrapStatePathFor(homeDir, target) {
    return posix.join(stagingDirFor(homeDir, target), BOOTSTRAP_STATE_FILENAME);
}
/** 默认三个 npm 源：官方、npmmirror、腾讯云镜像。 */
export const DEFAULT_MIRRORS = [
    { name: 'npmjs', registry: 'https://registry.npmjs.org/' },
    { name: 'npmmirror', registry: 'https://registry.npmmirror.com/' },
    { name: 'tencent', registry: 'https://mirrors.cloud.tencent.com/npm/' },
];
/** 取最快的**可达**源；全都不可达返回 undefined（交给调用方硬失败，不猜一个）。 */
export function pickMirror(measurements) {
    let best;
    for (const measurement of measurements) {
        if (measurement.ms === undefined)
            continue;
        if (best === undefined || (best.ms ?? 0) > measurement.ms)
            best = measurement;
    }
    return best?.mirror;
}
export function summarizeMirrors(measurements) {
    return measurements.map((measurement) => measurement.mirror.name + '：' + (measurement.ms === undefined ? '不可达' : String(Math.round(measurement.ms)) + 'ms'));
}
/** 私有 staging 目录：0700，绝不落 /tmp（/tmp 会被清理、也可能被同机他人读到）。 */
export function buildStagingScript(stagingDir) {
    const dir = shellQuote(stagingDir);
    return ['mkdir -p ' + dir, 'chmod 700 ' + dir, 'echo TELEPORT_STAGING_OK'].join(String.fromCharCode(10));
}
/** `tar` 预检：缺 tar 就当场失败并打标记，而不是等解包时给一条看不懂的报错。 */
export function buildTarPrecheckScript() {
    return [
        'command -v tar >/dev/null 2>&1 || { echo TELEPORT_MISSING_TAR; exit 3; }',
        'tar --version 2>/dev/null | head -n 1',
        'echo TELEPORT_TAR_OK',
    ].join(String.fromCharCode(10));
}
/** node 官方分发包的文件名（linux-x64 / linux-arm64 / darwin-x64 …）。 */
export function nodeTarballName(version, platform, arch) {
    return 'node-' + version + '-' + platform + '-' + arch + '.tar.xz';
}
export function buildNodeRuntimeScript(request) {
    const base = request.downloadBase ?? 'https://nodejs.org/dist';
    const tarball = nodeTarballName(request.version, request.platform, request.arch);
    const dir = shellQuote(request.stagingDir);
    const file = shellQuote(request.stagingDir + '/' + tarball);
    const url = shellQuote(base + '/' + request.version + '/' + tarball);
    return [
        'set -e',
        'mkdir -p ' + dir,
        'command -v tar >/dev/null 2>&1 || { echo TELEPORT_MISSING_TAR; exit 3; }',
        'if [ ! -x ' + dir + '/bin/node ]; then',
        '  if command -v curl >/dev/null 2>&1; then curl -fsSL -o ' + file + ' ' + url + ';',
        '  elif command -v wget >/dev/null 2>&1; then wget -q -O ' + file + ' ' + url + ';',
        '  else echo TELEPORT_NO_DOWNLOADER; exit 4; fi;',
        '  tar -xJf ' + file + ' -C ' + dir + ' --strip-components=1',
        'fi',
        dir + '/bin/node --version',
        'echo TELEPORT_NODE_OK',
    ].join(String.fromCharCode(10));
}
/**
 * 装 dsh：npm 前缀写进 staging，DSH_HOME 指到固定的 home 路径（不塞 /tmp）。
 *
 * 必须带 `--prefix`：远端通常不是以 root 登录，`--global` 会去写 /usr/local 然后 EACCES；
 * 写进 staging 之后这份安装是可删的、可复现的，也不会污染目标机已有的 node 生态。
 */
export function buildDshPackageScript(request) {
    const spec = request.version === undefined ? DSH_PACKAGE_NAME + '@latest' : DSH_PACKAGE_NAME + '@' + request.version;
    // 目标机上未必有系统 npm（WSL 常见）：引导器把 node/npm 装进了 prefix，所以检查 npm 要看
    // prefix 里那份、安装也走它的**绝对路径**；而 PATH 仍然只在装完之后导出 —— 否则
    // `command -v dsh` 会撞上系统里已有的那份，校验就失去意义。
    const hasPrefix = request.prefix !== undefined && request.prefix !== '';
    const nodeBin = request.nodeBin === undefined || request.nodeBin === '' ? undefined : request.nodeBin;
    // npm 随 node 落在 `nodeBin`，而 `prefix` 只是**安装**前缀（dsh 会进 prefix/bin）。
    // 曾经用 prefix/bin/npm 去探测，结果在干净机器上必然 exit 5。
    const npmCommand = nodeBin !== undefined
        ? shellQuote(nodeBin + '/npm')
        : hasPrefix
            ? shellQuote(request.prefix + '/bin/npm')
            : 'npm';
    const npmCheck = nodeBin !== undefined || hasPrefix
        ? 'command -v npm >/dev/null 2>&1 || [ -x ' + npmCommand + ' ] || { echo TELEPORT_MISSING_NPM; exit 5; }'
        : 'command -v npm >/dev/null 2>&1 || { echo TELEPORT_MISSING_NPM; exit 5; }';
    const lines = [
        'set -e',
        npmCheck,
    ];
    // npm 自己是 `#!/usr/bin/env node` 的脚本：**安装阶段**必须让 node 在 PATH 里，
    // 否则干净机器上会以 127 退出（/usr/bin/env: node: No such file）。
    // 与下面「装完再导出 prefix/bin」不冲突：nodeBin 里没有 dsh，prefix/bin 里没有 node。
    if (nodeBin !== undefined)
        lines.push('export PATH=' + shellQuote(nodeBin) + ':$PATH');
    const env = ['NPM_CONFIG_REGISTRY=' + shellQuote(request.registry)];
    if (request.prefix !== undefined && request.prefix !== '') {
        const prefix = shellQuote(request.prefix);
        env.push('NPM_CONFIG_PREFIX=' + prefix);
        lines.push('mkdir -p ' + prefix);
    }
    lines.push(env.join(' ') + ' ' + npmCommand + ' install --global --no-audit --no-fund ' + shellQuote(spec));
    if (request.prefix !== undefined && request.prefix !== '') {
        lines.push('export PATH=' + shellQuote(request.prefix + '/bin') + ':$PATH');
    }
    lines.push('export DSH_HOME=' + shellQuote(request.dshHome));
    lines.push('command -v dsh >/dev/null 2>&1 && dsh --version || echo TELEPORT_DSH_NOT_ON_PATH');
    lines.push('echo TELEPORT_DSH_OK');
    return lines.join(String.fromCharCode(10));
}
/** exactOptionalPropertyTypes 下可选字段不能显式给 undefined，所以这里按需拼。 */
function nodeRequestOf(request, version) {
    const built = {
        stagingDir: request.stagingDir,
        version,
        platform: request.platform ?? 'linux',
        arch: request.arch ?? 'x64',
    };
    if (request.downloadBase !== undefined)
        built.downloadBase = request.downloadBase;
    return built;
}
function dshRequestOf(request) {
    const built = {
        registry: request.mirror ?? DEFAULT_MIRRORS[0]?.registry ?? 'https://registry.npmjs.org/',
        dshHome: request.dshHome ?? '',
        prefix: request.stagingDir + '/npm',
        nodeBin: request.stagingDir + '/bin',
    };
    if (request.dshVersion !== undefined)
        built.version = request.dshVersion;
    return built;
}
/**
 * 排一遍要跑什么。
 *
 * 断点账本里已经做完、且产物版本仍然对得上的步骤不再排进来——但 staging 与 tar 这
 * 两步永远排（它们便宜，而且远端可能被人删过目录），重复执行是幂等的。
 */
export function planBootstrap(request) {
    const decision = decideBootstrap(request.facts);
    const steps = [];
    const skipped = [];
    steps.push({ id: 'staging', title: '建立私有 staging 目录（0700）', script: buildStagingScript(request.stagingDir) });
    steps.push({ id: 'tar', title: '预检远端 tar', script: buildTarPrecheckScript() });
    if (decision.needNode) {
        const version = request.nodeVersion ?? DEFAULT_NODE_INSTALL_VERSION;
        steps.push({
            id: 'node',
            title: '把 node ' + version + ' 解到 staging',
            script: buildNodeRuntimeScript(nodeRequestOf(request, version)),
        });
    }
    else {
        skipped.push({ id: 'node', reason: '远端 node ' + String(request.facts.node) + ' 已满足' });
    }
    if (decision.needDsh) {
        const recorded = request.state.steps['dsh'];
        if (recorded === undefined) {
            steps.push({
                id: 'dsh',
                title: '安装 dsh 到 staging 前缀',
                script: buildDshPackageScript(dshRequestOf(request)),
            });
        }
        else {
            steps.push({
                id: 'dsh',
                title: '重装 dsh（账本记录过，但这次仍未探测到可用版本）',
                script: buildDshPackageScript(dshRequestOf(request)),
                reuseReason: '账本记着 ' + recorded.detail + '，但远端仍未探测到满足范围的 dsh',
            });
        }
    }
    else {
        skipped.push({ id: 'dsh', reason: '远端 dsh ' + String(request.facts.dsh) + ' 已满足' });
    }
    return { decision, stagingDir: request.stagingDir, steps, skipped, mirror: request.mirror };
}
/** 顺序执行；**任一步失败就停**（后面的步骤都依赖前一步的产物，硬着头皮跑只会掩盖根因）。 */
export async function runBootstrap(plan, run) {
    const executed = [];
    for (const step of plan.steps) {
        const outcome = await run(step.script);
        if (outcome.code !== 0) {
            return { ok: false, executed, failed: { id: step.id, code: outcome.code, tail: tailOf(outcome.stderr !== '' ? outcome.stderr : outcome.stdout) } };
        }
        executed.push(step.id);
    }
    return { ok: true, executed, failed: undefined };
}
function tailOf(text, lines = 6) {
    const kept = text.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-lines);
    return kept.length === 0 ? '（无输出）' : kept.join(' / ');
}
//# sourceMappingURL=bootstrap.js.map