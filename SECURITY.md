# Security Policy

## 安全边界

TGBOJ 会编译并执行用户提交的代码。仅设置时间和内存限制并不等同于完整沙箱。

- 本地开发可使用普通模式，但只应接受可信用户提交。
- 生产部署必须使用独立低权限判题账号、进程隔离和出网阻断。
- 公网部署必须启用 HTTPS、`cookieSecure`、强管理员密码和定期备份。
- 高风险环境建议将判题器迁移至独立容器、虚拟机或专用节点。

仓库中的 `harden-root.sh`、`nftables-persist.sh` 和 `tgboj.service` 提供 Linux 基础加固模板，但不能替代专业沙箱审计。

## 禁止提交的数据

请勿提交：

- `config.json`、`.env` 或真实 API 密钥
- `users.json`、`sessions.json`、日志和统计数据
- `submissions/`、附件、备份和评测工作目录
- 学生姓名、编号、代码或其他个人信息
- 未获授权的题目、题解及测试数据

若敏感信息已进入 Git 历史，仅新增 `.gitignore` 无法移除；应立即轮换密钥并清理历史。

## 报告漏洞

请通过 GitHub Security Advisories 的 **Report a vulnerability** 私下报告，并提供：

- 受影响版本或提交
- 复现步骤
- 影响说明
- 可行的修复建议（如有）

请勿在公开 Issue 中披露可利用细节。维护者确认修复并安排发布后再公开讨论。
