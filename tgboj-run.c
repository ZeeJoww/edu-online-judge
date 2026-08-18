/* tgboj-run：setuid 包装器（无 systemd 环境下的降权方案）
 * 编译：gcc -O2 -o /usr/local/bin/tgboj-run tgboj-run.c
 * 安装：sudo chown root:<server用户> /usr/local/bin/tgboj-run && sudo chmod 4750 /usr/local/bin/tgboj-run
 * 目标 uid/gid 从 /etc/tgboj-judge.conf（root:<server用户> 0640）读取，仅 root 可改。
 */
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc < 3) return 1;
  FILE *f = fopen("/etc/tgboj-judge.conf", "r");
  if (!f) return 1;
  char line[128];
  long uid = -1, gid = -1;
  while (fgets(line, sizeof(line), f)) {
    if (!strncmp(line, "JUDGE_UID=", 10)) uid = strtol(line + 10, NULL, 10);
    if (!strncmp(line, "JUDGE_GID=", 10)) gid = strtol(line + 10, NULL, 10);
  }
  fclose(f);
  if (uid < 0 || gid < 0) return 1;
  if (setgid((gid_t)gid) != 0) return 1;
  if (setuid((uid_t)uid) != 0) return 1;
  execvp(argv[1], &argv[1]);
  return 1;
}
