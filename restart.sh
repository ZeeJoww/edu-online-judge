#!/bin/bash
# TGBOJ 重启脚本：systemd 托管时 kill MainPID 由 Restart=always 自动拉起；否则走 nohup 旧路径
# 用法: ./restart.sh [port]
set -e
cd "$(dirname "$0")"

PORT="${1:-8090}"

if systemctl is-enabled tgboj >/dev/null 2>&1; then
  echo "==> systemd 托管：kill MainPID → Restart=always 自动拉起（无需 sudo）..."
  PID=$(systemctl show tgboj.service -p MainPID --value 2>/dev/null || true)
  if [ -n "$PID" ] && [ "$PID" != "0" ]; then kill "$PID" 2>/dev/null || true; fi
  NEW=""
  for i in $(seq 1 24); do
    sleep 0.5
    NEW=$(systemctl show tgboj.service -p MainPID --value 2>/dev/null || true)
    if [ -n "$NEW" ] && [ "$NEW" != "0" ] && [ "$NEW" != "$PID" ]; then break; fi
  done
  if systemctl is-active tgboj >/dev/null 2>&1 && [ -n "$NEW" ] && [ "$NEW" != "0" ] && [ "$NEW" != "$PID" ]; then
    echo "==> 已重启（MainPID: ${PID:-?} → $NEW）"
    echo "    查看日志：journalctl -u tgboj -f"
    exit 0
  fi
  echo "==> systemd 重启失败，单元状态："; systemctl status tgboj --no-pager -n 5 || true; exit 1
fi

LOG="server.log"

echo "==> 停止旧进程（端口 $PORT）..."
PID=$(ss -tlnp 2>/dev/null | grep ":$PORT" | grep -oP 'pid=\K\d+' | head -1)
if [ -n "$PID" ]; then
  kill "$PID" 2>/dev/null || true
  sleep 1
fi

echo "==> 启动服务..."
setsid nohup node server.js > "$LOG" 2>&1 < /dev/null & disown
sleep 2

if ss -tlnp 2>/dev/null | grep -q ":$PORT"; then
  echo "==> 启动成功，监听端口 $PORT"
  head -1 "$LOG"
else
  echo "==> 启动失败！日志尾部："
  tail -20 "$LOG"
  exit 1
fi
