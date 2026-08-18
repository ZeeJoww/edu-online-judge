#!/bin/bash
# TGBOJ 公网加固脚本（需 root 执行一次）：sudo bash judge/harden-root.sh
# 内容：判题低权限用户 judge-run + 数据权限收紧 + 阻断判题网络 + systemd 加固单元
set -euo pipefail
JUDGE_DIR="$(cd "$(dirname "$0")" && pwd)"

# 1) 创建判题专用低权限用户（无家目录、不可登录、不属于任何特权组）
if ! id judge-run >/dev/null 2>&1; then
  useradd -r -s /usr/sbin/nologin -M judge-run
  echo "[1/6] 已创建 judge-run 用户（uid=$(id -u judge-run)）"
else
  echo "[1/6] judge-run 已存在（uid=$(id -u judge-run)）"
fi
# C：uid 池（并发提交隔离）——judge-run1..3 与 judge-run 同构，由服务器按提交分配
for i in 1 2 3; do
  if ! id "judge-run$i" >/dev/null 2>&1; then
    useradd -r -s /usr/sbin/nologin -M "judge-run$i"
    echo "[1/6] 已创建 judge-run$i 用户（uid=$(id -u "judge-run$i")）"
  else
    echo "[1/6] judge-run$i 已存在（uid=$(id -u "judge-run$i")）"
  fi
done
JU=$(id -u judge-run)
POOL_JSON="$(awk -F: '/^judge-run[0-9]*:/{print $3}' /etc/passwd | sort -n | paste -sd, -)"
echo "[1/6] 判题 uid 池：$POOL_JSON"

# 2) 目录/文件权限：数据仅服务器用户可读；判题工作区归 judge-run（setgid 组共享给服务器）
chmod 750 "$JUDGE_DIR"
chmod 600 "$JUDGE_DIR"/*.json "$JUDGE_DIR"/server.log 2>/dev/null || true
chmod 600 "$JUDGE_DIR"/submissions/submissions.json 2>/dev/null || true
chmod 700 "$JUDGE_DIR"/problems "$JUDGE_DIR"/files "$JUDGE_DIR"/.compile-cache "$JUDGE_DIR"/submissions
mkdir -p "$JUDGE_DIR"/work
RUN_USER="$(stat -c '%U' "$JUDGE_DIR"/server.js)"   # 先于下面 chown 使用（修复原脚本顺序 bug）
chown -R "$RUN_USER":"$(id -gn "$RUN_USER")" "$JUDGE_DIR"/work 2>/dev/null || true
chmod 1771 "$JUDGE_DIR"/work  # F-1：work/ 属主=服务器用户 + sticky；池内 judge-run* 仅 others-x 穿越，无法在根建链接
find "$JUDGE_DIR"/work -type f -exec chmod 660 {} \; 2>/dev/null || true
# 服务器用户须能读判题输出：把服务器运行用户加入 judge-run 组
usermod -a -G judge-run "$RUN_USER"
echo "[2/6] 权限与属主已收紧（work/ 归服务器用户 + sticky，judge-run* 仅可穿越）"

# 2.5) 池内全部 judge-run* 仅能沿路径「遍历」进入 judge/work/：中间目录收紧 750，ACL 只给 x
SERVER_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
chmod 750 "$JUDGE_DIR/.." "$JUDGE_DIR/../.." "$JUDGE_DIR/../../.." 2>/dev/null || true
for p in "$SERVER_HOME" "$JUDGE_DIR/../../.." "$JUDGE_DIR/../.." "$JUDGE_DIR/.." "$JUDGE_DIR"; do
  [ -d "$p" ] || continue
  for u in $(awk -F: '/^judge-run[0-9]*:/{print "u:"$3":x"}' /etc/passwd); do
    setfacl -m "$u" "$p" 2>/dev/null || true
  done
done
echo "[2.6] ACL 遍历链已配置（全部 judge-run* 仅可进入 work/，不可读备题目录）"

# 3) config：启用 setuid 降权 + uid 池（systemd 环境变量传递；手动启动时用 wrapper）
node -e "const fs=require('fs');const p='$JUDGE_DIR/config.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));c.judgeUid=$JU;c.judgeGid=$JU;c.judgeUidPool=[$POOL_JSON].map(Number);c.judgeRunWrapper='';fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n');"
echo "[3/6] config.json 已写入 judgeUid/judgeGid=$JU、judgeUidPool=[$POOL_JSON]"

# 4) 阻断全部 judge-run* 的出网（防 SSRF/外带/内网横向；评测编译由服务器用户完成不受影响）
#    并持久化到开机自动加载（/etc/tgboj-nft.conf + tgboj-nft.service + tgboj 的 fail-closed 依赖）
"$JUDGE_DIR/nftables-persist.sh"
echo "[4/6] nftables 已阻断 judge-run* 出网并持久化"

# 5) 安装 systemd 单元（将公开模板中的目录和用户替换为当前部署值）
RUN_GROUP="$(id -gn "$RUN_USER")"
sed \
  -e "s|^WorkingDirectory=/opt/tgboj$|WorkingDirectory=$JUDGE_DIR|" \
  -e "s|^ReadWritePaths=/opt/tgboj /tmp$|ReadWritePaths=$JUDGE_DIR /tmp|" \
  -e "s|^User=tgboj$|User=$RUN_USER|" \
  -e "s|^Group=tgboj$|Group=$RUN_GROUP|" \
  "$JUDGE_DIR/tgboj.service" > /etc/systemd/system/tgboj.service
systemctl daemon-reload
systemctl enable tgboj
echo "[5/6] systemd 单元已安装（tgboj.service；原手动进程请先停止：kill \$(ss -tlnp | grep :8090 | grep -oP 'pid=\\K\\d+' | head -1)）"

# 6) 收尾提示
cat <<'EOF'
[6/6] 完成。下一步（二选一）：
  A) systemd 方式（推荐）：先停手动进程，再 systemctl restart tgboj（新代码需重启生效）
  B) 手动启动方式：gcc -O2 -o /usr/local/bin/tgboj-run tgboj-run.c && chown root:<server用户> /usr/local/bin/tgboj-run && chmod 4750 /usr/local/bin/tgboj-run
     && 把 config.json 的 judgeUid/judgeGid 改回 0、judgeUidPool 清空、judgeRunWrapper 设为 /usr/local/bin/tgboj-run
TLS 反代：见 Caddyfile.example（公网必须 HTTPS；部署后 config.json 设 cookieSecure:true 并重启）
已包含：判题 uid 池（judge-run + judge-run1..3，并发提交互不干扰）与出网阻断持久化（tgboj-nft.service，重启后仍生效）。
EOF
