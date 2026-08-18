#!/bin/bash
# TGBOJ 判题出网阻断——生效 + 持久化（root 执行一次；重跑幂等；harden-root.sh 第 4 步调用本脚本）
# 内容：收集全部 judge-run* 用户 uid → 立即重放 nft 规则（输出钩子 drop）→ 生成 /etc/tgboj-nft.conf(600)
#       → 安装 tgboj-nft.service（开机加载）→ tgboj.service 加 fail-closed 依赖（nft 失败则 OJ 拒启动）
# 背景：此前规则仅用 `nft add` 临时灌入内核，主机重启后判题出网限制会静默消失（nftables.service 未启用）。
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "需要 root：sudo bash $0"; exit 1; }
NFT="$(command -v nft || true)"
[ -n "$NFT" ] || { echo "未找到 nft 命令，退出"; exit 1; }

UIDS="$(awk -F: '/^judge-run[0-9]*:/{print $3}' /etc/passwd | sort -n)"
[ -n "$UIDS" ] || { echo "未找到 judge-run* 用户（请先执行 harden-root.sh 创建），退出"; exit 1; }
if [ "$(printf '%s\n' "$UIDS" | wc -l)" = 1 ]; then
  UIDSET="$UIDS"
else
  UIDSET="{ $(printf '%s\n' "$UIDS" | paste -sd, -) }"
fi

# 1) 立即生效（幂等：表/链存在则复用，重放规则）
nft add table inet tgboj 2>/dev/null || true
nft add chain inet tgboj judgeout '{ type filter hook output priority 0; }' 2>/dev/null || true
nft flush chain inet tgboj judgeout
nft add rule inet tgboj judgeout meta skuid "$UIDSET" counter drop

# 2) 持久化配置（开机由 tgboj-nft.service 加载）
cat > /etc/tgboj-nft.conf <<EOF
table inet tgboj {
  chain judgeout {
    type filter hook output priority 0; policy accept;
    meta skuid $UIDSET counter drop
  }
}
EOF
chmod 600 /etc/tgboj-nft.conf

# 3) 开机加载单元
cat > /etc/systemd/system/tgboj-nft.service <<EOF
[Unit]
Description=TGBOJ judge egress block (nftables)
After=network-pre.target
Before=tgboj.service

[Service]
Type=oneshot
ExecStart=$NFT -f /etc/tgboj-nft.conf
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

# 4) fail-closed：tgboj 依赖本单元（nft 失败则 OJ 不启动）
mkdir -p /etc/systemd/system/tgboj.service.d
cat > /etc/systemd/system/tgboj.service.d/nft-require.conf <<EOF
[Unit]
Requires=tgboj-nft.service
After=tgboj-nft.service
EOF

systemctl daemon-reload
systemctl enable tgboj-nft.service >/dev/null
systemctl start tgboj-nft.service

echo '[OK] 规则已生效并持久化（重启后自动加载）：'
nft list chain inet tgboj judgeout
echo '[OK] 单元状态：'
systemctl is-enabled tgboj-nft.service
