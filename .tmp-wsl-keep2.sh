#!/bin/bash
systemctl is-active ssh >/dev/null 2>&1 || systemctl start ssh 2>/dev/null || true
systemctl is-active ssh
ss -ltn | grep ':22 ' | head -n 2
pgrep -f 'sleep infinity' >/dev/null || (nohup sleep infinity >/dev/null 2>&1 &)
echo KEEPALIVE=$(pgrep -f 'sleep infinity' | head -n 1)
