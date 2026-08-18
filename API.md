# TGBOJ HTTP API 文档

局域网竞赛评测系统。单 Node 进程零依赖，JSON 直写存储。

## 通用约定

- **Base URL**：`http://<host>:<port>`（默认 8090）
- **认证**：登录后服务端下发 `Set-Cookie: tgboj_token=<token>; HttpOnly; SameSite=Lax`，后续请求自动携带；部分接口也可手动带 `Cookie: tgboj_token=...`
- **角色**：`superadmin`（超管）> `admin`（教师）> `user`（学生）；「管理员」= admin 或 superadmin
- **请求体**：除 multipart 接口外均为 `application/json`
- **响应**：成功 `200` 返回 JSON 对象；失败返回 `{ "error": "..." }` 与对应状态码（400/401/403/404）
- **题目编号**：`FIRST_PROBLEM_ID = 2026` 起自动递增
- **语言**：`c++14` / `c++17` / `c++20` / `python3`（python3 解释执行，时空限制与 C++ 一致）

## 认证与账号

| 接口 | 方法 | 权限 | 说明 |
|---|---|---|---|
| `/api/auth/register` | POST | 公开 | body `{username, password, fullname}`；注册后需管理员审核（status: pending） |
| `/api/auth/login` | POST | 公开 | body `{username, password, remember?}`；remember=true 会话 30 天，否则 1 天；返回 `{ok, user}` 并下发 cookie |
| `/api/auth/logout` | POST | 登录 | 注销当前会话 |
| `/api/auth/me` | GET | 公开 | 返回 `{user}`（未登录 `user: null`） |
| `/api/auth/change-password` | POST | 登录 | body `{oldPassword, newPassword}`；改密保留其他会话 |

## 题目

### `GET /api/problems`

公开。返回 `{ problems: [...] }`，每题含 `{id, title, testCount, judgeable, hidden, rankEnabled, timeLimitSec, memLimitKb, owner, acCount, triedCount}`。

隐藏题对非管理员过滤。

### `GET /api/problem?id=<pid>`

公开。返回单题详情：

```json
{
  "id": 2049, "title": "...", "html": "<渲染后题面>", "judgeable": true,
  "testCount": 12, "timeLimitSec": 1, "memLimitKb": 262144,
  "sampleInput": "1 3\n...", "sampleOutput": "8\n...",
  "samples": [ { "id": "1", "input": "...", "output": "..." }, ... ],
  "solutionHtml": "", "solutionText": "",
  "descriptionText": "...", "hidden": false
}
```

- `samples` 为**多组样例**（`sample.in/out`、`sample2.in/out`…按编号排序）；`sampleInput/sampleOutput` 兼容字段指向第一组
- 隐藏题非管理员返回 404

## 提交与评测

### `POST /api/submit`（登录）

body：`{ problemId, std, code }`

- `std` ∈ `c++14|c++17|c++20|python3`；`code` 长度 10~100000
- 隐藏题仅管理员可提交；不可评测题返回 400
- 返回 `{ id }`（提交编号）；代码存 `submissions/<id>.cpp|.py`

### `GET /api/status`

公开。返回 `{ list, problems }`。

- `list`：提交数组（倒序），每项含 `{id, problemId, problemTitle, username, name, std, ip, hidden, status, summary, score, examId, phase, verdictHidden, submittedAt, finishedAt, points, sampleResults}`
  - `score`：得分 0~100（子任务部分分 / 按点均分）；`examId`/`phase`：模考归属（exam=考试期 / correction=订正）
  - `verdictHidden`：模考 hideVerdict 未公布时对学生为 true（summary/score 置空，前端显示「已评测 · 成绩暂不公布」）
  - `status` ∈ `queued|judging|done`
  - `summary`：`{verdict, display, firstError, timeMs, memKb, sampleFailed?, sampleInfo?, compileError?}`；**firstError 优先指向失败的样例**（如 `WA on sample#2`），否则指向第一个失败测试点（`WA on test #5`）
  - `points`：逐测试点 `{id, verdict, timeMs, cpuMs, memKb}`
  - `sampleResults`：多组样例逐组结果 `[{id, verdict, timeMs, memKb}]`
- 查询参数：`?user=&problem=&excludeAdmins=1`（excludeAdmins 隐藏教师提交）
- **服务端分页**（可选）：`?page=&size=`（page≥1、size 1~200）→ 只返回该页 `list`，并附 `total`（筛选后总数）/`page`/`size`；`?find=<submissionId>&size=` 定位该提交所在页（最新在前，返回其 `page`）；**不带 page/size 时返回全量列表**（`size:null`，兼容旧客户端/管理后台/测试）。前端评测状态页已改为逐页拉取（10/20/50/100 每页）。
- `problems`：题目列表（管理员视角全量）

