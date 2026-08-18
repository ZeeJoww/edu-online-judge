#!/bin/bash
# 单独重放 nftables 规则（不持久化；harden-root.sh / nftables-persist.sh 已包含持久化逻辑；重复执行幂等）
set -e
JU="$(awk -F: '/^judge-run[0-9]*:/{print $3}' /etc/passwd | sort -n)"
[ -n "$JU" ] || { echo "未找到 judge-run* 用户"; exit 1; }
if [ "$(printf '%s\n' "$JU" | wc -l)" = 1 ]; then
  UIDSET="$JU"
else
  UIDSET="{ $(printf '%s\n' "$JU" | paste -sd, -) }"
fi
nft add table inet tgboj 2>/dev/null || true
nft add chain inet tgboj judgeout '{ type filter hook output priority 0; }' 2>/dev/null || true
nft flush chain inet tgboj judgeout
nft add rule inet tgboj judgeout meta skuid "$UIDSET" counter drop
nft list chain inet tgboj judgeout
