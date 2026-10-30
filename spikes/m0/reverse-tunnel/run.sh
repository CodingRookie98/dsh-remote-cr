#!/usr/bin/env bash
# R1-1 反向通路可复跑验证（Windows + Git Bash / MSYS）
#
# 验证两件事：
#   ① `ssh -R` 能让远端（sshd 侧）打到本机回环端口 —— 凭据代理的物理通道
#   ② `-L` 与 `-R` 能挂在**同一条** ssh 连接上 —— 单通道原则不受威胁
#
# 前提：Windows OpenSSH（含 sshd.exe）已安装；需要**管理员**权限启动 sshd。
# 用法：bash spikes/m0/reverse-tunnel/run.sh
#
# 安全：本脚本只监听 127.0.0.1，不改系统 sshd 配置、不碰 ~/.ssh。
#       所有生成物都在本目录 work/ 下，可整目录删除。

set -u

# MSYS 会把 POSIX 风格参数（如 /c/...）自动改写成 Windows 路径，
# 传给 ssh 的远端命令会被改坏 —— 必须关掉路径转换。
export MSYS_NO_PATHCONV=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$HERE/work"
CFG="$WORK/sshd_config"
SSH_PORT=2222
PROXY_PORT=18899   # 本机凭据代理（-R 目标）
DSH_PORT=18801     # 远端 dsh（-L 目标）
FORWARD_R=18800    # 远端侧反向端口 → PROXY_PORT
FORWARD_L=18802    # 本机侧正向端口 → DSH_PORT
FORWARD_R2=18803   # 混合连接的第二个反向端口
# Windows OpenSSH 下远端命令由 cmd.exe 执行，没有 sleep；用 powershell 保活
REMOTE_HOLD='powershell -NoProfile -Command Start-Sleep -Seconds 12'

fail=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

