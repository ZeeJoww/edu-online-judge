# TGBOJ

轻量级竞赛评测系统，面向教学、训练、作业与小型比赛。项目采用单 Node.js 进程、原生 Web 前端和 JSON 文件存储，无 npm 运行依赖。

> [静态演示](https://zeejoww.github.io/edu-online-judge/)仅展示界面和模拟评测；真实判题需要 Linux、Node.js 与编译器。

<!-- 截图由仓库维护者补充 -->

## 主要功能

- C、C++14/17/20、Python 3 评测
- 普通测试点与 OI 子任务评分
- 题库、提交、排行榜、作业和错题本
- OI / IOI / ACM 比赛模式与封榜
- 模考、离线代码包导入和成绩导出
- 管理后台、课堂大屏、通知与私信
- 代码查重、评测队列和基础风险检测
- 深色模式与移动端适配

## 技术结构

```text
Browser (HTML / CSS / JavaScript)
              │ HTTP
              ▼
      Node.js application
       ├─ authentication
       ├─ problem & contest services
       ├─ JSON persistence
       └─ judge scheduler
              │
              ▼
  isolated compiler / user process
```

| 部分 | 实现 |
|---|---|
| 服务端 | Node.js 内置模块 |
| 前端 | 原生 HTML、CSS、JavaScript |
| 存储 | JSON 文件 |
| 判题 | GCC / G++、Python 3、GNU time |
| 部署 | Linux、systemd、Caddy（可选） |

详细设计见 [`DEVELOP.md`](DEVELOP.md)，接口见 [`API.md`](API.md)。

## 本地运行

### 环境

- Linux
- Node.js 18 或更高版本
- GCC / G++
- Python 3（需要评测 Python 时）
- GNU time（推荐）

### 启动

```bash
git clone https://github.com/ZeeJoww/edu-online-judge.git
cd edu-online-judge
cp config.example.json config.json
export TGBOJ_ADMIN_PASSWORD='请替换为强密码'
node server.js
```

访问 `http://localhost:8090`。首次启动会创建管理员账号 `admin`。

生产部署前请阅读 [`SECURITY.md`](SECURITY.md)，并执行：

```bash
sudo bash harden-root.sh
```

## 题目格式

每道题位于 `problems/<id>/`：

```text
problems/1000/
├── problem.json
├── description.md
├── sample.in
├── sample.out
└── data/
    ├── 1.in
    └── 1.out
```

公开仓库建议只保留原创或已获授权的演示题。生产题库、测试数据、用户资料和提交记录不应公开。可从生产仓库生成干净副本：

```bash
bash scripts/export-public.sh ../tgboj-public
```

详细步骤见 [`PUBLICATION.md`](PUBLICATION.md)。

## 测试

基础语法检查：

```bash
git ls-files -z '*.js' ':!public/vendor/**' | xargs -0 -n1 node --check
node -e "JSON.parse(require('fs').readFileSync('config.example.json', 'utf8'))"
```

端到端测试需要先启动独立测试实例：

```bash
TGBOJ_ADMIN_PASSWORD='测试密码' node tests/e2e_test.js http://localhost:8090
```

请勿对生产数据直接运行会创建账号、题目或提交的测试。

## GitHub Pages Demo

`docs/` 默认进入复用真实 TGBOJ 网页的学生端 Demo，无需登录。题目、作业、评测状态、排行榜、比赛、模考、澄清、错题本、附件和个人中心均使用原创浏览器 Mock 数据；代码不会执行，提交、保存、下载等写操作不会持久化。原项目展示页保留在 [`docs/showcase.html`](https://zeejoww.github.io/edu-online-judge/showcase.html)。

生成学生端静态文件：

```bash
node scripts/build-pages-demo.js
```

推送后由 GitHub Actions 自动构建并部署 Pages。

## 文档

- [`DEVELOP.md`](DEVELOP.md)：架构与开发说明
- [`API.md`](API.md)：HTTP API
- [`CONTRIBUTING.md`](CONTRIBUTING.md)：参与开发
- [`SECURITY.md`](SECURITY.md)：安全边界与漏洞报告
- [`PUBLICATION.md`](PUBLICATION.md)：公开发布检查清单

## 许可证

代码基于 [MIT License](LICENSE) 发布。题目、测试数据及第三方素材可能采用各自的授权条款，公开前须单独确认。
