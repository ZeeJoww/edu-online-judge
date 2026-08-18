# TGBOJ 开发文档

局域网竞赛评测系统（多题目 OJ）。单 Node 进程零依赖，C++ 代码沙箱评测，支持题目/作业/排行榜/附件/警示交流/账号审核。

---

## 1. 架构与技术栈

- **服务端**：Node.js（`server.js`），零 npm 依赖，纯内置模块（http / fs / crypto / child_process）；代码已模块化拆分：`server.js`（入口 + 认证 + 路由表 + 静态托管）/ `store.js`（数据层）/ `judge.js`（评测）/ `markdown.js`（渲染）/ `util.js`（工具）/ `plagiarism.js`（代码查重 SimHash）
- **评测**：`judge.js`，调用 `g++` 编译 + `/usr/bin/time` 测时测内存（无 GNU time 时优雅降级）
- **前端**：原生 HTML + JS + CSS（无框架），单文件页面，`public/` 下静态托管
- **渲染**：题面 Markdown（自写 `renderMarkdown`）+ KaTeX 数学公式（`public/vendor/` 本地库）
- **存储**：JSON 文件直写（无数据库），启动时全量载入内存、每次改动落盘
- **便携部署**：支持捆绑便携 node（v14，glibc 2.17）与便携 gcc-10（含 crt1/libm 等，修复 Kylin 缺 g++ 问题）

## 2. 目录结构（judge/）

```
judge/
├── server.js          # 主服务：入口 + 认证 + 路由表 + 静态托管 + 评测调度
├── store.js           # 数据层：常量/变量/load-save 函数（getter/setter 导出）
├── judge.js           # 评测引擎：编译 / 运行 / 比对 / 汇总
├── markdown.js        # 题面 Markdown 渲染 + multipart 解析
├── util.js            # 工具：readJson/readMultipart/reqIp/getPath 等
├── plagiarism.js      # 代码查重：SimHash 海明距离（/api/admin/plagiarism）
├── offline.js         # 离线机房代码包解析：zip/tar.gz「编号/题目名/题目名.cpp」+ GBK 文件名解码 + 自动匹配
├── restart.sh         # 一键重启 + 健康检查
├── backup.sh          # 数据备份（打包运行数据为 tar.gz）
├── config.json        # 配置（端口 / 默认时空限制 / maxParallel / judgeUidPool 等；不含管理员密码）
├── setup.sh           # 首次部署（解压便携 node/gcc、写 config）
├── update.sh          # 升级脚本（备份数据、只换程序）
├── public/            # 前端静态页面
│   ├── index.html     # 极简欢迎页（题目列表在 problems.html）
│   ├── problem.html   # 题目详情（题面/样例/题解/提交/我的提交/警示区）
│   ├── status.html    # 评测状态（分页/筛选/详情/复制）
│   ├── rank.html      # 排行榜（必做/选做分栏、按分排序）
│   ├── homework.html  # 作业（问答题 + 编程作业）
│   ├── files.html     # 附件列表
│   ├── view.html      # 附件在线阅读
│   ├── admin.html     # 管理后台（多页签）
│   ├── board.html     # 课堂大屏（仅管理员，投影用：实时进度 + 提交流）
│   ├── gate.js        # 公共脚本：登录弹窗/主题/用户菜单/导航
│   └── style.css      # 全局样式（浅色/深色主题）
├── problems/<id>/     # 每题一个目录（见 §6）
├── submissions/       # submissions.json（索引）+ <id>.cpp（代码）
├── work/<id>/         # 评测工作目录（编译产物、time.txt、输出）
├── users.json         # 用户账号（含审核状态/角色）
├── sessions.json      # 登录会话
├── logs.json          # 交互日志
├── homework.json      # 作业与编程作业配置（含期次 currentSessionName/sessions）
├── problem_views.json # 题目打开记录（通知目标）
├── notices.json       # 题目提示更新通知
├── files.json         # 附件元数据 + files/ 实际文件
├── contest.json       # 比赛时间（限时开赛：startAt/endAt 锁定学生提交）
├── exams.json         # 模考：{id,name,problemIds,startAt,endAt,publishAt,hideVerdict,owner,createdAt}[]
└── tests/e2e_test.js  # 端到端测试
```

