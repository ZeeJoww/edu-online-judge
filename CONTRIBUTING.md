# Contributing

感谢参与 TGBOJ 开发。

## 开发流程

1. Fork 仓库并创建功能分支。
2. 不提交本地配置、用户数据、日志、提交代码或未获授权的题目数据。
3. 保持零 npm 运行依赖；引入新依赖前先说明必要性。
4. 修改服务端后执行 JavaScript 语法检查；涉及接口时补充测试与文档。
5. 提交 Pull Request，说明目的、影响范围、验证方式及界面截图（如适用）。

## 基础检查

```bash
git ls-files -z '*.js' ':!public/vendor/**' | xargs -0 -n1 node --check
node -e "JSON.parse(require('fs').readFileSync('config.example.json', 'utf8'))"
bash -n setup.sh backup.sh restart.sh harden-root.sh
```

端到端测试会修改运行数据，只能对临时测试实例执行。

## 提交约定

推荐使用简洁的 Conventional Commits：

```text
feat: add contest export
fix: stop orphan judge process
docs: clarify deployment steps
```

安全问题不要公开提交 Issue，请按 [`SECURITY.md`](SECURITY.md) 报告。
