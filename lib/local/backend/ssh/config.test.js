import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { expandSshPath, listSshTargets, matchHostPattern, parseSshConfig, readSshConfig, resolveSshTarget, } from "./config.js";
/**
 * 本机 `C:/Users/hui/.ssh/config` 的**逐字副本**（2026-11-12 通读，66 行）。
 *
 * 为什么要用真样本：这份文件同时踩中三个坑——一行四个别名、Windows 反斜杠路径、
 * 四个 `IdentityFile` 指向 `.pub` 公钥。用「整洁的假配置」写测试，这三个坑一个都覆盖不到。
 */
const REAL_CONFIG = String.raw `Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519

Host syy
  HostName 198.51.100.8
  Port 22
  User dev
  IdentityFile ~/.ssh/id_ed25519

Host 139.180.139.97
  HostName 139.180.139.97
  User root
  IdentityFile ~/.ssh/id_ed25519

Host ssy_ubuntu_dev_lan
  HostName 198.51.100.55
  Port 2222
  User hui
  IdentityFile ~\.ssh\id_ed25519.pub

Host ssy_pc
  HostName 203.0.113.145
  Port 22
  User dev
  IdentityFile ~\.ssh\id_ed25519

Host target-host
  HostName 203.0.113.145
  Port 22
  User dev
  IdentityFile ~\.ssh\id_ed25519

Host ssy_ubuntu_dev_zt
  HostName 203.0.113.70
  Port 2222
  User hui
  IdentityFile ~\.ssh\id_ed25519

Host hui-com_ubuntu
  HostName 192.168.2.110
  Port 22
  User hui
  IdentityFile ~\.ssh\id_ed25519.pub

Host hui-com_ubuntu_zt
  HostName 203.0.113.24
  Port 22
  User hui
  IdentityFile ~\.ssh\id_ed25519.pub

Host hui-com-gitea_ubuntu_zt
  HostName 203.0.113.24
  Port 2222
  User hui
  IdentityFile ~\.ssh\id_ed25519.pub

# Google Cloud Platform (GCP 香港服务器) - 自托管服务栈
Host gcp gcp-vps self-hosted hindsight-server
  HostName 203.0.113.10
  Port 22
  User hui
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 60
  ServerAliveCountMax 3`;
