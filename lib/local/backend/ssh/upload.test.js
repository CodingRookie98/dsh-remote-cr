import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { TeleportError } from "../errors.js";
import { buildSftpInvocation } from "./transport.js";
import { buildPipeCommand, buildSftpBatch, sftpQuotePath, uploadFile } from "./upload.js";
const TARGET = {
    alias: 'syy',
    hostName: '198.51.100.8',
    user: 'hui',
    port: 2222,
    identityFiles: ['C:/Users/hui/.ssh/id_ed25519'],
    proxyJump: [],
    source: { file: 'C:/Users/hui/.ssh/config', line: 20 },
};
const KEY = { kind: 'key' };
const NL = String.fromCharCode(10);
class FakeUploadChild {
    writes = [];
    events = new EventEmitter();
    stdinEvents = new EventEmitter();
    stderr = new EventEmitter();
    stdout = new EventEmitter();
    ended = false;
    stdinDestroyed = false;
    killed = false;
    /** 第几次写入时抛错（1 起算）；undefined 表示从不抛。 */
    throwOnWrite = undefined;
    /** 每次写入后要发的事件序列：'stdin-error' 让 stdin 报错，'exit:<code>' 让子进程退出。 */
    scripted = [];
    exitCode = 0;
    stderrText = '';
    /** end() 之后是否自动退出。 */
    exitOnEnd = true;
    stdin = {
        write: (chunk) => {
            this.writes.push(chunk);
            if (this.throwOnWrite !== undefined && this.writes.length === this.throwOnWrite) {
                throw new Error('EPIPE: 管道已关闭');
            }
            const step = this.scripted.shift();
            if (step === 'stdin-error') {
                // 同步发：真 stream 在 EPIPE 时也是当场报错，异步发会让「检测到坏了」迟到一轮。
                // 真 ssh 在管道断掉后自己就退出了，所以这里也补一个 exit(null)。
                this.stdinEvents.emit('error', new Error('EPIPE'));
                setImmediate(() => this.events.emit('exit', null, null));
            }
            else if (step !== undefined && step.startsWith('exit:')) {
                const raw = step.slice(5);
                const code = raw === 'null' ? null : Number(raw);
                setImmediate(() => this.events.emit('exit', code, null));
            }
            return true;
        },
        end: () => {
            this.ended = true;
            if (this.exitOnEnd) {
                setImmediate(() => {
                    if (this.stderrText !== '')
                        this.stderr.emit('data', { toString: () => this.stderrText });
                    this.events.emit('exit', this.exitCode, null);
                });
            }
        },
        destroy: () => {
            this.stdinDestroyed = true;
        },
        on: (event, listener) => this.stdinEvents.on(event, listener),
    };
    on(event, listener) {
        this.events.on(event, listener);
        return this;
    }
    kill() {
        this.killed = true;
        setImmediate(() => this.events.emit('exit', null, 'SIGTERM'));
        return true;
    }
}
function fakeSpawn(behaviour = () => { }) {
    const calls = [];
    const spawn = (executable, args, env) => {
        const child = new FakeUploadChild();
        const record = { executable, args, env, child };
        calls.push(record);
        behaviour(calls.length - 1, record);
        return child;
    };
    return { spawn, calls };
}
function sourceOf(chunks) {
    const state = {
        destroyed: false,
        destroy() {
            state.destroyed = true;
        },
        async *[Symbol.asyncIterator]() {
            for (const chunk of chunks)
                yield chunk;
        },
    };
    return state;
}
const BASE = {
    homeDir: 'C:/Users/hui',
    target: TARGET,
    auth: KEY,
    localPath: 'C:/Temp/dsh-teleport.tar.gz',
    remotePath: '/home/hui/.dsh-teleport/staging/dsh-teleport.tar.gz',
    timeoutMs: 2_000,
};
test('SFTP 批处理：put 在前，给了权限就追加 chmod，并以换行收尾', () => {
    assert.equal(buildSftpBatch('/tmp/a.tar', '/home/hui/a.tar'), 'put "/tmp/a.tar" "/home/hui/a.tar"' + NL);
    assert.equal(buildSftpBatch('/tmp/a.tar', '/home/hui/a.tar', '0755'), 'put "/tmp/a.tar" "/home/hui/a.tar"' + NL + 'chmod 0755 "/home/hui/a.tar"' + NL);
});
test('SFTP 路径转义：反斜杠与双引号转义，控制字符直接扔掉', () => {
    assert.equal(sftpQuotePath('C:\\Temp\\a.tar'), '"C:\\\\Temp\\\\a.tar"');
    assert.equal(sftpQuotePath('/tmp/say "hi".tar'), '"/tmp/say \\"hi\\".tar"');
    assert.equal(sftpQuotePath('/tmp/a' + NL + 'b.tar'), '"/tmp/ab.tar"');
});
test('管道命令把远端路径单引号包裹，权限串进同一行而不是另起一条命令', () => {
    const plain = buildPipeCommand('/home/hui/a.tar');
    assert.deepEqual(plain, ['sh', '-c', "'cat > '\\''/home/hui/a.tar'\\'''"]);
    const withMode = buildPipeCommand('/home/hui/a.tar', '0755');
    assert.equal(withMode[0], 'sh');
    assert.equal(withMode[1], '-c');
    assert.match(withMode[2] ?? '', /chmod 0755/);
});
test('sftp argv：走 -b -、没有 -T 也没有 --，连接选项与 ssh 一致，机密不进 argv', () => {
    const built = buildSftpInvocation({
        target: TARGET,
        auth: { kind: 'password', password: 's3cret-pass' },
        knownHostsFile: 'C:/Users/hui/.dsh-teleport/known_hosts',
        askpassPath: 'C:/Users/hui/.dsh-teleport/askpass.cjs',
        sshExecutable: 'C:/Windows/System32/OpenSSH/ssh.exe',
    }, 'put "a" "b"' + NL);
    assert.equal(built.executable, 'C:/Windows/System32/OpenSSH/sftp.exe');
    assert.equal(built.args[0], '-b');
    assert.equal(built.args[1], '-');
    assert.equal(built.args.includes('-T'), false);
    assert.equal(built.args.includes('--'), false);
    assert.equal(built.args.at(-1), TARGET.hostName);
    assert.ok(built.args.includes('UserKnownHostsFile=C:/Users/hui/.dsh-teleport/known_hosts'));
    assert.ok(built.args.includes('PubkeyAuthentication=no'));
    assert.equal(built.args.join(' ').includes('s3cret-pass'), false);
    assert.equal(built.env['TELEPORT_SSH_SECRET'], 's3cret-pass');
    assert.equal(built.needsAskpass, true);
});
test('SFTP 成功就不用碰管道：一个子进程、method=sftp', async () => {
    const { spawn, calls } = fakeSpawn();
    const result = await uploadFile({ ...BASE, spawn, sourceOf: () => sourceOf([]) });
    assert.equal(result.method, 'sftp');
    assert.equal(result.triedSftp, true);
    assert.equal(result.sftpFailure, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.executable, 'sftp.exe');
    assert.equal(calls[0]?.child.ended, true);
});
test('SFTP 失败要回退 cat > 并把 sftp 的失败原因带出来', async () => {
    const source = sourceOf([new TextEncoder().encode('TARBALL')]);
    const { spawn, calls } = fakeSpawn((index, record) => {
        if (index !== 0)
            return;
        record.child.exitCode = 1;
        record.child.stderrText = 'subsystem request failed on channel 0' + NL + 'Could not read from remote repository.';
    });
    const result = await uploadFile({ ...BASE, spawn, sourceOf: () => source });
    assert.equal(result.method, 'pipe');
    assert.equal(result.triedSftp, true);
    assert.equal(calls.length, 2);
    assert.match(result.sftpFailure ?? '', /subsystem request failed/);
    assert.equal(calls[1]?.child.writes.length, 1);
    assert.equal(new TextDecoder().decode(calls[1]?.child.writes[0]), 'TARBALL');
});
test('skipSftp 直接走管道：triedSftp=false，只起一个子进程', async () => {
    const { spawn, calls } = fakeSpawn();
    const result = await uploadFile({ ...BASE, spawn, skipSftp: true, sourceOf: () => sourceOf([new Uint8Array([1, 2, 3])]) });
    assert.equal(result.method, 'pipe');
    assert.equal(result.triedSftp, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.child.ended, true);
});
test('管道退出码非 0 要报错，并把远端 stderr 尾巴带出来', async () => {
    const { spawn } = fakeSpawn((_index, record) => {
        record.child.exitCode = 1;
        record.child.stderrText = 'cat: cannot create: Permission denied';
    });
    await assert.rejects(uploadFile({ ...BASE, spawn, skipSftp: true, sourceOf: () => sourceOf([new Uint8Array([1])]) }), (error) => {
        assert.ok(error instanceof TeleportError);
        assert.equal(error.code, 'remote/upload-failed');
        assert.match(error.detail, /退出码 1/);
        assert.match(error.detail, /Permission denied/);
        return true;
    });
});
test('写入时抛错要立刻销毁数据源与 stdin：不再读盘，也不往死管道里灌', async () => {
    const source = sourceOf([new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])]);
    const { spawn, calls } = fakeSpawn((_index, record) => {
        record.child.throwOnWrite = 2;
    });
    await assert.rejects(uploadFile({ ...BASE, spawn, skipSftp: true, sourceOf: () => source }), (error) => {
        assert.ok(error instanceof TeleportError);
        assert.equal(error.code, 'remote/upload-failed');
        assert.match(error.detail, /上传中断/);
        return true;
    });
    assert.equal(source.destroyed, true);
    assert.equal(calls[0]?.child.stdinDestroyed, true);
    assert.equal(calls[0]?.child.killed, true);
    assert.equal(calls[0]?.child.writes.length, 2);
});
test('远端先关掉 stdin：停止读取并报「管道被远端提前关闭」', async () => {
    const source = sourceOf([new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])]);
    const { spawn } = fakeSpawn((_index, record) => {
        record.child.scripted.push('ok', 'stdin-error');
    });
    await assert.rejects(uploadFile({ ...BASE, spawn, skipSftp: true, sourceOf: () => source }), (error) => {
        assert.ok(error instanceof TeleportError);
        assert.match(error.detail, /管道被远端提前关闭/);
        return true;
    });
    assert.equal(source.destroyed, true);
});
test('超时要 kill 掉子进程并如实说超时', async () => {
    const { spawn, calls } = fakeSpawn((_index, record) => {
        record.child.exitOnEnd = false;
    });
    await assert.rejects(uploadFile({ ...BASE, spawn, skipSftp: true, timeoutMs: 120, sourceOf: () => sourceOf([new Uint8Array([1])]) }), (error) => {
        assert.ok(error instanceof TeleportError);
        assert.match(error.detail, /上传超时/);
        return true;
    });
    assert.equal(calls[0]?.child.killed, true);
});
test('已经取消的上传一个子进程都不许起', async () => {
    const controller = new AbortController();
    controller.abort();
    const { spawn, calls } = fakeSpawn();
    await assert.rejects(uploadFile({ ...BASE, spawn, skipSftp: true, signal: controller.signal, sourceOf: () => sourceOf([new Uint8Array([1])]) }), (error) => {
        assert.ok(error instanceof TeleportError);
        assert.match(error.detail, /取消/);
        return true;
    });
    assert.equal(calls.length, 0);
});
test('本地文件不存在：报读不到上传源，也一个子进程都不起', async () => {
    const { spawn, calls } = fakeSpawn();
    await assert.rejects(uploadFile({ ...BASE, spawn, localPath: 'C:/Temp/does-not-exist-dsh-teleport.tar.gz' }), (error) => {
        assert.ok(error instanceof TeleportError);
        assert.equal(error.code, 'remote/upload-failed');
        assert.match(error.detail, /读不到本地上传源/);
        return true;
    });
    assert.equal(calls.length, 0);
});
test('权限串要同时进 SFTP 批处理与管道命令', async () => {
    const { spawn, calls } = fakeSpawn((index, record) => {
        if (index === 0) {
            record.child.exitCode = 1;
            record.child.stderrText = 'no sftp subsystem';
        }
    });
    await uploadFile({ ...BASE, spawn, mode: '0755', sourceOf: () => sourceOf([new Uint8Array([1])]) });
    const batch = new TextDecoder().decode(calls[0]?.child.writes[0]);
    assert.match(batch, /chmod 0755 "\/home\/hui\/\.dsh-teleport\/staging\/dsh-teleport\.tar\.gz"/);
    const pipeCommand = (calls[1]?.args ?? []).join(' ');
    assert.match(pipeCommand, /chmod 0755/);
});
//# sourceMappingURL=upload.test.js.map