## 3. server.js —— 板块与功能对应

### 3.1 数据层（`store.js`）

> 数据层已拆分为独立模块 `store.js`：常量、变量（`PROBLEMS`/`submissions`/`users`/`sessions`/`hwData` 等）与 load/save 函数，通过 getter/setter 导出，`server.js` 以 `store.XXX` / `store.xxx()` 访问。

| 函数 | 功能 |
|------|------|
| `loadProblems()` / `getProblem()` | 扫描 `problems/*/problem.json` 载入题目元数据 |
| `loadWarnings(pid)` / `saveWarnings()` | 读/写题目警示（`problems/<id>/warnings.json`） |
| `loadUsers()` / `saveUsers()` | 用户账号（scrypt 存密码，兼容旧 sha256 并静默升级） |
| `loadSessions()` / `saveSessions()` | 会话令牌（记住 30 天 / 默认 1 天） |
| `saveIndex()` | 提交索引落盘 |
| `saveHw()` / `saveFilesIndex()` | 作业 / 附件元数据落盘 |
| `appendLog()` | 交互日志（页面访问/离开，最多 5000 条） |
| `clampSec()` / `clampMem()` | 时空限制钳制（上限 60s / 8GB） |

### 3.2 认证与权限

| 机制 | 说明 |
|------|------|
| `authUser(req)` | 从 cookie `tgboj_token` 查会话 → 用户对象 |
| `isAdminUser(u)` | admin / superadmin 均为管理员 |
| 角色模型 | `superadmin`（超管，可任命管理员）> `admin`（教师）> `user`（学生） |
| 注册审核 | 注册需管理员审核通过（`status: pending → active`）才能登录 |
| 登录态 | 勾选「保持登录」= 30 天，否则 1 天；改密码保留其他会话 |
| CSRF 防护 | 非只读请求校验 `Origin`/`Referer` 同源（`sameOrigin`，配合 cookie `SameSite=Lax`） |
| 登录限速 | 连续失败锁用户名+IP（5 次锁 60 秒），防暴力破解 |

### 3.3 评测调度（L233~300）

- `judgeOne(sub)`：单次评测 —— 复制代码到 `work/<id>/` → 先测样例（支持多组 `sample<N>.in/out`，失败不阻断）→ 再逐点运行正式数据，汇总时附加 `sampleInfo` 标记
- `enqueue(sub)` / `pump()`：全局 FIFO 队列，并发评测（全局最多 `maxParallel` 个，单用户最多 `maxPerUser` 个；公平调度——优先调度「当前占用最少」的用户，多用户同时评测时占用多的让位给占用少的）
- 评测细节委托 `judge.js`（见 §4）

### 3.4 路由（`publicRoutes` + `routes` 数据驱动匹配）

路由表化：`publicRoutes`（auth 公开路由，在统一登录校验前匹配）+ `routes`（其余业务路由，校验后匹配），用统一匹配循环（精确字符串或正则 pattern）分发，取代原先的串行 `if (pathname === ...)`。

**公开（无需登录）**：

| 路由 | 功能 |
|------|------|
| `GET /` 及静态文件 | 页面托管（no-cache） |
| `GET /api/problems` | 题目列表（含 acCount/triedCount；隐藏题对非管理员过滤） |
| `GET /api/problem?id=` | 题目详情（题面/样例/题解/限制；隐藏题非管理员 404） |
| `GET /api/status` | 评测状态列表（管理员视角含自己提交；`?user=&problem=` 筛选） |
| `GET /api/rank` | 排行榜数据（`?sort=&dir=&session=`，返回 `sessions`） |
| `GET /api/warnings?problem=` | 题目警示（公开可见部分；历史仅发布人/管理员） |
| `GET /api/auth/*` | 注册 / 登录 / 登出 / 我的信息 / 改密码 |
| `GET /files/<id>/raw` | 图片附件匿名可读（题面 `<img>` 内嵌），其余附件需登录 |