const HOME = 'C:/Users/hui';
const OPTIONS = { homeDir: HOME };
const parsedReal = parseSshConfig(REAL_CONFIG, 'config');
test('真实配置：11 个 Host 块、14 个别名一个都不丢', () => {
    assert.equal(parsedReal.blocks.length, 11);
    const { targets } = listSshTargets(parsedReal, OPTIONS);
    assert.equal(targets.length, 14);
    assert.deepEqual(targets.map((target) => target.alias), [
        'github.com',
        'syy',
        '139.180.139.97',
        'ssy_ubuntu_dev_lan',
        'ssy_pc',
        'target-host',
        'ssy_ubuntu_dev_zt',
        'hui-com_ubuntu',
        'hui-com_ubuntu_zt',
        'hui-com-gitea_ubuntu_zt',
        'gcp',
        'gcp-vps',
        'self-hosted',
        'hindsight-server',
    ]);
});
test('一行四个别名共享同一个 HostName/User/私钥，不能只认第一个词', () => {
    for (const alias of ['gcp', 'gcp-vps', 'self-hosted', 'hindsight-server']) {
        const { target } = resolveSshTarget(parsedReal, alias, OPTIONS);
        assert.equal(target?.hostName, '203.0.113.10', alias);
        assert.equal(target?.user, 'hui', alias);
        assert.deepEqual(target?.identityFiles, ['C:/Users/hui/.ssh/id_ed25519'], alias);
    }
});
test('IdentityFile 写成 .pub 公钥的 4 个主机必须逐个报错，并指到私钥那一行', () => {
    const { problems } = listSshTargets(parsedReal, OPTIONS);
    const publicKey = problems.filter((problem) => problem.code === 'identity-is-public-key');
    assert.equal(publicKey.length, 4);
    assert.deepEqual(publicKey.map((problem) => problem.line), [21, 45, 51, 57]);
    for (const problem of publicKey) {
        // 文案必须带上「改成什么」，否则用户只知道错了不知道怎么办。
        assert.match(problem.message, /Permission denied/);
        assert.match(problem.message, /去掉 \.pub/);
    }
});
test('反证：把 .pub 那几行改成私钥后，这类问题必须归零（断言不是恒真）', () => {
    const fixed = REAL_CONFIG.replace(/\.pub\b/g, '');
    const { problems } = listSshTargets(parseSshConfig(fixed, 'config'), OPTIONS);
    assert.equal(problems.filter((problem) => problem.code === 'identity-is-public-key').length, 0);
});
test('反斜杠路径必须规范化，不能留下 C:\\Users\\hui/.ssh 这种半截路径', () => {
    const { target } = resolveSshTarget(parsedReal, 'ssy_pc', OPTIONS);
    assert.deepEqual(target?.identityFiles, ['C:/Users/hui/.ssh/id_ed25519']);
    // 公钥那条被拦下后不会混进可用私钥列表（否则连接会拿着公钥去试签名）
    assert.deepEqual(resolveSshTarget(parsedReal, 'ssy_ubuntu_dev_lan', OPTIONS).target?.identityFiles, []);
});
test('端口与用户名按块取值；没有 HostName 时主机名回落到别名本身', () => {
    assert.equal(resolveSshTarget(parsedReal, 'ssy_ubuntu_dev_lan', OPTIONS).target?.port, 2222);
    assert.equal(resolveSshTarget(parsedReal, 'syy', OPTIONS).target?.user, 'dev');
    const inline = parseSshConfig('Host bare\n  Port 2200', 'bare');
    assert.equal(resolveSshTarget(inline, 'bare', OPTIONS).target?.hostName, 'bare');
});
test('本层不解释的键记进 ignoredKeys，而不是当成错误', () => {
    const block = parsedReal.blocks.at(-1);
    assert.deepEqual(block?.ignoredKeys, ['ServerAliveInterval', 'ServerAliveCountMax']);
    assert.equal(parsedReal.problems.length, 0);
});
test('先到先得：Host * 在前给了 User，具体 Host 的 User 顶不掉它', () => {
    const text = ['Host *', '  User root', 'Host box', '  User hui', '  HostName 10.0.0.1'].join('\n');
    const parsed = parseSshConfig(text, 'x');
    assert.equal(resolveSshTarget(parsed, 'box', OPTIONS).target?.user, 'root');
    // 反证：把两个块的顺序换过来，结果必须跟着变——否则说明实现其实没按顺序取
    const reversed = parseSshConfig(['Host box', '  User hui', '  HostName 10.0.0.1', 'Host *', '  User root'].join('\n'), 'x');
    assert.equal(resolveSshTarget(reversed, 'box', OPTIONS).target?.user, 'hui');
});
test('第一个 Host 之前的选项是全局默认，装进隐式块（对所有主机生效）', () => {
    const parsed = parseSshConfig(['Port 2200', 'Host a', '  HostName 1.1.1.1'].join('\n'), 'x');
    assert.equal(parsed.blocks[0]?.implicit, true);
    assert.deepEqual(parsed.blocks[0]?.patterns, ['*']);
    assert.equal(resolveSshTarget(parsed, 'a', OPTIONS).target?.port, 2200);
    // 隐式块不是「目标」，不能出现在面板列表里
    assert.deepEqual(listSshTargets(parsed, OPTIONS).targets.map((target) => target.alias), ['a']);
});
test('IdentityFile 累加，IdentityFile none 清空此前累加的那批', () => {
    const text = ['Host multi', '  IdentityFile ~/.ssh/a', '  IdentityFile ~/.ssh/b'].join('\n');
    assert.deepEqual(resolveSshTarget(parseSshConfig(text, 'x'), 'multi', OPTIONS).target?.identityFiles, [
        'C:/Users/hui/.ssh/a',
        'C:/Users/hui/.ssh/b',
    ]);
    const cleared = ['Host none', '  IdentityFile ~/.ssh/a', '  IdentityFile none', '  IdentityFile ~/.ssh/c'].join('\n');
    assert.deepEqual(resolveSshTarget(parseSshConfig(cleared, 'x'), 'none', OPTIONS).target?.identityFiles, [
        'C:/Users/hui/.ssh/c',
    ]);
});
test('通配模式匹配 * 与 ?，其余字符按字面，且大小写敏感', () => {
    assert.equal(matchHostPattern('*.internal', 'db.internal'), true);
    assert.equal(matchHostPattern('*.internal', 'db.internalx'), false);
    assert.equal(matchHostPattern('web?', 'web1'), true);
    assert.equal(matchHostPattern('web?', 'web12'), false);
    assert.equal(matchHostPattern('Host.p', 'HostXp'), false);
    assert.equal(matchHostPattern('Box', 'box'), false);
    assert.equal(matchHostPattern('Box', 'Box'), true);
});
test('通配规则不是目标：Host * / Host *.internal 不进列表', () => {
    const text = ['Host *', '  User root', 'Host *.internal', '  Port 2222', 'Host real', '  HostName 1.2.3.4'].join('\n');
    assert.deepEqual(listSshTargets(parseSshConfig(text, 'x'), OPTIONS).targets.map((target) => target.alias), ['real']);
});
test('Port 非整数/越界要报错，并且不把烂值猜成端口', () => {
    for (const [port, reason] of [
        ['abc', '非数字'],
        ['0', '下界'],
        ['65536', '上界'],
        ['-1', '负数'],
    ]) {
        const parsed = parseSshConfig(['Host bad', '  Port ' + port].join('\n'), 'x');
        assert.equal(parsed.problems[0]?.code, 'port-invalid', reason);
        assert.match(String(parsed.problems[0]?.message), /1–65535/);
        // 端口没被接受 ⇒ 只能是默认 22，绝不能用坏值
        assert.equal(resolveSshTarget(parsed, 'bad', OPTIONS).target?.port, 22, reason);
    }
});
test('Host 后面没写别名要报错，并且这一块不产生任何目标', () => {
    const parsed = parseSshConfig(['Host', '  HostName 1.1.1.1'].join('\n'), 'x');
    assert.equal(parsed.problems[0]?.code, 'host-without-pattern');
    assert.deepEqual(listSshTargets(parsed, OPTIONS).targets, []);
});
test('键名大小写不敏感（HOST / HostName 等价）', () => {
    const parsed = parseSshConfig(['HOST Mixed', '  hostname 9.9.9.9', '  USER hui'].join('\n'), 'x');
    const { target } = resolveSshTarget(parsed, 'Mixed', OPTIONS);
    assert.equal(target?.hostName, '9.9.9.9');
    assert.equal(target?.user, 'hui');
});
test('行内 # 不是注释：OpenSSH 只认行首 #，所以 # 之后是模式的一部分', () => {
    const parsed = parseSshConfig('Host foo # bar', 'x');
    assert.deepEqual(parsed.blocks[0]?.patterns, ['foo', '#', 'bar']);
    // 但 foo 仍然能被匹配到 —— 与真实 ssh 行为一致
    assert.equal(resolveSshTarget(parsed, 'foo', OPTIONS).target?.alias, 'foo');
});
test('注释行与空行被跳过，注释里的 Host 不产生块', () => {
    const parsed = parseSshConfig(['# Host ghost', '', '   ', 'Host real'].join('\n'), 'x');
    assert.deepEqual(parsed.blocks.map((block) => block.patterns), [['real']]);
});
test('~user 不展开：它不是当前用户的 home，硬展开只会得到不存在的路径', () => {
    const parsed = parseSshConfig(['Host other', '  IdentityFile ~alice/.ssh/id'].join('\n'), 'x');
    const { target, problems } = resolveSshTarget(parsed, 'other', OPTIONS);
    assert.equal(problems[0]?.code, 'tildeg-user-unsupported');
    assert.deepEqual(target?.identityFiles, []);
});
test('expandSshPath 的四个分支：~ / ~/x / Windows 反斜杠 / 绝对路径', () => {
    assert.deepEqual(expandSshPath('~', OPTIONS), { path: HOME });
    assert.deepEqual(expandSshPath('~/.ssh/id', OPTIONS), { path: HOME + '/.ssh/id' });
    assert.deepEqual(expandSshPath('~\\.ssh\\id', OPTIONS), { path: HOME + '/.ssh/id' });
    assert.deepEqual(expandSshPath('  /abs/key  ', OPTIONS), { path: '/abs/key' });
    assert.deepEqual(expandSshPath('   ', OPTIONS), { problem: 'empty' });
});
test('ProxyJump 解析成跳板链；none 表示没有跳板', () => {
    const text = ['Host behind', '  ProxyJump hui@jump1:2222,jump2'].join('\n');
    const { target } = resolveSshTarget(parseSshConfig(text, 'x'), 'behind', OPTIONS);
    assert.deepEqual(target?.proxyJump, [
        { host: 'jump1', user: 'hui', port: 2222 },
        { host: 'jump2', user: undefined, port: 22 },
    ]);
    const none = ['Host direct', '  ProxyJump none'].join('\n');
    assert.deepEqual(resolveSshTarget(parseSshConfig(none, 'x'), 'direct', OPTIONS).target?.proxyJump, []);
});
test('Include 必须在原位置展开：include 里的同名 Host 胜过后面的重复定义', () => {
    const files = new Map([
        ['C:/keys/master', ['Include C:/keys/extra', 'Host dup', '  User b'].join('\n')],
        ['C:/keys/extra', ['Host dup', '  User a'].join('\n')],
    ]);
    const collected = [...files.keys()];
    const { parsed, files: read } = readSshConfig({
        file: 'C:/keys/master',
        homeDir: 'C:/keys',
        readFile: (path) => {
            const text = files.get(path);
            if (text === undefined)
                throw new Error('unexpected read ' + path);
            return text;
        },
        exists: (path) => collected.includes(path),
    });
    assert.deepEqual(read, ['C:/keys/master', 'C:/keys/extra']);
    assert.equal(resolveSshTarget(parsed, 'dup', OPTIONS).target?.user, 'a');
    // 反证：把 include 挪到后面，「先到先得」就该反过来——证明上面断言依赖的是顺序而非巧合
    const swapped = parseSshConfig(['Host dup', '  User b', 'Host dup', '  User a'].join('\n'), 'x');
    assert.equal(resolveSshTarget(swapped, 'dup', OPTIONS).target?.user, 'b');
});
test('Include 匹配不到文件要报出来（OpenSSH 会静默当没有，用户会以为生效了）', () => {
    const { problems, parsed } = readSshConfig({
        file: 'C:/keys/master',
        homeDir: 'C:/keys',
        readFile: () => ['Include missing.conf', 'Host real', '  HostName 1.1.1.1'].join('\n'),
        exists: () => false,
    });
    assert.deepEqual(problems.map((problem) => problem.code), ['include-unreadable']);
    // 报错不影响其余解析：真实目标仍然可用
    assert.equal(resolveSshTarget(parsed, 'real', OPTIONS).target?.hostName, '1.1.1.1');
});
test('Include 成环要有上限：读到 maxDepth 就停，不会无限读盘', () => {
    let reads = 0;
    const { problems } = readSshConfig({
        file: 'C:/keys/a',
        homeDir: 'C:/keys',
        maxDepth: 3,
        readFile: (path) => {
            reads += 1;
            return path.endsWith('a') ? 'Include b' : 'Include a';
        },
        exists: () => true,
    });
    assert.equal(problems.filter((problem) => problem.code === 'include-too-deep').length, 1);
    assert.equal(reads, 4, '主文件 + 3 层，不能再多读');
});
test('Include 的通配与相对路径按 ~/.ssh 解析（真实目录）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'remote-cr-ssh-'));
    try {
        mkdirSync(join(dir, '.ssh/conf.d'), { recursive: true });
        writeFileSync(join(dir, '.ssh/conf.d/20-beta.conf'), 'Host beta\n  HostName 2.2.2.2\n');
        writeFileSync(join(dir, '.ssh/conf.d/10-alpha.conf'), 'Host alpha\n  HostName 1.1.1.1\n');
        writeFileSync(join(dir, '.ssh/config'), 'Include conf.d/*.conf\nHost main\n  HostName 3.3.3.3\n');
        const { parsed, problems } = readSshConfig({ file: join(dir, '.ssh/config'), homeDir: dir });
        assert.deepEqual(problems, []);
        // 通配按字典序展开 ⇒ alpha 先于 beta；main 排在 include 之后
        assert.deepEqual(listSshTargets(parsed, { homeDir: dir }).targets.map((target) => target.alias), ['alpha', 'beta', 'main']);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test('未知别名不是坏配置：返回空目标、零问题，交给调用方报「找不到主机」', () => {
    const resolved = resolveSshTarget(parsedReal, 'no-such-host', OPTIONS);
    assert.equal(resolved.target, undefined);
    assert.deepEqual(resolved.problems, []);
});
//# sourceMappingURL=config.test.js.map