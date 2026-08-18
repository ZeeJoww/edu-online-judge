#!/usr/bin/env bash
# setup.sh — TGBOJ 评测服务部署脚本（麒麟桌面版适配：无 sudo / 离线也能用）
# 用法：解压迁移包后，进入 NOI2004-yydcny 目录执行 bash setup.sh
set -u

have() { command -v "$1" >/dev/null 2>&1; }
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "=== TGBOJ 评测服务部署脚本 ==="
echo "目录: $HERE"
grep -m1 PRETTY_NAME /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"' | sed 's/^/系统: /'

# 1) Node.js —— 优先用包内便携版（无 sudo、离线均可），否则用系统 node
NODE_BIN=""
PORTABLE_TGZ=""
for cand in "$HERE/node-v14.21.3-portable.tar.gz" "$HERE/../node-v14.21.3-portable.tar.gz"; do
  [ -f "$cand" ] && PORTABLE_TGZ="$cand" && break
done
if [ -n "$PORTABLE_TGZ" ]; then
  echo "[*] 发现包内便携 Node，解压中 ..."
  PREFIX="$HOME/.tgboj-node"
  rm -rf "$PREFIX"
  mkdir -p "$PREFIX"
  tar -xzf "$PORTABLE_TGZ" -C "$PREFIX"
  NODE_BIN="$PREFIX/bin/node"
  [ -x "$NODE_BIN" ] && echo "[OK] 便携 node: $($NODE_BIN -v)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  if have node; then NODE_BIN="$(command -v node)"; echo "[OK] 系统 node: $(node -v)";
  else echo "[警告] 未找到 node（便携包缺失且系统无 node），评测服务无法启动"; fi
fi

# 2) g++ —— 优先用包内便携 gcc（无 sudo/离线可用，兼容麒麟 glibc）；否则系统 g++；否则提示
CFG="$HERE/config.json"
if [ ! -f "$CFG" ]; then
  if [ -f "$HERE/config.example.json" ]; then
    cp "$HERE/config.example.json" "$CFG"
    chmod 600 "$CFG" 2>/dev/null || true
    echo "[OK] 已由 config.example.json 创建 config.json"
  else
    echo "[错误] 缺少 config.example.json，无法创建配置"
    exit 1
  fi
fi
GCC_USED=""
PORTABLE_GCC=""
for cand in "$HERE/gcc-10-portable-linux-x64.tar.gz" "$HERE/../gcc-10-portable-linux-x64.tar.gz"; do
  [ -f "$cand" ] && PORTABLE_GCC="$cand" && break
done
if [ -n "$PORTABLE_GCC" ]; then
  echo "[*] 发现包内便携 g++（gcc-10，兼容麒麟 glibc 2.31），解压中 ..."
  GPREFIX="$HOME/.tgboj-gcc"
  rm -rf "$GPREFIX"
  mkdir -p "$GPREFIX"
  tar -xzf "$PORTABLE_GCC" -C "$GPREFIX"
  GCCROOT="$GPREFIX/portable-gcc"
  if [ -x "$GCCROOT/bin/g++" ]; then
    echo "[OK] 便携 g++: $($GCCROOT/bin/g++ --version | head -1)"
    sed -i "s|\"compilerPath\": \"[^\"]*\"|\"compilerPath\": \"$GCCROOT/bin/g++\"|" "$CFG"
    sed -i "s|\"runtimeLibPath\": \"[^\"]*\"|\"runtimeLibPath\": \"$GCCROOT/lib/x86_64-linux-gnu\"|" "$CFG"
    GCC_USED="portable"
    echo "[*] 已写入 config.json: compilerPath / runtimeLibPath"
  else
    echo "[警告] 便携 g++ 解压失败"
  fi
fi
if [ -z "$GCC_USED" ]; then
  if have g++; then
    echo "[OK] 系统 g++: $(g++ --version | head -1)"
    sed -i "s|\"compilerPath\": \"[^\"]*\"|\"compilerPath\": \"g++\"|" "$CFG"
    sed -i "s|\"runtimeLibPath\": \"[^\"]*\"|\"runtimeLibPath\": \"\"|" "$CFG"
  else
    echo "[警告] 未找到 g++（便携包缺失且系统无 g++），评测编译不可用。"
    echo "       无 sudo 时请让管理员执行: sudo apt-get install -y g++"
  fi
fi

# 3) GNU time —— 有则完整统计；无则评测自动降级（仍可 AC/WA/TLE 判定）
if [ -x /usr/bin/time ] && /usr/bin/time -v true >/dev/null 2>&1; then
  echo "[OK] GNU time 可用（完整 CPU/内存统计）"
else
  echo "[*] 无 GNU time：评测将降级运行（仅靠墙钟超时判定 TLE，内存统计不可用）"
fi

# 4) 输出启动命令（使用便携 node）
echo ""
echo "=== 启动 ==="
if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then
  echo "  cd $HERE"
  echo "  $NODE_BIN server.js"
  echo ""
  echo "或写个小脚本方便以后启动（每次免输入路径）："
  echo "  echo '#!/bin/bash' > ~/start-tgboj.sh"
  echo "  echo 'cd $HERE && $NODE_BIN server.js' >> ~/start-tgboj.sh"
  echo "  chmod +x ~/start-tgboj.sh && ~/start-tgboj.sh"
else
  echo "  cd $HERE && node server.js"
fi
echo ""
echo "浏览器访问 http://<本机局域网IP>:8090（防火墙若拦截请放行 8090 端口）"
