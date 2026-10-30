#!/usr/bin/env bash
# Reproduces the M0 conclusion that made the argument-rewriting layer
# unnecessary: with a UNC working directory, a rooted POSIX path handed to a
# tool resolves against the same root the distro sees, so the prompt projection
# is safe on its own.
#
# MSYS/Git-Bash rewrites arguments that look like POSIX paths into Windows paths
# before curl sees them, which silently invalidated earlier probe runs. Every
# request here percent-encodes the value and sets MSYS2_ARG_CONV_EXCL so the
# server receives exactly what was typed.
set -u
TOKEN="${1:?usage: path-semantics.sh TOKEN}"
BASE="${2:-http://127.0.0.1:3099}"

call() {
  local label="$1" path="$2"
  local encoded
  encoded=$(printf '%s' "$path" | sed 's|/|%2F|g; s|\\|%5C|g')
  printf '%-34s %s\n' "$label" "$path"
  MSYS2_ARG_CONV_EXCL='*' curl -s "$BASE/teleport-spike/call?path=$encoded" \
    -H "authorization: Bearer $TOKEN" \
    | python -c "
import sys, json
d = json.load(sys.stdin)
if not d.get('ok'):
    print('    ERROR:', d.get('error'))
    raise SystemExit
r = d['result']
print('    sent  =', d['sentPath'])
print('    isErr =', r['isError'], '|', r['content'][0]['text'].split(chr(10))[0][:120])
"
}

echo '=== 1. 根相对路径：/etc/hostname 落到 UNC share 根，而不是 C:\ 根 ==='
call 'rooted /etc/hostname' '/etc/hostname'

echo
echo '=== 2. 投影后的 POSIX cwd 路径 ==='
call 'projected posix cwd path' '/home/hui/workspace/.teleport-probe/probe.txt'

echo
echo '=== 3. 相对路径按 cwd 解析 ==='
call 'relative to cwd' '.teleport-probe/probe.txt'

echo
echo '=== 4. 反证：Windows 盘符根下存在、share 根下不存在的路径 ==='
call 'rooted /Windows/... (absent in share)' '/Windows/System32/drivers/etc/hosts'
