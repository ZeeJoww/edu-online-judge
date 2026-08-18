#!/bin/bash
# TGBOJ 数据备份：打包运行数据（提交/账号/作业/附件/日志）为带时间戳的 tar.gz
# 用法: ./backup.sh [输出目录] [--with-problems]
#   默认只备份运行数据（小）；--with-problems 额外打包题目数据 problems/（大，1GB+）
# 定时备份：crontab -e 加一行  0 3 * * * /path/to/judge/backup.sh
# 说明：为支持「解包即冷启动恢复」，备份额外纳入 config.json 与 .admin-pw.txt（超管口令）；
#       产物 chmod 600，仅服务器用户可读。保留策略：日备留 7 份、全量(problems)备留 3 份（分池独立保留）。
set -e
cd "$(dirname "$0")"

OUT=""
WITH_PROBLEMS=0
for a in "$@"; do
  case "$a" in
    --with-problems) WITH_PROBLEMS=1 ;;
    *) OUT="$a" ;;
  esac
done
OUT="${OUT:-$(dirname "$0")/../backup}"
mkdir -p "$OUT"
TS=$(date '+%Y%m%d-%H%M%S')
# 【修复 2026-08】日备与全量备分池命名：此前两类同名混排，ls -1t 混合保留会互相挤掉（日7/全量3 实际不成立）
if [ "$WITH_PROBLEMS" = "1" ]; then
  TAR="$OUT/tgboj-full-$TS.tar.gz"
else
  TAR="$OUT/tgboj-backup-$TS.tar.gz"
fi

# 运行数据 + 冷启动所需配置/口令（缺任一项都无法恢复出可登录的实例）
# 【修复 2026-08】补 exams.json（模考定义/成绩归属）与 clarifications.json（比赛澄清）——此前两者不在任何备份中，恢复即丢
ITEMS_ALL="submissions/ users.json sessions.json homework.json contest.json exams.json clarifications.json help_requests.json bug_reports.json messages.json files.json logs.json notices.json problem_views.json files/ config.json .admin-pw.txt"
[ "$WITH_PROBLEMS" = "1" ] && ITEMS_ALL="$ITEMS_ALL problems/"
# 仅打包当前实例实际存在的项（新功能数据文件按需创建，缺失不应导致备份失败）
ITEMS=""
for it in $ITEMS_ALL; do [ -e "$it" ] && ITEMS="$ITEMS $it"; done

# 【修复 2026-08】热备份时服务仍在写 submissions/ 与 logs.json：GNU tar 读到「file changed as we read it」
# 退出码 1（产物完整可用）——此前被当失败处理并 rm 掉产物，评测活跃期每晚备份持续静默失败。
# 现仅容忍退出码 0/1（--warning=no-file-changed 抑制告警），≥2 仍为真失败：保留现场产物并退出非零。
RC=0
tar --warning=no-file-changed -czf "$TAR" $ITEMS 2>>"$OUT/backup-errors.log" || RC=$?
if [ "$RC" -ge 2 ]; then
  echo "备份失败(rc=$RC)：$TAR（产物保留现场，详见 $OUT/backup-errors.log）"
  exit 1
fi
chmod 600 "$TAR"   # 含 config/口令，仅服务器用户可读
[ "$RC" -eq 1 ] && echo "警告：备份期间数据文件有变动（tar rc=1，产物仍完整）：$TAR"

# 保留策略：日备 7 份、全量备 3 份（分池独立保留，按文件名时间戳倒序，超出的删除最旧）
if [ "$WITH_PROBLEMS" = "1" ]; then KEEP=3; GLOB='tgboj-full-*.tar.gz'; else KEEP=7; GLOB='tgboj-backup-*.tar.gz'; fi
ls -1t "$OUT"/$GLOB 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old" && echo "已清理旧备份: $(basename "$old")"
done

echo "备份完成: $TAR ($(du -h "$TAR" | cut -f1))"
