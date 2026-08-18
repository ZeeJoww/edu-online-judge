# 公开发布检查清单

## 必须完成

- [ ] 仅保留原创或已获授权的演示题与测试数据
- [ ] 删除用户、会话、提交、附件、日志、备份及个人信息
- [ ] 检查完整 Git 历史中是否存在密钥或隐私数据
- [ ] 将 `README.md` 与 `docs/index.html` 中的 GitHub 用户名、仓库名和 Demo 地址替换为真实值
- [ ] 确认 MIT License 的版权主体与年份
- [ ] 在临时目录重新克隆仓库并按 README 完成启动
- [ ] 启用 GitHub Security Advisories
- [ ] 将 GitHub Pages 来源设置为 GitHub Actions

## 题库策略

当前生产题库不应直接作为作品内容公开。推荐新建干净的公开仓库，只迁移：

- 程序源码与前端资源
- 示例配置和部署脚本
- 文档与自动检查
- 少量原创演示题

不要从生产仓库直接复制 `.git` 历史。仓库提供安全导出脚本，它只读取已提交的 `HEAD`，排除生产 `problems/`，并加入原创 A+B 示例题：

```bash
bash scripts/export-public.sh ../tgboj-public
cd ../tgboj-public
# 检查内容后再提交与推送
git add .
git commit -m 'chore: initial public release'
```

若确需保留原历史，应先用 `git filter-repo` 清理数据，并在副本中验证；不要对正在运行的仓库直接重写历史。

## 推送前检查

```bash
git status --short
git ls-files | grep -E '(^|/)(config\.json|users\.json|sessions\.json|submissions|files|backup)($|/)' && echo '发现不应公开的文件'
git grep -nE 'sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY'
git ls-files -z | xargs -0 du -b | sort -nr | head
```

建议将公开仓库控制在 1 GB 以内，单个普通 Git 文件不要接近 GitHub 的 100 MB 限制。
