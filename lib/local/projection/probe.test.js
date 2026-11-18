import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROBE_DONE_PREFIX, PROBE_PWD, PROBE_SHELL_PREFERENCE, PROBE_UNAME, TERMINAL_WARMUP_MS, assertRemoteExecution, buildProbeCommand, newDoneToken, parseProbeTranscript, runSessionProbe, } from "./probe.js";
const NEG = process.env.NEGATIVE_CONTROL === '1';
/**
 * 单测一律跳过预热等待。
 *
 * `TERMINAL_WARMUP_MS` 是**真机事实**（create 后等 1500ms 才发命令，见 probe.ts
 * 里的对照表），不是这里要验证的行为；等它只会让测试白慢 1.5s。
 * 它自己的约束由下面那条「必须为正」的断言守住。
 */
const NO_WARMUP = { warmupMs: 0 };
/** 一轮固定的完成标记：解析器的单测要能自己指定 token。 */
const TOKEN = PROBE_DONE_PREFIX + 'abc123abc123';
/** 造一段终端文本：先是 shell 回显（含字面量），再是真实输出。 */
function transcriptOf(cwd, uname, options = {}) {
    const token = options.token ?? TOKEN;
    const echo = options.echo ?? true;
    const lines = [];
    if (echo)
        lines.push('hui@CodingRookie:~$ ' + buildProbeCommand(token).replace('\r', ''));
    lines.push(PROBE_PWD + cwd);
    lines.push(PROBE_UNAME + uname);
    if (options.done ?? true)
        lines.push(token);
    return lines.join('\r\n') + '\r\n';
}
const LINUX_UNAME = 'Linux CodingRookie 6.18.54.1-microsoft-standard-WSL2 x86_64 GNU/Linux';
test('解析取完成标记之前的最后一次出现：回显行里的字面量不会被当成结果', () => {
    const text = transcriptOf('/home/hui/workspace', LINUX_UNAME);
    // NEGATIVE_CONTROL: 变异成「从头往后取第一次出现」，就会抓到回显里的格式串。
    const parsed = NEG ? firstMatch(text) : parseProbeTranscript(text, TOKEN);
    assert.notEqual(parsed, undefined);
    assert.equal(parsed?.cwd, '/home/hui/workspace');
    assert.equal(parsed?.uname, LINUX_UNAME);
});
/** 负控用的错误解析：正序取第一次出现（会命中回显）。 */
function firstMatch(text) {
    let cwd;
    let uname;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (cwd === undefined && line.includes(PROBE_PWD))
            cwd = line.slice(line.indexOf(PROBE_PWD) + PROBE_PWD.length);
        else if (uname === undefined && line.includes(PROBE_UNAME))
            uname = line.slice(line.indexOf(PROBE_UNAME) + PROBE_UNAME.length);
    }
    if (cwd === undefined || uname === undefined)
        return undefined;
    return { cwd, uname };
}
test('没有完成标记就不给结论：宁可报错也不交半截证据', () => {
    assert.equal(parseProbeTranscript(transcriptOf('/home/hui', LINUX_UNAME, { done: false }), TOKEN), undefined);
    assert.equal(parseProbeTranscript('', TOKEN), undefined);
});
test('只有回显、没有真实输出时解析失败（回显里是字面量，不是值）', () => {
    // 回显行会原样打出命令行，其中 `$PWD` 没有被展开；把它当成结果就是假证据。
    const echoOnly = 'hui@CodingRookie:~$ ' + buildProbeCommand(TOKEN).replace('\r', '') + '\r\n' + TOKEN + '\r\n';
    assert.equal(parseProbeTranscript(echoOnly, TOKEN), undefined);
    // 就算回显被折行、前缀单独落在某一行，也不能认。
    assert.equal(parseProbeTranscript(PROBE_PWD + '$PWD\r\n' + PROBE_UNAME + '$(uname -a)\r\n' + TOKEN, TOKEN), undefined);
});
test('别的轮次的完成标记不算数：终端复用带回来的历史证据必须被无视', () => {
    // 上一轮的文本（含上一轮自己的标记）原样出现，但本轮 token 从未出现 ⇒ 不给结论。
    const stale = transcriptOf('/home/hui/old-cwd', 'Linux STALE 1.0 x86_64', { token: PROBE_DONE_PREFIX + 'deadbeefdeadbeef' });
    assert.equal(parseProbeTranscript(stale, TOKEN), undefined);
});
test('每轮生成的完成标记都不同，且只含 shell 安全字符', () => {
    const a = newDoneToken();
    const b = newDoneToken();
    assert.notEqual(a, b);
    assert.match(a, /^TPDONE-[0-9a-f]{16}$/);
    // 标记要原样进命令行，不能带任何需要转义或会被 shell 解释的字符。
    assert.equal(a, a.replace(/[^A-Za-z0-9-]/g, ''));
});
test('断言：POSIX 绝对路径 + Linux 内核才算跑在远端', () => {
    const ok = { sessionId: 's1', terminalId: 't', cwd: '/home/hui/workspace', uname: LINUX_UNAME, transcript: '' };
    assert.deepEqual(assertRemoteExecution(ok), { cwd: '/home/hui/workspace', uname: LINUX_UNAME });
    assert.throws(() => assertRemoteExecution({ ...ok, cwd: 'D:\\workspace' }), /没有跑在远端/);
    assert.throws(() => assertRemoteExecution({ ...ok, cwd: 'C:/workspace' }), /没有跑在远端/);
    assert.throws(() => assertRemoteExecution({ ...ok, uname: 'MINGW64_NT-10.0-22631' }), /没有跑在远端/);
});
/**
 * 假 RPC：把「远端回了什么」变成测试入参，而不是去连真远端。
 *
 * `frames` 可以是固定数组，也可以是 `(command) => frames`：后者会先**真的从 uplink
 * 读出本轮命令**，再据此造帧 —— 于是「远端回显的标记是不是本轮标记」这件事在单测里
 * 也是真的在联动，而不是两边各写一份字面量。
 */
