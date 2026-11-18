/**
 * SSH 失败的**归一化**：把 OpenSSH 的 stderr 文案翻成稳定的错误码 + 可操作中文。
 *
 * 为什么必须有这一层（S0-1 的代价侧）：本机 npm registry 不可达，用不了 `ssh2` 库，
 * 只能驱动系统 `ssh.exe`（OpenSSH_for_Windows_9.5p2）。它把一切失败都写成英文句子，
 * 没有结构化事件。这里建**唯一一张表**，让上层只面对四个稳定分类：
 *
 * 1. 认证失败（`remote/auth-failed`）—— 私钥/agent 被拒
 * 2. 握手超时（`remote/auth-timeout`）—— 网络层根本没通
 * 3. 私钥需口令（`remote/key-passphrase`）—— 私钥加密了，我们没拿到口令
 * 4. 口令错误（`remote/password-rejected`）—— 密码认证被拒
 *
 * 里程碑原文要求这四类**各有文案**，所以判定必须用**认证方式**当上下文，不能只看字面：
 * 同样是 `Permission denied`，用私钥时是「这把钥匙不被接受」，用密码时是「密码不对」，
 * 用户要做的动作完全不同。文案表在 `SSH_FAILURE_TABLE`，测试逐条锁住。
 */
import { RemoteCrError } from "../errors.js";
/**
 * 判定顺序 = 数组顺序：**越具体越靠前**。
 *
 * 关键例子：主机密钥变更的完整输出里也含 `Permission denied`，
 * 所以 `host-key-changed` 必须排在 `auth-failed` 前面，否则用户会被误导去换钥匙。
 */
export const SSH_FAILURE_TABLE = [
    {
        code: 'remote/host-key-changed',
        match: /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/,
        detail: (c) => c.target + ' 的主机密钥与首次记录的不一致（可能被中间人，也可能是对端重装了系统）。已拒绝连接，不会把主机密钥视为可信。',
        nextActions: (c) => [
            '核对该主机的指纹（如能从对端控制台确认）',
            '确认无误后用「信任新指纹」动作移除旧条目再连 ' + c.target,
            '直接放弃连接并检查网络路径',
        ],
    },
    {
        code: 'remote/key-passphrase',
        match: /incorrect passphrase supplied to decrypt private key|Enter passphrase for key|Load key .*passphrase/,
        detail: (c) => c.target + ' 的私钥是用口令加密的，但本次没有可用的口令（或口令不对）。',
        nextActions: () => ['输入私钥口令后重试', '改用 ssh-agent 里已解锁的钥匙', '换一把未加密的私钥'],
    },
    {
        code: 'remote/auth-timeout',
        match: /Connection timed out|Operation timed out|Timeout, server .* not responding|connect to host .* timeout/i,
        detail: (c) => '连 ' + c.target + ' 时握手超时：TCP 都没建立起来，还没轮到认证。',
        nextActions: (c) => [
            '确认主机在线且 22 端口可达（在目标网络里试 ssh ' + c.target + '）',
            '检查是否需要经过跳板 / VPN（如公司内网）',
            '确认防火墙或安全组没有挡掉本机出口',
        ],
    },
    {
        code: 'remote/password-rejected',
        match: /Permission denied, please try again|Too many authentication failures|Authentication failed|No more authentication methods/,
        whenAuth: 'password',
        detail: (c) => c.target + ' 拒绝了本次口令登录（用户名或口令不对）。',
        nextActions: () => ['重新输入口令（注意用户名是否正确）', '改用私钥登录', '确认服务端允许密码登录（PasswordAuthentication yes）'],
    },
    {
        code: 'remote/password-unavailable',
        // 走到这里说明本条 stderr 里**没有**「please try again」（那是口令错），
        // 只剩一行 `Permission denied (publickey).` —— 服务端压根没提供密码方式。
        match: /Permission denied \(/,
        whenAuth: 'password',
        detail: (c) => c.target + ' 不接受密码登录：服务端的可用认证方式里没有 password/keyboard-interactive。',
        nextActions: () => [
            '改用私钥登录（推荐）',
            '请对端管理员确认 sshd_config 里 PasswordAuthentication 与 KbdInteractiveAuthentication 已开启',
            '确认用户名是否正确（有些系统对未知用户直接不给认证方式）',
        ],
    },
    {
        code: 'remote/auth-failed',
        // 不能匹配裸 `publickey`：ssh -v 的成功行是 `Authenticated to … using "publickey"`，
        // 那会把「认证成功但随后启动失败」误判成 auth-failed（真机回归打出来的）。
        match: /Permission denied \(|Permission denied\.|Authentication failed|No more authentication methods|Too many authentication failures/,
        whenAuth: ['key', 'agent'],
        detail: (c) => c.target + ' 拒绝了这把私钥/agent 的认证：服务端 `authorized_keys` 里没有对应的公钥，或该钥匙被禁用。',
        nextActions: () => [
            '把对应公钥追加到对端 ~/.ssh/authorized_keys（并确认权限 600/700）',
            '确认 ssh-agent 里有这把钥匙（agent 方式）',
            '换一把已被对端接受的私钥，或核对登录用户名',
        ],
    },
    {
        code: 'remote/host-unreachable',
        match: /Connection refused|Could not resolve hostname|Network is unreachable|No route to host|Name or service not known|Connection closed by|kex_exchange_identification/,
        detail: (c) => '连不上 ' + c.target + '：端口拒绝、域名解析失败或路由不可达。',
        nextActions: () => [
            '确认 sshd 在运行且端口正确（默认 22，非标准端口要写 Port）',
            '确认主机名/IP 写对（可先 ping 或 telnet 端口）',
            '确认本机网络与 VPN 状态',
        ],
    },
];
/**
 * 判定一条 stderr，返回结构化错误。**永远返回错误**——没有「未知就放过」的分支，
 * 因为铁律 4 要求失败要响；认不出来时给 `remote/unknown` 并保留原文日志尾。
 */
export function classifySshFailure(stderr, context) {
    const logTail = context.logTail ?? stderr.trim().split(/\r?\n/).slice(-40).join('\n');
    for (const rule of SSH_FAILURE_TABLE) {
        if (rule.whenAuth !== undefined) {
            const allowed = Array.isArray(rule.whenAuth) ? rule.whenAuth : [rule.whenAuth];
            if (!allowed.includes(context.auth))
                continue;
        }
        if (!rule.match.test(stderr))
            continue;
        return new RemoteCrError({
            code: rule.code,
            detail: rule.detail(context),
            nextActions: rule.nextActions(context),
            logTail,
        });
    }
    return new RemoteCrError({
        code: 'remote/unknown',
        detail: '连接 ' + context.target + ' 失败，但错误信息不在已知分类里；请按日志尾判断。',
        nextActions: ['复制日志后重试', '在终端里手动执行同一台 ssh 目标复现', '检查 ssh 客户端版本（本机为 OpenSSH 9.5p2）'],
        logTail,
    });
}
//# sourceMappingURL=errors.js.map