### `GET /api/code/<id>`（权限：本人 / 管理员 / 本人有 AC）

返回提交代码原文（text/plain）。

### `GET /api/testcase/<id>?type=in|out`（权限同 code）

下载第一个未通过**正式测试点**的输入（默认）或标准输出。CE 不提供。

- `type=out`（标准输出/期望答案）：管理员始终可下；非管理员需 `config.json` 的 `allowTestOutputDownload: true` 才允许，默认 false 时返回 403（防套取官方隐藏答案）

## 排行榜

### `GET /api/rank?sort=&dir=&session=`

公开。只统计 `rankEnabled && !hidden && judgeable` 的题目（历史期按该期 `order`，不依赖 rankEnabled）；教师不参与。得分满分 100 按测试点均分；提交次数计到 AC 为止；同分按最早 AC 时间。题目列顺序跟随所选期次的编程作业顺序。

返回额外含 `{sessions: [{id, name}], session}`（id 0=当前期，≥1 历史期；`?session=N` 指定，默认 0）。

## 警示（警示后人区）

| 接口 | 方法 | 权限 | 说明 |
|---|---|---|---|
| `/api/warnings?problem=<pid>` | GET | 公开 | 返回 `{list, mine}`；历史版本仅发布人与管理员可见 |
| `/api/warning` | POST | 登录 | body `{problemId?, text, sampleIn?, sampleOut?}`；每人每题一条，更新时旧版入 history（限 50 条） |
| `/api/warning/toggle` | POST | 登录（发布人/管理员） | 公开/隐藏切换（不可删） |

## 作业

### `GET /api/homeworks?session=`（登录）

返回 `{ sessions: [{id, name}], session, homeworks, programmingJobs }`。

- `sessions`：期次列表（id 0=当前期，≥1 历史期，来自 `homework.json` 的 `currentSessionName`/`sessions`）；`?session=N` 指定查看某期，默认 0
- `homeworks`：该期问答题作业 `{id, title, questionCount, publishedAt, startAt, hidden, star}`（当前期自动排除已归档到历史期的作业；历史期按该期 `homeworkIds`）
- `programmingJobs`：该期编程作业题 `{id, title, testCount, timeLimitSec, memLimitKb, hidden, star}`（当前期按 `programmingOrder`；历史期按该期 `order`，与 rankEnabled 无关；学生视角必做星标在前、隐藏题过滤）

### `GET /api/homework?id=<hwId>`（登录）

返回作业详情 `{id, title, started, questions, myAnswer, submittedAt, comment, commentHtml, commentPublic, commentRead, score, gradeStatus}`；`startAt` 未到返回 400。评语对本人直接可见。

### `POST /api/homework/answer`（登录）

body `{homeworkId, answers: string[]}`。同 uid 覆盖（允许订正）。

### `GET /api/homework/answers?homeworkId=<id>`（管理员）

查看全部答案。返回 `{title, questions, answers}`，每条答案含 `comment`/`commentPublic`/`commentRead`、`commentHtml`（评语 Markdown 渲染）与 `answerHtml`（**Markdown 渲染**后的逐问 HTML）。

### 编程作业管理（管理员）

| 接口 | body | 说明 |
|---|---|---|
| `POST /api/admin/homework/programming-order` | `{order: number[]}` | 设置当前期编程作业顺序 |
| `POST /api/admin/homework/programming-star` | `{problemId, star}` | 当前期必做星标 |
| `POST /api/admin/homework` | `{title, questions[], startAt?}` | 发布问答题作业 |
| `POST /api/admin/homework/star` | `{id, star}` | 问答题作业星标（`homeworkStars`） |
| `POST /api/admin/homework/settings` | `{id, hidden?, allowViewOthers?}` | 作业隐藏 / 开启「查看他人答案」开关 |
| `POST /api/admin/session/current` | `{session: N}` | 把历史期 N 设为当前期（原当前期归档回原位，可逆） |
| `GET /api/admin/export-session` | `?session=N`（0=当前期，≥1 历史期） | 导出该期次题目集为 Markdown（题面/样例/参考代码，.md 附件下载） |

### 作业评语（管理员）

| 接口 | body | 说明 |
|---|---|---|
| `POST /api/admin/homework/comment` | `{homeworkId, uid, comment, public?}` | 写/更新评语；`public=true` 时批改列表直接显示（无需点击查看），学生端收到未读红点 |
| `POST /api/admin/homework/grade` | `{homeworkId, uid, score}` | 打分 0~100 |
| `POST /api/admin/homework/announcement` | `{id, text}` | 作业公告 |

## 附件