**需登录**：

| 路由 | 功能 |
|------|------|
| `POST /api/submit` | 交题（c++14/17/20/python3；样例优先；记录 uid/ip/代码） |
| `POST /api/warning` / `.../toggle` | 写/更新警示（每人每题一条）、公开/隐藏（不可删） |
| `GET /api/homeworks` / `/api/homework?id=` | 作业列表 / 详情（startAt 未到返回 400） |
| `POST /api/homework/answer` | 提交作业答案（同 uid 覆盖） |
| `GET /api/homework/answers` | 查看某作业我的答案 |
| `GET /api/files` / `/api/file/view` | 附件列表 / 在线阅读 |
| `POST /api/log` | 交互日志上报（fire-and-forget） |
| `POST /api/problem/view` | 记录登录用户打开题目（通知目标，`problem_views.json`） |
| `GET /api/notifications/unread` | 未读通知（作业评语 + 题目提示更新，红点轮询） |
| `POST /api/notifications/problem/read` | 标记题目提示更新通知已读 |
| `GET /api/contest` | 比赛时间（startAt/endAt/status/mode/penaltyMinutes；赛制 oi=末次/ioi=最高/acm=罚时） |
| `GET /api/contest/rank` | 比赛实时榜单（按赛制计分；acm 解题数+罚时；题目列=窗口内有提交的非隐藏题；`/contest.html` 页面） |
| `GET /api/myproblems` | 我的错题本：本人全部提交聚合 → 每题最高分/最近提交（未满分=待订正） |

**管理员（admin/superadmin）**：

