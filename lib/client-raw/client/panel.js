"use strict";
/**
 * 瞬移面板的**纯逻辑**（浏览器半）。
 *
 * 面板要做的三件事里有三件都能在 node 里断言：能不能接入、接入要发什么、
 * 取证结果怎么读。把它们抽出来，组件就只剩渲染，和 \`state.ts\` 对向导做的事一样。
 *
 * 一条纪律：**「为什么不能」必须说出来**。灰按钮不写原因，用户只会以为坏了
 * （铁律 4：失败要响）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.planAttach = planAttach;
exports.planSshAttach = planSshAttach;
exports.sshAttachPlan = sshAttachPlan;
exports.basenameOf = basenameOf;
exports.probeReport = probeReport;
exports.probeSummary = probeSummary;
exports.describeTargetInfo = describeTargetInfo;
exports.envPolicyLine = envPolicyLine;
exports.attachPhaseText = attachPhaseText;
exports.linkLine = linkLine;
exports.reconnectPlan = reconnectPlan;
exports.disconnectPlan = disconnectPlan;
exports.formatUpdatedAt = formatUpdatedAt;
const reconnect_ts_1 = require("../shared/reconnect.js");
/**
 * 把一条「添加工作区」的成果翻译成一次远端接入。
 *
 * 为什么不直接在面板里拼：\`localPath\` 必须与 wizard 交给 owner 的**同一个**
 * UNC 路径一致，否则本地会出现两条指向同一目录的工作区记录。这里只做推导，
 * 真正的注册仍由远端 \`workspace/create\` 决定 id。
 */
function planAttach(record, defaults) {
    if (record.source !== 'wsl') {
        return {
            ok: false,
            reason: '这条记录不是 WSL 来源：面板还没有 SSH 别名与锚点目录的来源信息',
        };
    }
    if (record.distro === null || record.distro === '') {
        return { ok: false, reason: '这条记录没有发行版信息，请重新添加一次' };
    }
    if (record.posixPath === null || !record.posixPath.startsWith('/')) {
        return { ok: false, reason: '这条记录没有远端 POSIX 路径，请重新添加一次' };
    }
    if (defaults.remoteRoot === '' || !defaults.remoteRoot.startsWith('/')) {
        return {
            ok: false,
            reason: '宿主没有配置远端 dsh 检出根（DSH_TELEPORT_REMOTE_ROOT），无法启动远端 dsh',
        };
    }
    return {
        ok: true,
        input: {
            target: { backend: 'wsl', distro: record.distro, port: defaults.port, remoteRoot: defaults.remoteRoot },
            remotePath: record.posixPath,
            localPath: record.localPath,
            title: basenameOf(record.posixPath),
        },
    };
}
/**
 * SSH 目标的接入计划。
 *
 * 与 `planAttach` 的区别是**没有本地路径**：WSL 的 `localPath` 能从发行版名推出 UNC，
 * SSH 推不出来（远端 `/home/x` 在本地没有任何约定俗成的落点），所以 `localPath` 留空，
 * 由宿主半的锚点落实器建目录并回填。面板这里**不猜**——猜出来的路径会让宿主把工作区
 * 建在一个不存在的地方，之后所有读写都落在错的位置还不报错。
 */
function planSshAttach(draft, defaults) {
    const alias = draft.alias.trim();
    if (alias === '')
        return { ok: false, reason: '还没有可用的 SSH 主机：先在 ~/.ssh/config 里写一个 Host 块' };
    const remotePath = draft.remotePath.trim();
    if (!remotePath.startsWith('/')) {
        return { ok: false, reason: '远端路径必须是以 / 开头的绝对路径（例如 /home/hui/workspace）' };
    }
    if (defaults.remoteRoot === '' || !defaults.remoteRoot.startsWith('/')) {
        return {
            ok: false,
            reason: '宿主没有配置远端 dsh 检出根（DSH_TELEPORT_REMOTE_ROOT），无法启动远端 dsh',
        };
    }
    return {
        ok: true,
        input: {
            target: { backend: 'ssh', alias, port: defaults.port, remoteRoot: defaults.remoteRoot },
            remotePath,
            title: basenameOf(remotePath),
        },
    };
}
/**
 * SSH 接入按钮的可点性。
 *
 * 单独一个函数而不是就用 `planSshAttach` 的 ok：后者在用户**还没输入路径**时
 * 就已经返回 false 了，但那不是「坏了」，是「还没填」。两者文案必须不同，
 * 否则用户一打开面板就看到一条红字。
 */
function sshAttachPlan(hosts, draft, defaults) {
    if (hosts.length === 0)
        return { ok: false, reason: '~/.ssh/config 里没有可用的主机（写一个 Host 块后刷新）' };
    if (draft.alias.trim() === '')
        return { ok: false, reason: '还没有选择 SSH 主机' };
    if (draft.remotePath.trim() === '')
        return { ok: false, reason: '还没有填写远端路径' };
    const plan = planSshAttach(draft, defaults);
    return plan.ok ? { ok: true } : { ok: false, reason: plan.reason };
}
/** 远端路径的最后一段，用作工作区标题；根路径退化成整串。 */
function basenameOf(posixPath) {
    const trimmed = posixPath.endsWith('/') && posixPath.length > 1 ? posixPath.slice(0, -1) : posixPath;
    const at = trimmed.lastIndexOf('/');
    return at < 0 ? trimmed : trimmed.slice(at + 1) || trimmed;
}
/**
 * 取证结论的**可复制报告**。
 *
 * 与 \`shared/flow.ts#flowReport\` 同构：先结论、再证据、最后原始输出。
 * 用户贴给别人的应该是一段能自证的东西，而不是「失败了」三个字。
 */