| 接口 | 方法 | 权限 | 说明 |
|---|---|---|---|
| `/api/files` | GET | 登录 | 附件列表 `{files: [{id, name, ext, size, uploadedAt}]}` |
| `/api/file/view?id=<id>` | GET | 登录 | 在线阅读（.md 渲染 / .cpp / .pdf / .txt） |
| `/api/admin/file` | POST | 管理员 | multipart 上传（字段 `file`） |
| `/api/admin/file/delete` | POST | 管理员 | body `{id}` |
| `/api/admin/file/hidden` | POST | 管理员 | body `{id, hidden}` 附件隐藏/显示（hidden 仅控制列表是否单独展示，题面内嵌图片仍可读） |
| `/files/<id>/raw` | GET | **位图类型匿名**，其余登录 | 原始文件；`.png/.jpg/.jpeg/.gif/.webp/.bmp` 匿名可读（题面 `<img>` 内嵌用）；`.svg` 需登录且响应带 `CSP: sandbox`（防内嵌脚本）；`download` 始终需登录 |

## 日志

| 接口 | 方法 | 权限 | 说明 |
|---|---|---|---|
| `/api/log` | POST | 登录 | 上报页面访问 `{page, action?, detail?}`（fire-and-forget） |
| `/api/admin/logs` | GET | 管理员 | `?limit=&user=&page=&action=`；最多保留 5000 条 |

## 管理：题目

### `POST /api/admin/problem`（管理员，multipart）

新建题目（`hidden` 默认 **true**，上线需手动开放）：

- 文本字段：`title`、`description`（markdown）、`problemId`（可选，更新现有题数据）、`hidden`（`0`/`false` 立即开放）、`solution`
- 数据文件：`1.in` `1.out`、`2.in` `2.out`…（`.in/.out` 成对）
- 样例文件：`sample.in` `sample.out`（可选，支持多组 `sample2.in/out`…）

### `POST /api/admin/problem/package`（管理员，multipart）

压缩包一键建题（zip / tar.gz，字段 `pkg`）：

- 包内需含 `description.md`（必需）；可选 `problem.json`（title/timeLimitSec/memLimitKb）、`data/<n>.in/.out`、`sample*.in/out`、`solution.md`
- 新建题目同样默认 `hidden: true`

### 其他题目操作（管理员）

| 接口 | body | 说明 |
|---|---|---|
| `/api/admin/problem/hide` | `{problemId, hidden}` | 隐藏/开放 |
| `/api/admin/problem/rank` | `{problemId, rankEnabled}` | 是否参与排行榜（= 是否在编程作业） |
| `/api/admin/problem/edit` | `{problemId, title?, description?, tags?}` | 编辑标题/描述（description 写入 description.md） |
| `/api/admin/problem/delete` | `{problemId}` | 删除（上传人本人或超管），连带提交/数据/题解，移出编程作业 |
| `/api/admin/solution` | `{problemId, content}` | 编辑题解（markdown） |
| `/api/admin/rejudge` | `{ids: number[]}` | 原地重评（保持提交 id） |
| `/api/admin/hide` | `{id, hidden}` | 隐藏/显示单条提交（测试提交等） |
| `/api/admin/problem/notify` | `{problemId, text}` | 向打开过/提交过该题的学生发「提示更新」通知（返回 `{targets}`） |

### 题目打开记录与提示更新通知

| 接口 | 方法 | 权限 | 说明 |
|---|---|---|---|
| `POST /api/problem/view` | POST | 登录 | 记录登录用户打开题目（`{problemId}`），落盘 `problem_views.json`，作为通知目标 |
| `POST /api/notifications/problem/read` | POST | 登录 | 标记某题「提示更新」通知已读（`{problemId}`） |
| `GET /api/notifications/unread` | GET | 登录 | 未读通知：作业评语（type `hw`）+ 题目提示更新（type `problem`）合并，`{count, items}`；红点点击跳转（题目→`/problem.html?id=`，作业→`/homework.html?id=`） |

## 管理：用户

| 接口 | body | 说明 |
|---|---|---|
| `/api/admin/users` | GET | 用户列表（含审核状态/角色/编号 studentId） |
| `/api/admin/user/audit` | `{id, action: approve\|reject}` | 审核注册 |
| `/api/admin/user/role` | `{id, role}` | 超管任命/撤销管理员 |
| `/api/admin/user/save` | `{id?, username, fullname, studentId?, password?, role?, status?}` | 新增/编辑用户；id 缺省=新建（管理员创建即 active）；角色/状态仅超管可改；password 留空=不改 |
| `/api/admin/user/password` | `{id, password}` | 管理员重置密码（≥7 位），并踢出该用户全部会话 |
| `/api/admin/users/batch` | `{users:[{studentId, fullname, username, password?}], defaultPassword?}` | 批量建号；返回 `{created, skipped, results[]}`；编号已绑定/用户名占用/密码不足 7 位 → skipped+reason |
| `GET /api/myproblems` | — | 我的错题本：`{problems:[{id,title,tags,bestScore,verdict,ac,tries,lastAt,lastSubId}]}` |
| `POST /api/admin/homework/import-zip` | multipart `session`(0=当前期,≥1 历史期) + zip | 解析「考生编号/题名/题名.cpp」包 → `{token, sessionName, sesProblems, students(含自动匹配), unmatched*}` |
| `POST /api/admin/homework/import-zip/apply` | `{token, session, students:[{folder,uid,problems:[{file,pid,std}]}], createUsers, defaultPassword}` | 导入评测计入该期次；返回 `{created, skipped, errors, createdUsers}`；同期次同人同题相同代码幂等跳过 |
| `/api/admin/check` | GET | 管理员身份自检 `{ok}` |