| 路由 | 功能 |
|------|------|
| `POST /api/admin/problem` | 新建题目（multipart：description + data/ + 样例；支持 `problemId` 覆盖更新） |
| `POST /api/admin/problem/package` | 压缩包一键建题（zip/tar.gz，A+BProblem.zip 为示例） |
| `POST /api/admin/problem/hide` | 题目隐藏/开放 |
| `POST /api/admin/problem/rank` | 设置题目是否参与排行榜 |
| `POST /api/admin/problem/edit` | 改题目元数据（标题/限制/隐藏/`tags` 标签数组或逗号分隔字符串等） |
| `POST /api/admin/problem/delete` | 删除题目（上传人本人或超管） |
| `POST /api/admin/solution` | 编辑题解（solution.md） |
| `POST /api/admin/rejudge` | 指定提交原地重评（保持 id） |
| `POST /api/admin/hide` | 隐藏/显示某条提交（测试提交等） |
| `POST /api/admin/user/audit` | 审核用户（approve/reject） |
| `POST /api/admin/user/role` | 超管任命/撤销管理员 |
| `POST /api/admin/user/save` | 新增/编辑用户（用户名/姓名/编号 studentId/角色/状态/可选改密） |
| `POST /api/admin/user/password` | 管理员重置密码（重置后踢出该用户全部会话） |
| `POST /api/admin/users/batch` | 批量建号 `{users:[{studentId,fullname,username,password}], defaultPassword}`（重复编号/用户名幂等跳过） |
| `GET /api/admin/users` / `/logs` | 用户列表（含 studentId）/ 交互日志（可筛选） |
| `POST /api/admin/homework*` | 作业发布 / 编程作业增删调序 / 必做星标 |
| `POST /api/admin/homework/import-zip` | 期次离线 OI 代码包解析（multipart `session`+zip → token+预览：编号→账号、题名→该期次编程题自动匹配） |
| `POST /api/admin/homework/import-zip/apply` | 确认后导入评测（自动创建账号、成绩计入该期次；同期次相同代码幂等跳过；提交带 `hwSession`/`imported`） |
| `POST /api/admin/session/current` | 将历史期次设为当前期（可逆） |
| `POST /api/admin/problem/notify` | 向打开过/提交过该题的学生发「提示更新」通知 |
| `POST /api/admin/file` / `.../delete` | 附件上传（.md/.cpp/.pdf 在线看）/ 删除 |
| `GET /api/admin/check` | 管理员身份自检 |
| `POST /api/admin/problem/vis` | 三开关切换（approachOpen/solutionOpen/referenceOpen，热更新无需重启） |
| `POST /api/admin/solutions` / `/references` | 整体保存多份题解/参考代码列表 |
| `GET /api/admin/plagiarism` | 代码查重（SimHash 海明距离，`?problemId=`） |
| `GET /api/admin/stats` | 题目统计（错误分布/通过率，`?problemId=` 可选） |
| `POST /api/admin/contest` | 设置/清除比赛时间（含 mode/penaltyMinutes） |
| `POST /api/admin/session/create` / `rename` / `delete` | 作业期次新建（当前期归档为历史首位）/ 改名 / 删除空期（P0 补全：此前只能手改 homework.json） |
| `POST /api/admin/user/delete` | 删除用户（超管；保留其提交/答案历史，踢出会话） |
| `POST /api/admin/problem/checker` | SPJ checker.cpp 上传/清除并自动重编译（mtime 检测，失败告警回退文本比对） |
| `GET /api/admin/config` / `POST /api/admin/notice` | 运行配置只读展示 / 全站公告发布（`GET /api/notice` 公开） |
| `GET /api/exams` / `GET /api/exam?id=` | 模考列表 / 详情 + 我的考试得分与订正得分 |
| `POST /api/admin/exam` / `.../edit` / `.../delete` / `.../publish` | 模考创建 / 编辑（含时间窗与隐藏判定）/ 删除 / 立即公布成绩 |
| `GET /api/admin/exam/results?examId=` | 成绩表（学生 × 题目：考试期最高分 + 订正最高分 + 尝试次数） |
| `POST /api/admin/exam/import` | 成绩/代码同步导入：`{examId, items:[{username, problemId, std, code}]}` 本地评测后计入成绩表 |
| `POST /api/admin/exam/import-zip` / `.../apply` | 离线机房代码包导入两步：上传 zip/tar.gz 解析预览（token + 自动匹配候选）→ 确认映射后导入评测（`offline.js`；可自动创建账号；相同代码重复导入幂等跳过） |
| `POST /api/admin/problem/scoring` | 设置题目评分配置（子任务部分分，写入 problem.json 的 `scoring`） |

## 4. judge.js —— 评测引擎

| 函数 | 功能 |
|------|------|
| `gnuTimeOk()` | 探测 `/usr/bin/time -v` 是否可用 |
| `compile()` | `g++ -O2 -std=c++XX` 编译（`-static` 不可用则普通编译；c++20 用便携 gcc-10）；python3 用 `python3 -m py_compile` 做语法检查（解释执行，CE 报语法错误） |
| `runPoint()` | 单点运行：用户程序为 timeout 的**直接子进程**（`exec` + 重定向，TLE 精确终止无孤儿进程），结束后按进程组兜底强杀；墙钟兜底 max(3s, 2×时限) + GNU time 计 CPU/RSS；`ulimit -v` 限内存（python3 放宽 ≥512MB）；所有路径 shell 单引号转义（防注入） |
| `killProcessGroup(pgid, uid)` | 跨 uid 进程组强杀：进程已被 setuid 到池 uid 时，派**同 uid 的 node 助手**执行 `process.kill(-pgid)`（修复此前跨 uid 静默 EPERM；timeout 仍为主杀路径，此处为兜底） |
| `compareFiles()` | 逐行比对（忽略行尾空白/空行） |
| `runTestPoint()` | 完整单点：运行 → 超时/溢出/非零退出 → 比对 → 返回 verdict |
| `summarize()` | 汇总成 `x/y` 摘要（全 AC 显示 `AC`，否则第一个错误点）——point 模式，向后兼容 |
| `scoreSubmission(points, total, scoring)` | **OI 评分核心**：point 模式按点均分；subtask 模式子任务全 AC（含依赖）才得分，返回 `{score, maxScore, verdict, display, firstError, subtaskResults}`（score 0~100） |