function probeReport(outcome) {
    const lines = [
        'session: ' + outcome.sessionId,
        'terminal: ' + outcome.terminalId,
        'verdict: ' + (outcome.executedRemotely ? '远端执行已确认' : '未确认远端执行'),
        'cwd: ' + outcome.cwd,
        'uname: ' + outcome.uname,
    ];
    if (outcome.remoteVerdict !== null)
        lines.push('reason: ' + outcome.remoteVerdict);
    lines.push('--- transcript ---', outcome.transcript);
    return lines.join('\n');
}
/** 一句话结论（面板行内显示，不用展开报告就能看懂）。 */
function probeSummary(outcome) {
    return outcome.executedRemotely
        ? '远端执行已确认 · ' + outcome.cwd
        : '未确认远端执行 · ' + (outcome.remoteVerdict ?? '原因未知');
}
/**
 * 连接状态行的一句话。
 *
 * 只读 `link` 而不看 `connected`：后者只说「现在能不能发 RPC」，说不了
 * 「是没连过，还是掉线正在重试」——而这恰恰是用户按下按钮前最想知道的。
 * 文案直接用共享层的 `describeLink`，宿主半的日志与面板措辞才不会各说一套。
 */
/**
 * 连接目标的短标识：WSL 显示发行版名，SSH 显示 config 别名。
 *
 * 单独一个函数而不是就地三元：面板与日志都要这句摘要，两处各写一遍迟早只改一处。
 */
function describeTargetInfo(target) {
    return target.backend === 'wsl' ? target.distro : target.alias;
}
/**
 * 环境档位的一句话。
 *
 * 必须显示而不是只存着：用户选了隔离档却静默按复用档跑，是这一档最糟的失败形态——
 * 它不报错，只是环境悄悄不是你以为的那个。反过来，配置写错时这里会显示「未知」。
 */
function envPolicyLine(snapshot) {
    const policy = snapshot?.envPolicy ?? null;
    if (policy === null)
        return '环境：未选定（尚未连接）';
    if (policy === 'reuse')
        return '环境：复用远端已有 ~/.dsh';
    if (policy === 'isolated')
        return '环境：隔离（不碰远端已有 ~/.dsh）';
    return '环境：sync（M3 才落地）';
}
/**
 * 接入阶段的人话。A5 要求「分阶段进度」对用户可见——只显示「接入中…」等于没给进度。
 * 阶段词的真相源是 `src/shared/phases.ts`，这里只负责翻译，不新增阶段。
 */
function attachPhaseText(phase) {
    if (phase === 'probe')
        return '探测远端（ssh 通道 / node / 插件检出）';
    if (phase === 'bootstrap')
        return '引导远端（装 dsh）';
    if (phase === 'verify')
        return '校验远端产物';
    if (phase === 'launch')
        return '启动远端 dsh';
    if (phase === 'tunnel')
        return '建隧道 / 抓凭据端口';
    if (phase === 'barrier')
        return '同步屏障';
    return '接入工作区';
}
function linkLine(snapshot) {
    if (snapshot === null)
        return '尚未读取投影';
    const base = (0, reconnect_ts_1.describeLink)(snapshot.link);
    if (snapshot.link !== 'connected' || snapshot.target === null)
        return base;
    return base + ' · ' + describeTargetInfo(snapshot.target);
}
/**
 * 「重连」按钮的可点性。
 *
 * 三种不点的情况各有各的原因，含糊成一句「不可用」等于让用户猜：
 * 还没读到投影、压根没连过（没有目标可连回）、以及本来就连着（点了没意义）。
 */
function reconnectPlan(snapshot) {
    if (snapshot === null)
        return { ok: false, reason: '尚未读取投影，稍候再试' };
    if (snapshot.link === 'connected')
        return { ok: false, reason: '远端已连接，无需重连' };
    if (snapshot.target === null) {
        return { ok: false, reason: '还没有接入过远端：先在上面的列表里点「接入远端」' };
    }
    return { ok: true };
}
/** 「断开」按钮的可点性：没连过就没什么可断开的。 */
function disconnectPlan(snapshot) {
    if (snapshot === null)
        return { ok: false, reason: '尚未读取投影，稍候再试' };
    if (snapshot.link === 'idle')
        return { ok: false, reason: '当前没有远端连接' };
    return { ok: true };
}
/**
 * 时间显示。
 *
 * 远端给的是 ISO-8601；解析不了就原样返回，**不拿本地时钟编一个**——
 * 编出来的时间会让「这条会话是旧的」这种判断变成假的。
 */
function formatUpdatedAt(iso, now = Date.now()) {
    if (iso === undefined)
        return '时间未知';
    const at = Date.parse(iso);
    if (Number.isNaN(at))
        return iso;
    // 相对时间只覆盖「一小时内」：再久远的写「37 小时前」反而要用户心算。
    const delta = now - at;
    if (delta >= 0 && delta < 60_000)
        return '刚刚';
    if (delta >= 60_000 && delta < 3_600_000)
        return String(Math.floor(delta / 60_000)) + ' 分钟前';
    if (delta >= 3_600_000 && delta < 86_400_000)
        return String(Math.floor(delta / 3_600_000)) + ' 小时前';
    // 本地时区、精确到分钟：UTC 的 `Z` 后缀在面板上纯属噪音（读者按本地时间理解一切）。
    const local = new Date(at);
    const pad = (value) => String(value).padStart(2, '0');
    return (String(local.getFullYear()) + '-' + pad(local.getMonth() + 1) + '-' + pad(local.getDate()) +
        ' ' + pad(local.getHours()) + ':' + pad(local.getMinutes()));
}