## 评测行为细节

- 队列：全局 FIFO 并发评测（全局最多 `maxParallel` 个，单用户最多 `maxPerUser` 个；公平调度，多用户同时评测时占用多的让位给占用少的）
- 流程：编译（g++ `-O2 -std=c++XX -lm`；python3 用 `py_compile` 语法检查）→ 先测**全部样例组**（失败不阻断）→ 逐正式点运行
- 判定：`AC/WA/TLE/MLE/RE/CE/SE`；输出比对忽略行尾空白与末尾空行
- 限制：`ulimit -v` 限内存；GNU time 计 CPU/RSS；`timeout` 墙钟兜底；单点进程组有 `wall+5s` 强杀兜底（防队列卡死）
- 分数：每题满分 100，按正式测试点均分；三个 `type` 各 4 点即各占 1/3
- 数据下载：CE 不提供；其余失败提供第一个未过正式点的输入/输出（样例失败不影响）

## 评分（OI 子任务部分分 / 测试点均分）

题目 `problem.json` 可含 `scoring` 配置；无配置 = 按测试点均分（满分 100，向后兼容；CSP-S 等赛制惯例）。

## 传统文件读写（NOIP/CSP 惯例）

`problem.json` 可含 `fileIO: {"in":"network.in", "out":"network.out"}`：评测时把输入复制为 `<in>` 供 `freopen` 读取，运行后若生成 `<out>` 则以它为准（未生成则回退标准输出捕获）；同一题内 freopen 与标准输入输出两种写法等价。

| 接口 | 方法 | 权限 | 说明 |
|---|---|---|---|
| `/api/admin/problem/scoring` | POST | 管理员 | body `{problemId, scoring}`；`scoring=null` 恢复按点均分；否则 `{mode:"subtask", subtasks:[{id,score,tests,depends}]}`（分数自动归一化到 100） |

`/api/problem` 响应含 `scoring`（当前评分规则）与 `examInfo`（所属最近/进行中模考：`{id,name,startAt,endAt,publishAt,status,published,hideVerdict}`，题目页横幅用）。

**子任务规则**：子任务内所有测试点全 AC 且其 `depends` 引用的子任务全部通过 → 得该子任务满分，否则 0 分；总分 = 通过子任务分数之和。提交 `summary.display`：满分 `AC`，否则为得分（如 `20`）；`subtaskResults` 逐子任务 `{id, score, maxScore, pass, verdict, tests}`。

## 模考（考试 / 成绩同步 / 订正）

| 接口 | 方法 | 权限 | 说明 |
|---|---|---|---|
| `/api/exams` | GET | 登录 | 模考列表 `{exams:[{id,name,startAt,endAt,publishAt,hideVerdict,problemCount,status,published}], now}` |
| `/api/exam?id=` | GET | 登录 | 模考详情 + 我的成绩：`{exam, status, published, problems[], my:{<pid>:{examScore,examSubId,corrScore,corrSubId}}}` |
| `/api/admin/exam` | POST | 管理员 | 创建：`{name, problemIds[], startAt, endAt, publishAt?, hideVerdict?}`（publishAt 缺省 = endAt） |
| `/api/admin/exam/edit` | POST | 管理员 | 编辑：`{id, name?, problemIds?, startAt?, endAt?, publishAt?, hideVerdict?}` |
| `/api/admin/exam/delete` | POST | 管理员 | `{id}`（历史提交保留，不再按模考处理） |
| `/api/admin/exam/publish` | POST | 管理员 | `{id}` 立即公布成绩（publishAt=now） |
| `/api/admin/exam/results?examId=` | GET | 管理员 | 成绩表：`{exam, problems[], rows:[{uid,username,fullname,total,tried,problems:{<pid>:{score,subId,attempts,corrScore,corrSubId,corrAttempts}}}]}` |
| `/api/admin/exam/import` | POST | 管理员 | 成绩/代码同步导入：`{examId, items:[{username, problemId, std?, code, submittedAt?}]}`；本地评测后计入成绩表，返回 `{created, errors[]}` |
| `/api/admin/exam/import-zip` | POST | 管理员 | 离线机房代码包导入第一步：multipart 上传 `{examId, file(.zip/.tar.gz)}`，目录结构 `编号/题目名/题目名.cpp`；返回 `{token, examProblems, allStudents, students:[{folder,matched,candidates,problems:[{folder,file,std,size,head,matchedPid,candidates}]}], warnings, unmatchedStudents, unmatchedProblems}` |
| `/api/admin/exam/import-zip/apply` | POST | 管理员 | 第二步确认导入：`{token, examId, createUsers?, defaultPassword?, students:[{folder, uid, problems:[{file, pid, std}]}]}`；按考试期导入评测（ip=offline）；`createUsers` 为未匹配编号创建账号（用户名=编号规整化，姓名=编号，默认密码）；相同代码重复导入幂等跳过；返回 `{created, skipped, errors[], createdUsers[]}` |