kill_pid() { [[ -n "${1:-}" ]] && taskkill //PID "$1" //F >/dev/null 2>&1; }

cleanup() {
  step "清理"
  kill_pid "${SSH_PID:-}"
  kill_pid "${NODE_PID:-}"
  if [[ -f "$WORK/sshd.pid" ]]; then
    kill_pid "$(tr -d '\r\n' < "$WORK/sshd.pid")"
  fi
  # pid 文件可能已被 sshd 删掉；按端口兜底
  local p
  p="$(netstat -ano | grep -i ":${SSH_PORT} .*LISTENING" | awk '{print $NF}' | head -1)"
  kill_pid "$p"
  echo "work 目录保留在 $WORK（如需重跑可 rm -rf 后重来）"
}
trap cleanup EXIT

# 轮询等待某个本地端口进入 LISTENING，避免盲等
wait_port() {
  local port="$1" i
  for i in $(seq 1 40); do
    netstat -ano | grep -qi ":${port} .*LISTENING" && return 0
    sleep 0.25
  done
  return 1
}

step "0. 环境检查"
ssh -V 2>&1 | head -1
SSHD_BIN="$(command -v sshd.exe || command -v sshd)"
[[ -n "$SSHD_BIN" ]] || { bad "找不到 sshd（需 Windows OpenSSH Server 组件）"; exit 1; }
node --version >/dev/null || { bad "找不到 node"; exit 1; }
echo "sshd = $SSHD_BIN"

mkdir -p "$WORK" || exit 1
cd "$WORK" || exit 1

step "1. 生成隔离 hostkey / 客户端 key"
if [[ ! -f hostkey ]]; then
  ssh-keygen -q -t ed25519 -f hostkey -N '' -C 'r1-1-hostkey'
  ssh-keygen -q -t ed25519 -f clientkey -N '' -C 'r1-1-client'
fi
cp clientkey.pub authorized_keys
pass "hostkey / clientkey 就绪"

# Windows sshd 会因 hostkey 的 ACL 过宽拒绝加载；必须收紧成仅当前用户可读。
# 引号在 bash 里会被 MSYS 改写，所以写 .ps1 传参（坑 #6）。
step "2. 收紧 hostkey ACL"
cat > fixacl.ps1 <<'PS1'
param([string]$Target)
$me = "$env:USERDOMAIN\$env:USERNAME"
icacls $Target /inheritance:r /grant:r "${me}:F" | Out-Null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
PS1
for f in hostkey clientkey authorized_keys; do
  powershell -NoProfile -ExecutionPolicy Bypass -File fixacl.ps1 -Target "$(cygpath -w "$WORK/$f")" \
    || { bad "ACL 收紧失败：$f"; exit 1; }
done
pass "ACL 已收紧"

step "3. 渲染并校验 sshd 配置"
sed "s#__WORKDIR__#$(cygpath -m "$WORK")#g" "$HERE/sshd_config.template" > "$CFG"
if "$SSHD_BIN" -T -f "$(cygpath -m "$CFG")" > sshd.effective.txt 2>sshd.t.err; then
  pass "配置可解析（$(wc -l < sshd.effective.txt | tr -d ' ') 行有效配置）"
else
  bad "配置无效"; sed 's/^/      /' sshd.t.err; exit 1
fi
grep -qi '^allowtcpforwarding yes' sshd.effective.txt \
  && pass "生效值 allowtcpforwarding yes" || bad "转发未开启"
grep -qi '^gatewayports no' sshd.effective.txt \
  && pass "生效值 gatewayports no（不对外暴露）" || bad "GatewayPorts 非预期"

step "4. 起隔离 sshd（需要管理员权限）"
# 坑：sshd.exe 从 MSYS bash 直接前台启动时不会自行 detach，会一直占住管道
# （表现为脚本卡住直到超时）。必须用 Start-Process 真正脱离。
rm -f sshd.pid
powershell -NoProfile -Command \
  "Start-Process -FilePath '$(cygpath -w "$SSHD_BIN")' -ArgumentList '-f','$(cygpath -w "$CFG")' -WindowStyle Hidden" \
  || { bad "Start-Process 失败"; exit 1; }
if wait_port "$SSH_PORT"; then
  SSHD_PID="$(tr -d '\r\n' < sshd.pid 2>/dev/null)"
  pass "sshd 已在 127.0.0.1:$SSH_PORT 监听，pid=${SSHD_PID:-?}"
else
  bad "sshd 未监听（多半是没管理员权限）"; exit 1
fi

step "5. 起两个假服务"
# 坑：node 是原生 Windows 程序，收到 /d/... 这类 POSIX 路径会拼成 D:\d\...
# 必须传 Windows 路径（cygpath -w），不能直接用 $HERE。
node "$(cygpath -w "$HERE/servers.cjs")" > servers.log 2>&1 &
NODE_PID=$!
if wait_port "$PROXY_PORT" && wait_port "$DSH_PORT"; then
  pass "凭据代理 $PROXY_PORT + 远端 dsh $DSH_PORT 均在听"
else
  bad "假服务未起"; sed 's/^/      /' servers.log; exit 1
fi

SSH_COMMON=(-i clientkey -p "$SSH_PORT" -o StrictHostKeyChecking=no
            -o UserKnownHostsFile=/dev/null -o ExitOnForwardFailure=yes
            -o BatchMode=yes -o LogLevel=ERROR)

step "6. 验证 ①：-R 反向转发（远端 → 本机代理）"
ssh "${SSH_COMMON[@]}" -R "${FORWARD_R}:127.0.0.1:${PROXY_PORT}" \
    "$USERNAME@127.0.0.1" "$REMOTE_HOLD" >ssh1.log 2>&1 &
SSH_PID=$!
if wait_port "$FORWARD_R"; then
  if body="$(curl -s --noproxy '*' --max-time 5 "http://127.0.0.1:${FORWARD_R}/from-remote")" \
     && grep -q '"hit":true' <<<"$body"; then
    pass "-R 通：$body"
  else
    bad "-R 端口在听但请求失败（resp=${body:-<empty>}）"
  fi
else
  bad "-R 未建立监听"; sed 's/^/      /' ssh1.log
fi
kill_pid "$SSH_PID"; SSH_PID=""

step "7. 验证 ②：-L 与 -R 同一连接共存（单通道原则）"
ssh "${SSH_COMMON[@]}" -L "${FORWARD_L}:127.0.0.1:${DSH_PORT}" \
                        -R "${FORWARD_R2}:127.0.0.1:${PROXY_PORT}" \
    "$USERNAME@127.0.0.1" "$REMOTE_HOLD" >ssh2.log 2>&1 &
SSH_PID=$!
if wait_port "$FORWARD_L" && wait_port "$FORWARD_R2"; then
  l_body="$(curl -s --noproxy '*' --max-time 5 "http://127.0.0.1:${FORWARD_L}/" || true)"
  grep -q 'REMOTE_DSH' <<<"$l_body" \
    && pass "-L 通（本机→远端 dsh）：$l_body" \
    || bad "-L 请求失败（resp=${l_body:-<empty>}）"
  r_body="$(curl -s --noproxy '*' --max-time 5 "http://127.0.0.1:${FORWARD_R2}/mixed" || true)"
  grep -q '"hit":true' <<<"$r_body" \
    && pass "-R 同连接通（远端→本机代理）：$r_body" \
    || bad "-R 同连接请求失败（resp=${r_body:-<empty>}）"
else
  bad "混合连接的转发端口未全部建立"; sed 's/^/      /' ssh2.log
fi

step "结果"
if [[ $fail -eq 0 ]]; then
  printf '\033[32m全部通过\033[0m：-R 可用，且 -L/-R 可挂同一条连接 → 单通道原则不受威胁。\n'
else
  printf '\033[31m存在失败项\033[0m：见上方 FAIL 行。\n'
fi
exit $fail
