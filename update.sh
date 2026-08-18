#!/usr/bin/env bash
# update.sh — TGBOJ 旧版本 → 新版本更新脚本（保留全部数据）
# 用法: 把 本脚本 与 新版 TGBOJ-deploy.zip 放在同一目录（或任意位置），执行:
#       bash update.sh
# 会: 1) 定位旧部署目录  2) 备份数据  3) 替换程序文件  4) 重跑 setup.sh  5) 重启服务
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 1) 新版 zip 定位
NEW_ZIP=""
for cand in "$SCRIPT_DIR/TGBOJ-deploy.zip" "$(pwd)/TGBOJ-deploy.zip"; do
  [ -f "$cand" ] && NEW_ZIP="$cand" && break
done
[ -n "$NEW_ZIP" ] || { echo "错误: 未找到 TGBOJ-deploy.zip（请把它与本脚本放在同一目录）"; exit 1; }
echo "[1/5] 新版包: $NEW_ZIP"

# 2) 定位旧部署目录（含 judge/server.js）
OLD=""
for cand in "$(pwd)/NOI2004-yydcny" "$SCRIPT_DIR/NOI2004-yydcny" "$HOME/NOI2004-yydcny" "$(dirname "$NEW_ZIP")/NOI2004-yydcny"; do
  [ -f "$cand/judge/server.js" ] && OLD="$cand" && break
done
[ -n "$OLD" ] || { echo "错误: 未找到旧部署目录（找不到 judge/server.js），请 cd 到旧目录的上一级再运行"; exit 1; }
echo "[2/5] 旧部署目录: $OLD"

# 3) 解压新版
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
echo "[3/5] 解压新版 ..."
unzip -q "$NEW_ZIP" -d "$WORK" || { echo "解压失败"; exit 1; }
NEW="$WORK/NOI2004-yydcny"

# 4) 备份数据（不删，供保险）
BK="$OLD/.update-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BK"
for d in submissions problems files homework.json files.json; do
  src="$OLD/judge/$d"
  [ -e "$src" ] && cp -r "$src" "$BK/" 2>/dev/null
done
[ -f "$OLD/评测记录.json" ] && cp "$OLD/评测记录.json" "$BK/"
echo "[4/5] 数据已备份到: $BK（更新失败可从这里恢复）"

# 5) 替换程序文件（不触碰数据目录）
cp -f "$NEW/judge/server.js" "$NEW/judge/judge.js" "$NEW/judge/setup.sh" "$NEW/judge/config.json" "$OLD/judge/"
rm -rf "$OLD/judge/public"
cp -r "$NEW/judge/public" "$OLD/judge/"
[ -f "$NEW/node-v14.21.3-portable.tar.gz" ] && cp -f "$NEW/node-v14.21.3-portable.tar.gz" "$OLD/"
[ -f "$NEW/gcc-10-portable-linux-x64.tar.gz" ] && cp -f "$NEW/gcc-10-portable-linux-x64.tar.gz" "$OLD/"
echo "程序文件已替换（数据目录未动）"

# 重跑 setup.sh（解压便携工具链并写入 config.json）
echo "[5/5] 重新配置工具链 ..."
cd "$OLD/judge" && bash setup.sh

# 重启服务
PIDS=$(pgrep -f "node server\.js" 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  kill $PIDS 2>/dev/null && echo "旧服务已停止"
  sleep 1
fi
echo ""
echo "=========================================="
echo "更新完成！启动方式:"
echo "  cd $OLD/judge"
echo "  ~/.tgboj-node/bin/node server.js"
echo "（若你之前改过端口，请编辑 $OLD/judge/config.json 的 port 后再启动）"