**提交归属**：`POST /api/submit` 自动归入进行中的模考（phase=exam）或最近一场已结束的模考（phase=correction，订正不影响考试成绩）；可显式传 `examId`。模考提交不受 `contest.json` 比赛锁限制（按考试时间窗放行）；考试未开始学生不可提交。

**成绩隐藏**：`hideVerdict:true` 的模考在 `publishAt` 前，学生视角 `/api/status` 与 `/api/submission/<id>` 隐藏判定与分数（`verdictHidden:true`），`/api/exam` 不返回本人分数（`myHidden:true`），且他人（含本人有 AC 者）不能查看该考试提交的代码/样例/错误数据；管理员全见。公布后学生可见自己全部提交、代码与逐点/子任务结果并订正。模考提交（考试 + 订正）不计入普通排行榜。

## 近期新增：课堂大屏 / 统计 / 查重 / 比赛

| 接口 | 方法 | 权限 | 说明 |
|---|---|---|---|
| `/api/board` | GET | 管理员 | 课堂大屏数据：当前期次每题 AC 人数/提交条数/评测中 + 最近提交（含评测进度 `judgedCount/totalTests`）+ 未处理代码求助（`helpRequests`，含代码全文，教师处理后从公屏移除）；`board.html` 投影页用 |
| `/api/admin/stats?problemId=` | GET | 管理员 | 题目统计 `{problems:[{id,title,acCount,triedCount,totalCount,verdictCounts,avgTries}]}`；不传 problemId 返回当前期次全部 |
| `/api/admin/plagiarism?problemId=` | GET | 管理员 | 代码查重 `{submissions, pairs:[{a,b,distance,level}]}`；SimHash 海明距离，level ∈ `near-identical`(≤3)/`high`(≤10) |
| `/api/contest` | GET | 登录 | 比赛时间 `{contest:{startAt,endAt,title,mode,penaltyMinutes}, status, now}`；`mode` ∈ `oi`（每题取末次提交成绩）/ `ioi`（取最高分）/ `acm`（解题数+罚时），status ∈ none/upcoming/running/ended |
| `/api/contest/rank` | GET | 登录 | 比赛实时榜单：`{contest, status, now, problems:[{id,title,testCount}], rows:[{rank,username,fullname,solved,penalty,total,cells:{<pid>:{attempts,solved,score,penalty}}}]}`；仅统计窗口内非管理员、非模考提交；题目列=窗口内有提交的非隐藏可评测题（按当前期顺序） |
| `/api/admin/contest` | POST | 管理员 | body `{startAt,endAt,title?,mode?,penaltyMinutes?}` 设置（mode ∈ oi/ioi/acm，罚时默认 20 分钟/次），或 `{clear:true}` 清除 |

## 近期新增：三开关 / 多份题解参考 / 提交详情

| 接口 | 方法 | 权限 | 说明 |
|---|---|---|---|
| `/api/admin/problem/vis` | POST | 管理员 | body `{problemId, approachOpen?|solutionOpen?|referenceOpen?}` 切换三开关，热更新无需重启 |
| `/api/admin/solutions` | POST | 管理员 | body `{problemId, list:[{name,content}]}` 整体保存多份题解（`solution.json`） |
| `/api/admin/reference` | POST | 管理员 | body `{problemId, lang, code}` 按语言保存/清除单份参考代码（`lang` ∈ `cpp`/`py`；`code` 留空清除该语言，同语言覆盖） |
| `/api/admin/references` | POST | 管理员 | body `{problemId, list:[{name,lang,code}]}` 整体保存多份参考代码（`reference.json`） |
| `/api/submission/<id>` | GET | 登录 | 单份提交详情（逐点结果 + 样例 + Ex 点 + `score`/`subtaskResults` 子任务得分 + `prevId` 供「对比上次」diff）；模考未公布时学生视角 `verdictHidden:true` |
| `/api/excase/<id>?exid=&type=in\|out\|actual` | GET | 权限同代码 | Ex 数据下载（hack 数据只下载不内联展示） |
| `/api/admin/rejudge-code` | POST | 管理员 | 改代码并评测（新建管理员提交，不覆盖原提交） |