**评测规则**：
- 先样例后正式点；样例失败**不阻断**，仍完成正式评测，结果附加 `sampleFailed/sampleInfo` 标记（如「样例2未通过（WA），仍完成正式评测」）
- CE 不提供数据下载；其余失败提供「下载数据#N」（第一个错误点的输入，需权限：本人/AC 者/管理员）
- 时限默认 1s、内存 256MB（2026 题保留 1.5s/2GB）；创建题目时限制被 `clampSec/clampMem` 钳制（上限 60s/8GB）
- **新题默认隐藏**（`hidden: true`），管理员建题后需手动开放（`/api/admin/problem/hide`），上线后对学生可见
- 判题结果 `{verdict, timeMs, cpuMs, memKb}` 逐点存于提交记录
- 加大栈：`ulimit -s 262144`（256MB 栈），避免递归爆栈

**判题降权与并发隔离（uid 池）**：
- `config.json` 的 `judgeUidPool`（如 `[997,998,999,1000]`，harden-root.sh 写入；缺省回退单 `judgeUid`，两者皆无 = 不降权，隔离实例用此形态）。
- `server.js` 启动时用 `getent passwd <uid>` 校验池内 uid（全部失效自动回退，防 spawn EPERM 断评测）；`allocJudgeUid()` 空闲最少分配，`sub._judgeUid` 在 pump 的 finally 释放（覆盖成功/CE/SE/异常全路径）。
- `work/<id>`：`chown <分配uid>:<服务器组>` + `0770` —— 服务器（组内）可写源码/输入、读结果；其他池 uid 既非属主也不在组内 → 并发提交互不可读/写/杀。
- `work/` 根目录：`2771 judge-run:<服务器组>`（store.js 启动重建时固化）——池内非属主 uid 需 **others-x** 才能穿越进入 `work/<id>`（bash 链里全是绝对路径文件访问）；无 r/w 权限 → 不可列根目录/建文件，隔离不受影响。**教训：work 根 2770 时池 uid 无法穿越，首个 `exec 2> file` 重定向即失败 → 全部 RE（bash 退出码 1、无任何输出文件）。**
- 判题 uid 出网由 nftables 输出钩子阻断（`nftables-persist.sh` 持久化：`/etc/tgboj-nft.conf` + `tgboj-nft.service` + `tgboj.service.d/nft-require.conf` fail-closed）；ACL 遍历链对全部 judge-run* 只授 x（harden-root.sh 步骤 2.6）。
- CE 路径同样清理 workDir（与 SE/成功路径一致）。

**比赛封榜（freeze）**：
- `contest.json` 的 `freezeMinutes`（0=关）；`/api/contest/rank` 计算 `freezeStart = endAt - freezeMinutes*60s`，running 期间 `now ≥ freezeStart` 时非管理员只看 `submittedAt ≤ freezeStart` 的提交（管理员始终实时）；比赛结束自动解封。管理页「🏆 比赛」页签设置开关与分钟数。

**评测队列监控**：`/api/admin/queue` 只读暴露 `queue`/`runningSubs`/`runningUsers`/`judgeUidBusy` 快照（`sub._judgedAt` 记录进入评测时间）；管理页 5 秒轮询。

**比赛澄清**：`clarifications.json`（store.loadClars/saveClars，600、原子写）；学生仅比赛窗口内可提问（`clarTrack` 10 分钟 3 条），管理员回复带 public 标记。

