#!/bin/bash
# TGBOJ 看门狗：服务不可用时自动重启（配合 crontab 每 2 分钟跑一次）
# 用法: ./watchdog.sh [port]  （默认 8090）
# 判定：HTTP GET / 在 10s 内返回 200 视为存活；否则杀掉残留进程并用 restart.sh 拉起
set -u
cd "$(dirname "$0")"

PORT="${1:-8090}"
LOG="watchdog.log"

# systemd 托管时由 Restart=always 负责拉起，看门狗不再介入（避免与 systemd 抢进程、丢降权配置）
if systemctl is-enabled tgboj >/dev/null 2>&1; then
  exit 0
fi

code=$(curl -m 10 -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/" 2>/dev/null || true)
if [ "$code" = "200" ]; then
  exit 0
fi

# 进程还在但无响应：先杀掉再重启
PID=$(ss -tlnp 2>/dev/null | grep ":${PORT}" | grep -oP 'pid=\K\d+' | head -1)
echo "$(date '+%F %T') 服务异常(http=${code:-无响应})，自动重启" >> "$LOG"
if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; sleep 1; fi
./restart.sh "$PORT" >> "$LOG" 2>&1
exit 0