## 近期新增：P0-P3 加固与接口补全（2026-08-18）

| 接口 | 方法 | 权限 | 说明 |
|---|---|---|---|
| `/api/admin/session/create` | POST | 管理员 | `{name}` 新建作业期次：当前期归档为历史首位，新空期成为当前期（此前只能停服手改 homework.json） |
| `/api/admin/session/rename` | POST | 管理员 | `{session, name}` 期次改名（0=当前期，≥1 历史期） |
| `/api/admin/session/delete` | POST | 管理员 | `{session}` 删除历史期次（仅空期次可删，防误删成绩） |
| `/api/admin/user/delete` | POST | 超管 | `{id}` 删除用户（保留其提交/答案历史，踢出全部会话；不能删除超管与当前账号） |
| `/api/admin/problem/checker` | POST | 管理员 | multipart `{problemId, file(checker.cpp)}` 上传 SPJ 并自动编译（mtime 变化即重编译，失败回退文本比对并记录日志）；`{problemId, clear:1}` 清除 |
| `/api/admin/problem/edit` | POST | 管理员 | 新增字段：`timeLimitSec`（钳制 ≤60s）、`memLimitKb`（钳制 ≤8GB）、`fileIO`（`{in,out}` 或 null 恢复标准IO）；`/api/problem` 响应新增 `fileIO` |
| `/api/admin/config` | GET | 管理员 | 运行配置只读展示（端口/默认时空限制/并发/examsEnabled/`judgeUid`/`judgeUidPool` 等；修改仍需编辑 config.json 重启） |
| `/api/notice` | GET | 公开 | 全站公告 `{text, createdAt}`（首页横幅） |
| `/api/admin/notice` | POST | 管理员 | `{text}` 发布全站公告（空文本=删除） |
| `/api/homework/read` | POST | 登录 | `{id}` 标记该作业评语已读（原为 GET 附带写副作用，已改为显式 POST） |
| `/api/homework/others?id=` | GET | 登录 | 查看同学答案（**仅当教师开启 allowViewOthers**，否则 403；管理员不受限） |
| `/api/admin/queue` | GET | 管理员 | 评测队列监控：`{maxParallel, maxPerUser, running[], queued[], runningCount, queuedCount, perUser{}, judgePool[{uid,busy}]}` |
| `/api/clar` | GET | 登录 | 比赛澄清列表（学生：本人 + 公开回复；管理员：全部）+ `contestActive` |
| `/api/clar` | POST | 登录 | `{text≤500, problemId?}` 比赛窗口内提交澄清（10 分钟限 3 条；窗口外 403） |
| `/api/admin/clar/reply` | POST | 管理员 | `{id, reply≤1000, public}` 回复澄清（public=对全体学生可见） |
| `/api/me/save` | POST | 登录 | `{bio≤200}` 保存个人简介；`/api/auth/me` 同步返回 `bio`/`studentId` |
| `/api/my/code/export` | GET | 登录 | 导出本人全部提交代码（zip：代码文件 + README.md 清单）；无提交 400 |
| `/api/admin/contest` | POST | 管理员 | 新增 `freezeMinutes`（结束前 N 分钟封榜，0=关；`clear` 时一并清零） |
| `/api/contest/rank` | GET | 登录 | 响应新增 `freeze:{minutes,startAt,frozen}`；封榜期学生榜单只统计封榜前提交（管理员始终实时） |

## 近期新增：代码求助（2026-08-18）

| 接口 | 方法 | 权限 | 说明 |
|---|---|---|---|
| `/api/help/request` | POST | 登录（本人提交） | `{submissionId, note?}` 对当前期次内自己的提交发起求助（非模考、非隐藏题）；同一提交已有未处理求助时返回 400 |
| `/api/help` | GET | 管理员 | 求助列表（open 优先，`?status=open\|done` 过滤，`?withCode=1` 附代码全文），返回 `{list, openCount}` |
| `/api/help/count` | GET | 管理员 | 未处理求助数量 `{openCount}`，管理页红点提醒轮询用 |
| `/api/admin/help/resolve` | POST | 管理员 | `{id}` 标记已处理；处理后的请求不再出现在公屏，管理端列表保留为已处理 |

## 近期新增：Bug 反馈（2026-08-18）

| 接口 | 方法 | 权限 | 说明 |
|---|---|---|---|
| `/api/bugreport` | POST | 登录 | `{text, page?}` 提交问题反馈（text 1~1000 字，page 由前端自动附当前页面地址，≤200 字）；同一用户 10 分钟最多 3 条（超出 429） |
| `/api/admin/bugreports` | GET | 管理员 | 反馈列表（open 优先，`?status=open\|done` 过滤），返回 `{list, openCount}` |
| `/api/admin/bugreports/count` | GET | 管理员 | 未处理反馈数量 `{openCount}`，右上角 🐞 角标与管理页红点轮询用 |
| `/api/admin/bugreport/resolve` | POST | 管理员 | `{id}` 标记已处理（记录 resolvedAt/resolvedBy） |

