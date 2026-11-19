#!/usr/bin/env bash
#
# 真机宿主验证：把本插件装进一个**真实 DSH 宿主**并打它的 API。
#
# 与 `pnpm check:load` 的分工：那个用最小 ctx 替身跑 apply()（毫秒级、CI 可跑），
# 这个起**完整宿主**（真实插件加载器 + webServer + 连接围栏），分钟级、需要一份 DSH 检出。
#
# 用法：
#   DSH_CLI=/path/to/harness/apps/cli/lib/bin.js ./scripts/verify-real-host.sh [PORT]
#
# 判据（任一不满足即失败）：
#   1) 插件装进 profile 成功；
#   2) 宿主起得来，且打印出带 token 的 URL；
#   3) 用该 token 换 cookie 后，/remote-cr/api/{sources,doctor,projection,projection/targets,workspaces} 全 200；
#   4) /doctor 在**宿主进程内**跑完，八项全 ok。
set -u

PORT="${1:-3099}"
CLI="${DSH_CLI:?需要 DSH_CLI 指向 dsh 的 lib/bin.js}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="${DSH_VERIFY_HOME:-$REPO/.tmp-dsh-verify}"

rm -rf "$HOME_DIR"
mkdir -p "$HOME_DIR"

echo '==> 1) 把插件装进临时 profile'
DSH_HOME="$HOME_DIR" node "$CLI" plugin --profile web add "$REPO" >/tmp/dsh-add.log 2>&1 || { tail -5 /tmp/dsh-add.log; exit 1; }

echo '==> 2) 起宿主'
DSH_HOME="$HOME_DIR" node "$CLI" --profile web --no-open --port "$PORT" --host 127.0.0.1 >/tmp/dsh-host.log 2>&1 &
HOST_PID=$!
trap 'kill $HOST_PID 2>/dev/null' EXIT

URL=''
for _ in $(seq 1 60); do
  URL=$(grep -o 'http://127.0.0.1:[0-9]*/?token=[A-Za-z0-9_-]*' /tmp/dsh-host.log | head -1)
  [ -n "$URL" ] && break
  sleep 1
done
if [ -z "$URL" ]; then echo 'FAIL 宿主没打印 URL'; tail -10 /tmp/dsh-host.log; exit 1; fi
echo "    $URL"

echo '==> 3) 换 cookie 并打 API'
JAR=$(mktemp)
curl -s -m 8 -c "$JAR" -o /dev/null "$URL"
fail=0
for p in sources doctor projection projection/targets workspaces; do
  code=$(curl -s -m 5 -b "$JAR" -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/remote-cr/api/$p")
  printf '    %-18s %s\n' "$p" "$code"
  [ "$code" = '200' ] || fail=1
done

echo '==> 4) 宿主内跑 doctor'
curl -s -m 5 -b "$JAR" "http://127.0.0.1:$PORT/remote-cr/api/doctor" >/tmp/dsh-doctor.json
grep -q '结论：可以正常加载' /tmp/dsh-doctor.json || { echo 'FAIL doctor 结论不是「可以正常加载」'; head -c 400 /tmp/dsh-doctor.json; exit 1; }

[ "$fail" = '0' ] && echo 'verify-real-host: OK' && exit 0
echo 'verify-real-host: FAIL（有端点不是 200）'
exit 1