function fakeRpc(frames, options = {}) {
    const seen = { calls: [], streams: [], sent: [] };
    const rpc = {
        async call(endpoint, payload) {
            seen.calls.push({ endpoint, payload });
            if (endpoint === 'terminal/shells') {
                if (options.shells instanceof Error)
                    throw options.shells;
                return (options.shells ?? []);
            }
            return { id: 'remote-cr-probe', title: 'probe', shell: 'bash', cwd: '/home/hui', cols: 200, rows: 50, state: 'running', exitCode: null };
        },
        openStream(endpoint, payload, uplink) {
            seen.streams.push({ endpoint, payload, uplink: uplink !== undefined });
            let cancelled = false;
            let unhold;
            return {
                cancel() {
                    cancelled = true;
                    unhold?.();
                },
                async *[Symbol.asyncIterator]() {
                    let resolved = [];
                    if (typeof frames === 'function') {
                        const iterator = uplink?.[Symbol.asyncIterator]();
                        const first = await iterator?.next();
                        const command = typeof first?.value === 'object' && first.value !== null
                            ? String(first.value.data ?? '')
                            : '';
                        if (command !== '')
                            seen.sent.push(command);
                        resolved = frames(command);
                    }
                    else {
                        resolved = frames;
                    }
                    for (const frame of resolved) {
                        if (cancelled)
                            return;
                        yield { type: 'item', value: frame };
                    }
                    if (options.endless === true) {
                        await new Promise((resolve) => {
                            unhold = resolve;
                        });
                        return;
                    }
                    if (options.failWith !== undefined)
                        yield { type: 'error', ...options.failWith };
                    else
                        yield { type: 'end' };
                },
            };
        },
    };
    return { rpc, seen };
}
/** 从一条已经发出去的命令里取出本轮完成标记。 */
function tokenOf(command) {
    const found = /TPDONE-[0-9a-f]+/.exec(command);
    assert.notEqual(found, null, '命令里必须带本轮完成标记：' + command);
    return found === null ? '' : found[0];
}
test('runSessionProbe 走 terminal/create + terminal/attach，agentId 用 sessionId 且带 request', async () => {
    const { rpc, seen } = fakeRpc((command) => {
        const token = tokenOf(command);
        return [
            { type: 'snapshot', sequence: 1, screen: '', info: { id: 'remote-cr-probe' }, writable: true },
            { type: 'output', sequence: 2, data: transcriptOf('/home/hui/workspace', LINUX_UNAME, { token }) },
        ];
    });
    const result = await runSessionProbe({ rpc }, 'sess-1', NO_WARMUP);
    assert.equal(result.cwd, '/home/hui/workspace');
    assert.equal(result.uname, LINUX_UNAME);
    assert.deepEqual(seen.calls.map((entry) => entry.endpoint), ['terminal/shells', 'terminal/create']);
    const create = seen.calls[1]?.payload;
    assert.equal(create.args.agentId, 'sess-1', 'agent 的线上身份就是 sessionId');
    assert.equal(create.args.request.id, 'remote-cr-probe');
    assert.deepEqual(seen.streams.map((entry) => entry.endpoint), ['terminal/attach']);
    assert.equal(seen.streams[0]?.uplink, true, '不带上行就发不出命令');
    assert.equal(seen.sent.length, 1, '本轮命令必须真的发出去一次');
});
test('终端复用时的历史 scrollback 不能冒充本轮证据（回归：曾经 2ms 返回上一轮结果）', async () => {
    // 首帧 snapshot 带着上一轮的整屏文本（旧 cwd / 旧 uname / **旧标记**），此后远端再不吭声。
    // 修好之前：解析器命中旧标记，2ms 就"成功"返回 /home/hui/old-cwd，命令一条都没发。
    // 修好之后：旧标记 ≠ 本轮标记 ⇒ 一路等到超时才认输，且命令确实发出去了。
    const stale = transcriptOf('/home/hui/old-cwd', 'Linux STALE 1.0 x86_64', { token: PROBE_DONE_PREFIX + 'deadbeefdeadbeef' });
    const { rpc, seen } = fakeRpc(() => [{ type: 'snapshot', sequence: 1, screen: stale, writable: true }], { endless: true });
    const startedAt = Date.now();
    await assert.rejects(runSessionProbe({ rpc }, 'sess-reuse', { warmupMs: 0, timeoutMs: 250 }), /没有在超时前给出本轮取证结果/);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 200, '必须真的等到超时，实际只用了 ' + String(elapsed) + 'ms');
    assert.equal(seen.sent.length, 1, '本轮命令仍然要发出去，只是没等到本轮输出');
});
test('流提前关掉要报「流结束了」，不能一律说成超时', async () => {
    // 同样是「没拿到本轮证据」，但流是被远端关掉的：用户该去查隧道，不是继续傻等。
    const stale = transcriptOf('/home/hui/old-cwd', 'Linux STALE 1.0 x86_64', { token: PROBE_DONE_PREFIX + 'deadbeefdeadbeef' });
    const { rpc } = fakeRpc(() => [{ type: 'snapshot', sequence: 1, screen: stale, writable: true }]);
    const startedAt = Date.now();
    await assert.rejects(runSessionProbe({ rpc }, 'sess-reuse', { warmupMs: 0, timeoutMs: 30_000 }), /输出流在本轮完成标记出现前就结束了/);
    assert.ok(Date.now() - startedAt < 2000, '流已经结束就该立刻报错，不该拖到超时');
});
test('snapshot 历史 + 本轮真实输出同时存在时，只认本轮那一份', async () => {
    const stale = transcriptOf('/home/hui/old-cwd', 'Linux STALE 1.0 x86_64', { token: PROBE_DONE_PREFIX + 'deadbeefdeadbeef' });
    const { rpc } = fakeRpc((command) => {
        const token = tokenOf(command);
        return [
            { type: 'snapshot', sequence: 1, screen: stale, writable: true },
            { type: 'output', sequence: 2, data: transcriptOf('/home/hui/workspace', LINUX_UNAME, { token }) },
        ];
    });
    const result = await runSessionProbe({ rpc }, 'sess-reuse-2', NO_WARMUP);
    assert.equal(result.cwd, '/home/hui/workspace', '必须取本轮结果，不是 snapshot 里的旧结果');
    assert.equal(result.uname, LINUX_UNAME);
});
test('预热必须真的等：warmupMs 到点之前不发命令，到点之后才发', async () => {
    const { rpc, seen } = fakeRpc((command) => {
        const token = tokenOf(command);
        return [
            { type: 'snapshot', sequence: 1, screen: '' },
            { type: 'output', sequence: 2, data: transcriptOf('/home/hui/workspace', LINUX_UNAME, { token }) },
        ];
    });
    const startedAt = Date.now();
    await runSessionProbe({ rpc }, 'sess-1', { warmupMs: 120 });
    const waited = Date.now() - startedAt;
    // 留 40ms 余量：定时器可能提前一点点唤醒，但不该差出一个数量级。
    assert.ok(waited >= 80, '预热 120ms 却只等了 ' + String(waited) + 'ms，说明等待被跳过了');
    assert.equal(seen.streams.length, 1, '等待期间不该已经开出 attach 流');
});
test('预热被取消时立刻收手，不把整条取证拖到超时', async () => {
    const { rpc } = fakeRpc([]);
    const controller = new AbortController();
    controller.abort(new Error('用户取消'));
    const startedAt = Date.now();
    await assert.rejects(runSessionProbe({ rpc }, 'sess-1', { warmupMs: 5000, signal: controller.signal }));
    assert.ok(Date.now() - startedAt < 2000, '已取消的 signal 不该再等满预热');
});
test('预热常量必须是正数：它承载的是「远端 shell 初始化没结束就别发命令」这条事实', () => {
    assert.ok(TERMINAL_WARMUP_MS > 0);
    assert.ok(TERMINAL_WARMUP_MS >= 1000, '实测 1500ms 才稳定，写小了首命令会退回 2.7s');
});
test('远端装了 fish 就用 fish 建取证终端：快 shell 比等 1500ms 更省', async () => {
    const { rpc, seen } = fakeRpc((command) => {
        const token = tokenOf(command);
        return [
            { type: 'snapshot', sequence: 1, screen: '' },
            { type: 'output', sequence: 2, data: transcriptOf('/home/hui/workspace', LINUX_UNAME, { token }) },
        ];
    }, { shells: [{ path: '/bin/bash', name: 'bash', args: ['-i'] }, { path: '/usr/bin/fish', name: 'fish', args: ['-i'] }] });
    await runSessionProbe({ rpc }, 'sess-fish', NO_WARMUP);
    const create = seen.calls[1]?.payload;
    assert.equal(create.args.request.shellPath, '/usr/bin/fish', '偏好列表里第一个装了的就要用它');
});
test('远端没装偏好 shell 就不指定 shellPath，交给远端默认', async () => {
    const { rpc, seen } = fakeRpc((command) => {
        const token = tokenOf(command);
        return [
            { type: 'snapshot', sequence: 1, screen: '' },
            { type: 'output', sequence: 2, data: transcriptOf('/home/hui/workspace', LINUX_UNAME, { token }) },
        ];
    }, { shells: [{ path: '/bin/bash', name: 'bash', args: ['-i'] }] });
    await runSessionProbe({ rpc }, 'sess-bashonly', NO_WARMUP);
    const create = seen.calls[1]?.payload;
    assert.equal(create.args.request.shellPath, undefined, '不装就别瞎指定，否则远端会拒');
});
test('查 shell 列表失败要回落默认 shell，不能让取证跟着挂', async () => {
    const { rpc, seen } = fakeRpc((command) => {
        const token = tokenOf(command);
        return [
            { type: 'snapshot', sequence: 1, screen: '' },
            { type: 'output', sequence: 2, data: transcriptOf('/home/hui/workspace', LINUX_UNAME, { token }) },
        ];
    }, { shells: new Error('老版本远端没有 terminal/shells') });
    const result = await runSessionProbe({ rpc }, 'sess-old', NO_WARMUP);
    assert.equal(result.cwd, '/home/hui/workspace');
    const create = seen.calls[1]?.payload;
    assert.equal(create.args.request.shellPath, undefined);
});
test('回落到默认 shell 时才等预热；用快 shell 不等', async () => {
    const frames = (command) => {
        const token = tokenOf(command);
        return [
            { type: 'snapshot', sequence: 1, screen: '' },
            { type: 'output', sequence: 2, data: transcriptOf('/home/hui/workspace', LINUX_UNAME, { token }) },
        ];
    };
    const slow = fakeRpc(frames, { shells: [] });
    const slowStart = Date.now();
    await runSessionProbe({ rpc: slow.rpc }, 'sess-slow');
    const slowWaited = Date.now() - slowStart;
    assert.ok(slowWaited >= TERMINAL_WARMUP_MS - 200, '默认 shell 必须等满预热，实测只等了 ' + String(slowWaited) + 'ms');
    const fast = fakeRpc(frames, { shells: [{ path: '/usr/bin/fish', name: 'fish', args: ['-i'] }] });
    const fastStart = Date.now();
    await runSessionProbe({ rpc: fast.rpc }, 'sess-fast');
    const fastWaited = Date.now() - fastStart;
    assert.ok(fastWaited < 500, '快 shell 不该再等预热，实测等了 ' + String(fastWaited) + 'ms');
});
test('偏好列表非空：空列表等于「永远走慢路径」，是配置错误', () => {
    assert.ok(PROBE_SHELL_PREFERENCE.length > 0);
});
test('远端报错且没给结果时，错误里带得上远端 code（不吞成「超时」）', async () => {
    const { rpc } = fakeRpc([{ type: 'snapshot', sequence: 1, screen: '' }], {
        failWith: { code: 'terminal/not-found', message: '没有这个终端' },
    });
    await assert.rejects(runSessionProbe({ rpc }, 'sess-1', NO_WARMUP), (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /terminal\/not-found/);
        return true;
    });
});
//# sourceMappingURL=probe.test.js.map