数据存 `bug_reports.json`（600 权限，已纳入备份与 .gitignore）。入口：gate.js 在右上角用户名左侧注入 🐞 按钮——学生点击弹反馈窗直接发送；管理员点击跳转管理页「🐞 反馈」页签，按钮上有未处理数角标（30s 轮询）。

## 近期新增：未读反馈面板与统一已读（2026-08-18）

| 接口 | 方法 | 权限 | 说明 |
|---|---|---|---|
| `/api/notifications/unread` | GET | 登录 | 未读列表 `{count, items}`（hw 评语 + problem 题目通知；**不再包含 `__global__` 全站公告**——公告无逐人已读语义，此前会漏进列表生成 problemId=NaN 的幻影未读且永远无法标记） |
| `/api/notifications/read` | POST | 登录 | 统一已读：`{all:true}` 全部已读；`{type:'hw', homeworkId}` 该作业我的全部版本评语已读（**作业被删也可标记**，用于消除幽灵红点）；`{type:'problem', problemId}` 该题通知已读 |

前端：gate.js 红点点击改为弹出未读面板（完整列表：图标/标题/摘要/时间），每条有「查看」（跳转并标记）与「×」（标为已读即移除），顶部「全部已读」；点击面板外自动关闭。`POST /api/notifications/problem/read` 保留兼容。

## 近期新增：教师私信（2026-08-18）

| 接口 | 方法 | 权限 | 说明 |
|---|---|---|---|
| `/api/admin/message` | POST | 管理员 | `{toUid, text}` 向学生发送私信（text 1~2000 字；收件人须为学生账号；每个收件人最多保留最近 200 条） |
| `/api/admin/messages` | GET | 管理员 | 已发私信列表（`?toUid=N` 过滤，最新 200 条倒序，含 read 状态） |
| `/api/messages` | GET | 登录 | 我的私信（含已读，最新 100 条倒序：`{id, fromName, text, createdAt, read}`） |
| `/api/messages/read` | POST | 登录 | `{id}` 单条（仅本人收件，他人 404）或 `{all:true}` 全部已读 |

**引用格式（前端渲染）**：消息中 `#1234` → 提交链接 `/status.html?find=1234`；`http(s)://…` → 新窗口外链。文本先整体转义再替换，无注入风险。

私信并入未读体系：`/api/notifications/unread` 增加 `type:'msg'` 项（红点自动生效）；`/api/notifications/read` 增加 `{type:'msg', messageId}`，`{all:true}` 含私信。学生端：未读面板「查看」开消息详情弹窗（链接可点）、「×」标已读、底部「📨 历史消息」查看全部并回看。管理端：用户列表行「✉️」与「🐞 反馈」列表「✉️ 回复」打开发送弹窗（含最近 5 条发送记录）。数据存 `messages.json`（600 权限，已纳入备份与 .gitignore）。

## 近期新增：OLE / 私信入口扩展 / AI 风险检测（2026-08-18）

**OLE（Output Limit Exceeded）**：新评测状态。限额 = 题目 `problem.json.outputLimitKb`（可选）> 全局 `config.json.outputLimitKb`（默认 65536=64MB，钳制 1MB~512MB）。运行期 100ms 轮询输出文件大小，超限**立即强杀进程组**（实测 ~100ms 终止）；内核 `ulimit -f` 兜底（SIGXFSZ→退出码 153→OLE）；比对层 512MB 绝对上限兜底（原 SE 改为 OLE）。评分按非 AC 计 0 分，与 WA 同级。

**私信入口扩展**：`POST /api/admin/message` 与 `GET /api/admin/messages` 新增 `toUsername` 参数（与 toUid 并存）；gate.js 新增全局 `gateMsgCompose(username, fullname)`——评测状态页/排行榜的学生名（管理员视角）点击即弹发送窗。

**AI 风险检测**：

| 接口 | 方法 | 权限 | 说明 |
|---|---|---|---|
| `/api/admin/ai-review` | POST | 管理员 | `{submissionId, force?}` 对提交代码做 AI 安全审计（危险系统调用/卡评测机/其他风险三类）。结果缓存进提交记录 `sub.aiReview`（{risk: none/low/medium/high, categories, summary, model, at}），重复检测返回缓存，`force:true` 重检；AI 接口故障返回 502 不影响评测 |

