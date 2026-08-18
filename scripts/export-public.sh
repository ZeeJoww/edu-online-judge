#!/usr/bin/env bash
# 从当前仓库已提交的 HEAD 生成不含生产题库和运行数据的公开仓库副本。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$ROOT/../tgboj-public}"

if [ -e "$DEST" ] && [ "$(find "$DEST" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
  echo "错误：目标目录非空：$DEST" >&2
  exit 1
fi

mkdir -p "$DEST"
cd "$ROOT"

echo "[*] 导出已提交版本：$(git rev-parse --short HEAD)"
git archive --format=tar HEAD -- . ':(exclude)problems/**' | tar -xf - -C "$DEST"

mkdir -p "$DEST/problems"
cp -a "$DEST/examples/problems/1000" "$DEST/problems/1000"

cd "$DEST"
git init -b main >/dev/null

echo "[OK] 已生成公开仓库：$DEST"
echo "     仅含源码、文档、静态 Demo 和原创 A+B 示例题。"
echo "     请检查后执行：git add . && git commit -m 'chore: initial public release'"