**个人中心**：`users.json` 每条可带 `bio`（≤200，`/api/me/save`）；代码导出 `/api/my/code/export` 用系统 `zip` CLI 打包 tmp 目录（零依赖），README.md 清单 + 全部 `.cpp/.py`。

**前端编辑器**：CodeMirror 5 vendor 于 `public/vendor/codemirror/`（MIT LICENSE 随附）；`problem.html` 交题框 `fromTextArea` 就地升级，语言切换联动 mode，提交前 `cm.save()`。

## 5. 前端页面 —— 功能对照

| 页面 | 核心功能 |
|------|---------|
| `index.html` | 极简欢迎页（居中「TGBOJ 欢迎你」，无数据/功能；题目列表在 problems.html） |
| `problems.html` | 题目列表：编号/标题/「过题/尝试」/限制；分页/搜索/知识点标签筛选；管理员行内「开放/隐藏」切换按钮 |
| `problem.html` | 题面顶部 `#编号 题名` + 交题按钮（右侧灰色「评测状态」）；样例复制；题解（KaTeX）；我的提交（最高分）；页面最底部**警示后人区**（写/隐藏/查看历史） |
| `status.html` | 评测列表：分页（10/20/50/100 每页）、`?user=&problem=` 筛选、详情弹窗（逐点结果+下载数据#N+查看代码）、复制按钮 |
| `rank.html` | 排行榜：必做（蓝）/选做（橙）分栏、列头箭头排序、得分单元格按分数深浅着色（AC 深绿/部分分渐变/0 分淡绿/未提交无色）、点击得分跳转该用户该题提交、5 秒自动刷新 |
| `homework.html` | 作业：问答题（startAt 解锁）+ 编程作业（教师管理：增删/上移下移/必做星标/隐藏开放/**导出/导入题号存档/一键移除全部**；学生视角必做在前） |
| `files.html` / `view.html` | 附件列表 / 在线阅读（.md/.cpp/.pdf/.txt） |
| `admin.html` | 管理后台页签：日志/用户/题目/txt作业/附件/🏆比赛/❓澄清/📅模考（含队列监控面板；提交管理在 status.html） |
| `gate.js` | 公共：登录/注册弹窗（可关）、用户名下拉菜单、主题切换（浅/深）、管理员「普通用户界面」模式切换、页面访问日志上报 |

**前端身份视图**：`tgboj_mode`（localStorage）控制管理员显示管理功能或普通用户视图；右上角管理员显示「教师」。

## 6. 数据文件格式

### 6.1 `problems/<id>/`（每题目录）

```
problems/2044/
├── problem.json     # 元数据 {id,title,timeLimitSec,memLimitKb,hidden,rankEnabled,owner,approachOpen,solutionOpen,referenceOpen}
├── description.md   # 题面（Markdown，支持 $ 公式）
├── sample.in/out    # 样例（可选）
├── solution.md      # 题解（单份，可选）
├── solution.json    # 题解（多份 [{name,content}]，优先于 solution.md）
├── reference.json   # 参考代码（多份 [{name,lang,code}]）
├── data/            # 正式数据 <n>.in / <n>.out（可选 → judgeable=false 仅题面）
└── warnings.json    # 警示（可选）{list:[{id,uid,username,fullname,text,sampleIn,sampleOut,visible,createdAt,updatedAt,history[]}]}
```

`problem.json` 的 `approachOpen/solutionOpen/referenceOpen` 为「做法/题解/参考代码」三开关：字段缺失=老题默认开放，显式 `false`=新题默认隐藏（`assemble.sh` 写入 `False`）。

**子任务评分（OI 部分分）**：`problem.json` 可含 `scoring` 字段（缺失 = 按点均分）：

```json
"scoring": { "mode": "subtask", "subtasks": [
  { "id": "1", "score": 20, "tests": ["1", "2"], "depends": [] },
  { "id": "2", "score": 30, "tests": ["3"], "depends": ["1"] },
  { "id": "3", "score": 50, "tests": ["4"], "depends": ["2"] }
] }
```

规则：子任务内所有测试点全 AC 且 `depends` 引用的子任务全部通过 → 得该子任务满分，否则 0 分；总分 = 通过子任务分数之和（自动归一化到 100 整数）。未归入任何子任务的测试点仍评测但不计分。提交记录存储 `score`（0~100）与 `subtaskResults`（逐子任务结果）。

`description.md` 支持特殊折叠板块：`## 提示N`（N 可省略，各自独立折叠，浅绿系）、`## 做法`（浅黄系）；题目开头可用 `> **公告**：…` 引用块作公告。

### 6.2 提交记录 `submissions/submissions.json`

```json
[{ "id": 266, "uid": 1, "problemId": 2041, "username": "admin", "name": "超级管理员",
   "std": "c++17", "ip": "192.168.x.x", "codeFile": "266.cpp",
   "submittedAt": 1786..., "status": "done", "hidden": false,
   "summary": {"display": "AC", "total": 9, "ac": 9, "firstFail": null},
   "points": [{ "id": "1", "verdict": "AC", "timeMs": 135, "cpuMs": 120, "memKb": 9708 }] }]
```

### 6.3 其他

- `users.json`：`{id, username, fullname, passwordHash（scrypt 64 字节）, salt, role, status, createdAt, approvedAt}`；损坏时启动备份为 `.corrupt-<ts>` 不覆盖
- 数据文件损坏兜底：所有 JSON 加载统一走 `loadJsonSafe`（损坏→改名备份+告警，绝不静默置空覆盖）
- `sessions.json`：`{ sha256(token): {uid, expireAt} }`（只存 token 哈希，防文件泄露后重放明文 token）
- `homework.json`：`{homeworks:[{id,title,questions,startAt,hidden,allowViewOthers}], answers:[...含 comment/commentPublic/commentRead], programmingOrder:[...], programmingStars:[...], homeworkStars:[...], currentSessionName, sessions:[{name, order, stars, homeworkIds, homeworkStars}]}`（`sessions` 为历史期次，当前期数据存顶层字段）
- `problem_views.json`：题目打开记录 `{pid: [uid]}`（通知目标）
- `notices.json`：题目提示更新通知 `{pid: {text, createdAt, readBy: [uid]}}`
- `files.json`：附件元数据；文件本体在 `files/`
- `logs.json`：交互日志（`{t, uid, username, action, page, detail}`）

## 7. 配置 `config.json`

```json
{ "title": "网站标题", "port": 8090,
  "timeLimitSec": 1, "memLimitKb": 262144, "compileTimeoutMs": 30000,
  "compilerPath": "g++", "runtimeLibPath": "", "maxParallel": 4, "maxPerUser": 2 }
```

> 注：`dataDir`、`descriptionFile` 字段已废弃（题目数据在 `problems/<id>/`），保留仅为兼容。

**管理员密码不再存 config.json**：初始密码通过环境变量 `TGBOJ_ADMIN_PASSWORD` 提供（config.json 与 `config.example.json` 均不含明文；`store.js` 启动时读环境变量兜底为空）。首次启动生成超管账号 `admin`；部署日志不打印密码。

## 8. 部署与升级

- `setup.sh`：首次部署（解压便携 node/gcc 到 `~/.tgboj-*`，写 config，启动）
- `update.sh`：从旧版本升级 —— 备份数据到 `.update-backup-ts/`，只替换程序文件，不碰用户数据，重跑 setup.sh（会清空旧便携工具缓存避免误编译）
- 零依赖：无需 `npm install`；Kylin 桌面版可用便携 node14 + 便携 gcc10 直接运行

## 9. 关键业务机制

| 机制 | 实现要点 |
|------|---------|
| 分档评分（如 AxB） | 数据分 4 档（int/ll/高精/DFT），按 AC 点数均分自动产生 25/50/75/100 |
| 排行榜 | 每题 100 分按点数均分；高分在前，同分按最早 AC 时间；同分不并列；0 分用户不显示；隐藏题不计入；`rankEnabled` 控制参与 |
| 必做/选做 | `programmingStars` 星标；学生视角必做在前；排行榜分栏着色 |
| 隐藏语义 | 题目/提交/作业三级隐藏；学生与匿名不可见，管理员全见（普通用户界面模式前端也过滤） |
| 警示历史 | 更新时旧版入 history（限 50 条），仅发布人与管理员可见 |
| 代码可见性 | 管理员全见；AC 后可看他人代码；本人随时可见；`canViewCode(sub, me)` 统一判定；**hideVerdict 模考未公布期间除本人/管理员外一律拒绝**（考试公平） |
| 作业期次 | `homework.json` 的 `currentSessionName` + `sessions[]`；`/api/homeworks`、`/api/rank` 带 `?session=`；管理页「设为当前期次」`session/current` 可逆切换 |
| 题目提示更新通知 | 打开记录（`problem_views.json`）+ 提交者聚合目标；`notify` 发 `notices.json`；学生红点轮询 30s、点击跳转并标记已读 |
| 公开评语 | 评语 `commentPublic` 标记；公开评语批改列表单行直显（`教师评语：…` 灰底）；学生详情直显本人评语 |
| 多提示/做法板块 | 题面 `## 提示N`/`## 做法` 折叠为 `details.md-hint/.md-sol`（绿/黄系，深色适配） |
| 分页 | 题目列表/评测状态：页码 `x±2^k` 跳跃、宽度不够折叠省略号、`?page=&size=` URL 保持、按页码/编号跳转 |
| 附件图片内嵌 | 图片附件 `raw` 匿名放行（题面可 `<img>` 引用），非图片与 download 需登录 |
| 做法/题解/参考 三开关 | `problem.json` 三字段；新题默认隐藏；`/api/admin/problem/vis` 热更新 |
| 代码查重 | `plagiarism.js` SimHash 海明距离（≤3 几乎相同/≤10 高度相似）；`/api/admin/plagiarism` |
| 比赛模式 | `contest.json` startAt/endAt/mode/penaltyMinutes；开始前/结束后学生无法提交（管理员不受限；模考提交按考试时间窗放行）；`/api/contest/rank` 按赛制计分（oi=末次/ioi=最高/acm=解题数+罚时），`/contest.html` 实时榜单 |
| 模考/考试 | `exams.json`；考试期间提交自动归入模考（phase=exam，不可绕过），结束后提交自动记为订正（phase=correction，不影响考试成绩）；`hideVerdict` 考试在 publishAt 前对学生隐藏判定（管理员全见）；成绩公布后学生可见自己代码与逐点/子任务结果并订正 |
| 离线代码包导入 | `offline.js` + `/api/admin/exam/import-zip`：解压「编号/题目名/题目名.cpp」（Buffer 路径遍历 + UTF-8/GBK 文件名解码）→ 自动匹配编号→账号（studentId/用户名/姓名）与题目名→模考题（标题/题号/包含）→ 确认后按考试期导入评测；解压临时目录注册 token（2 小时自动清理） |
| 课堂大屏 | `/board.html` 仅管理员；`/api/board` 聚合当前期次进度 + 最近提交（必做前置、提交次数=评测条数） |
| 提交 diff | 评测详情「对比上次」；`/api/submission/<id>` 返回 `prevId` |

## 10. 常见维护操作

```bash
# 启动 / 重启
node server.js            # 前台
./restart.sh              # 一键重启（停旧启新 + 健康检查）

# 数据备份
./backup.sh               # 打包运行数据为带时间戳 tar.gz（--with-problems 额外打包题目数据）
cd judge && git add -A && git commit -m "..."   # git 存档

# 查看运行状态
curl http://localhost:8090/api/status | python3 -m json.tool

# 端到端测试
node tests/e2e_test.js
```