配置 `config.json.aiReview`：`{enabled, apiUrl, model, key, timeoutSec}`（OpenAI 兼容 chat completions 全 URL；密钥优先取环境变量 `TGBOJ_AI_API_KEY`）；改配置需重启。`/api/auth/me` 与 `/api/admin/config` 仅暴露 `aiReviewEnabled` 布尔（apiKey 永不下发）；`/api/submission/<id>` 仅管理员可见 `aiReview` 字段。状态页详情弹窗（管理员）显示缓存结果 + 「🤖 AI 风险检测」按钮。

**AI 自动检测与拦截（2026-08-18）**：`aiReview.autoCheck`=学生新提交自动 AI 检测（autoBlock 关=评测后异步，开=评测前）；`autoBlock`=风险 ≥ `blockRisk`（high/medium）即拦截——不评测、`aiBlocked+hidden`（学生列表不可见，本人详情返回 `blocked+blockNote`，他人 404）；**高风险 high 始终强制拦截 + 该用户 1 分钟禁提交**（`POST /api/submit` 返回 429，内存态封禁重启即清）。AI 故障 fail-open。`POST /api/admin/ai-unblock {submissionId}` 解除拦截（不自动重评）；`POST /api/admin/ai-settings {autoCheck, autoBlock, blockRisk}` 运行期即时生效并写回 config.json（600）；`/api/admin/config` 透出 `aiAutoCheck/aiAutoBlock/aiBlockRisk`。状态渲染：`aiPending`→「🤖 AI 安全检测中…」、`aiBlocked`→「⛔ 已拦截」。

**评测小结 hint（2026-08-18）**：`sub.summary.hint`（字符串，AC/旧提交无此字段）——首个未通过点的一句话小结：WA=首个不同位置（行号+期望/实际片段，区分「输出过早结束/多余/空行不符」；checker 题取 testlib checker stderr 首行）、CE=首条报错行、RE=退出码/信号（139 段错误/134 异常中止附常见原因）、TLE/MLE/OLE=具体数值。逐点结果 `points[i].hint`、样例 `sampleResults[i].hint` 与 `GET /api/sample/<id>` 的 `hint` 字段同步提供。

**比赛赛前预览（仅管理员）**：`GET /api/contest/rank` 在 `status=upcoming` 时——普通用户返回空题目集（不剧透）；管理员返回 `preview:true` + `problems`=当前期次编程题（含隐藏题并带 `hidden` 标注，按期次顺序），`rows` 为空。contest.html 显示「👁 赛前预览（仅管理员可见）」徽章并渲染题目列空榜单。


**安全与行为变更（与旧版不兼容点）**：
- `GET /api/submission/<id>` 现要求登录（曾匿名公开逐点判定/IP）；`/api/status` 与学生视角提交详情不再返回 `ip`（仅管理员可见）。
- 隐藏题的提交在公开状态列表与详情中对非管理员不可见（模考进行中/已公布的题除外）。
- `hideVerdict` 模考未公布期间，除本人/管理员外，`/api/code`、`/api/sample`、`/api/testcase`、`/api/excase` 一律拒绝（防考试中互看）；`/api/exam` 增加 `myHidden`，公布前不返回本人分数。
- `/api/admin/exam/import-zip`、`/api/admin/homework/import-zip`、`/api/admin/problem[/package]`、`/api/admin/file` 等 multipart 接口改为**鉴权前置**（未授权大请求体不再读入内存）。
- 压缩包（建题/离线导入）解压前校验条目路径（拒绝 `../` 与绝对路径）并限制解压总量（1~2GB）；解压后全树扫描**拒绝符号链接条目**（symlink 写穿防护，目录层级上限 128）。
- Markdown 渲染转义引号（修复 img alt 属性注入存储型 XSS）；SVG 附件不再匿名放行且响应带 CSP sandbox。
- 作业答案每人每作业最多保留 20 个历史版本；未读评语通知按作业去重。
- 评测执行链重构：用户程序为 timeout 直接子进程（TLE 精确终止、无孤儿进程），路径全部 shell 单引号转义（防注入），墙钟兜底放宽为 max(3s, 2×时限)，Python ulimit -v 放宽至 ≥512MB；checker.cpp 修改后自动重编译。
- 注册限速（每 IP 每 10 分钟 10 次）；登录失败记录 30 分钟自动清理；非法 JSON 返回 400；评测队列上限 300。
- **判题 uid 池（并发互扰隔离）**：`judgeUidPool` 池内 uid 按空闲最少分配，不同并发提交的 `work/<id>` 属主互异（0770 组=服务器组），提交间不可互读/互写/互杀；池内 uid 出网被 nftables 阻断（`nftables-persist.sh` 持久化）。启动时 `getent` 校验池内 uid，全部失效自动回退单 `judgeUid`。
- 注册用户名枚举防护：用户名已占用与通用失败返回同一文案（不泄露账号是否存在），真实原因只记服务端日志。
