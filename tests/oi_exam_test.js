'use strict';
// e2e 测试：OI 子任务部分分 + 模考（考试/成绩隐藏/公布/订正）+ 成绩导入同步
// 用法：服务运行后执行 node tests/oi_exam_test.js [baseUrl] [adminPassword]
//   默认 baseUrl=http://localhost:8090，adminPassword 取环境变量 TGBOJ_ADMIN_PASSWORD
const BASE = (process.argv[2] || 'http://localhost:8090').replace(/\/$/, '');
const ADMIN_PW = process.argv[3] || process.env.TGBOJ_ADMIN_PASSWORD || '';
let fail = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra && !cond ? ' | ' + JSON.stringify(extra) : '')); if (!cond) fail++; };

function jarToken() { return jar.token ? { Cookie: 'tgboj_token=' + jar.token } : {}; }
const jar = { token: '' };
async function api(method, p, body, useCookie, rawHeaders) {
  const headers = Object.assign({}, useCookie ? jarToken() : {}, body && !rawHeaders ? { 'Content-Type': 'application/json' } : {}, rawHeaders || {});
  const r = await fetch(BASE + p, { method, headers, body: (body === undefined || body === null) ? undefined : (rawHeaders ? body : JSON.stringify(body)) });
  if (method === 'POST' && p === '/api/auth/login') {
    const sc = r.headers.get('set-cookie') || '';
    const m = /tgboj_token=([^;]+)/.exec(sc);
    if (m) jar.token = m[1];
  }
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: r.status, data };
}
async function loginAs(username, password) {
  const r = await api('POST', '/api/auth/login', { username, password });
  return r;
}
// multipart 构造（零依赖）
function mpBody(fields, files) {
  const boundary = '----tgboj' + Date.now() + Math.random().toString(16).slice(2);
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n'));
  }
  for (const f of files) {
    chunks.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="data"; filename="' + f.name + '"\r\nContent-Type: application/octet-stream\r\n\r\n'));
    chunks.push(Buffer.from(f.content));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from('--' + boundary + '--\r\n'));
  return { body: Buffer.concat(chunks), ctype: 'multipart/form-data; boundary=' + boundary };
}
async function waitDone(subId, token) {
  for (let i = 0; i < 120; i++) {
    const st = await api('GET', '/api/status', null, token !== undefined);
    const s = (st.data.list || []).find((x) => x.id === subId);
    if (s && s.status === 'done') return s;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

const CODE_FULL = '#include <bits/stdc++.h>\nusing namespace std;\nint main(){long long a,b;cin>>a>>b;cout<<a+b<<endl;return 0;}';
const CODE_PARTIAL = '#include <bits/stdc++.h>\nusing namespace std;\nint main(){long long a,b;cin>>a>>b;if(a+b>10)cout<<42<<endl;else cout<<a+b<<endl;return 0;}';
const CODE_REVERSED = '#include <bits/stdc++.h>\nusing namespace std;\nint main(){long long a,b;cin>>a>>b;if(a+b<=10)cout<<42<<endl;else cout<<a+b<<endl;return 0;}';

(async () => {
  console.log('BASE =', BASE);
  // ===== 0. 管理员登录 ===== 
  let r = await loginAs('admin', ADMIN_PW);
  check('admin 登录', r.status === 200 && r.data.user && r.data.user.role === 'superadmin', r.data);
  if (r.status !== 200) { console.log('无法以 admin 登录，终止（请提供正确密码：node tests/oi_exam_test.js BASE 密码）'); process.exit(1); }

  // ===== 1. 建题（4 个测试点）+ 子任务配置 ===== 
  const dataFiles = [
    { name: '1.in', content: '1 2' }, { name: '1.out', content: '3' },
    { name: '2.in', content: '2 3' }, { name: '2.out', content: '5' },
    { name: '3.in', content: '100 200' }, { name: '3.out', content: '300' },
    { name: '4.in', content: '1000 2000' }, { name: '4.out', content: '3000' },
  ];
  const mp = mpBody({ title: 'OI子任务测试题', description: '# 求和\n读入两个整数输出和。', hidden: '0' }, dataFiles);
  r = await api('POST', '/api/admin/problem', mp.body, true, { 'Content-Type': mp.ctype });
  check('创建 4 点题目', r.status === 200 && r.data.id && r.data.testCount === 4, r.data);
  const PID = r.data.id;
  const scoring = { mode: 'subtask', subtasks: [
    { id: '1', score: 20, tests: ['1', '2'], depends: [] },
    { id: '2', score: 30, tests: ['3'], depends: ['1'] },
    { id: '3', score: 50, tests: ['4'], depends: ['2'] },
  ] };
  r = await api('POST', '/api/admin/problem/scoring', { problemId: PID, scoring }, true);
  check('设置子任务配置', r.status === 200 && r.data.scoring.mode === 'subtask' && r.data.scoring.subtasks.length === 3, r.data);

  // ===== 2. 注册两名学生并审核 ===== 
  const students = [];
  for (let i = 1; i <= 2; i++) {
    const uname = 'oistu' + Date.now().toString(36) + i;
    r = await api('POST', '/api/auth/register', { username: uname, fullname: '测试学生' + i, password: 'pass123' });
    check('注册学生' + i, r.status === 200 && r.data.ok, r.data);
    const users = await api('GET', '/api/admin/users', null, true);
    const u = users.data.users.find((x) => x.username === uname);
    r = await api('POST', '/api/admin/user/audit', { id: u.id, action: 'approve' }, true);
    check('审核学生' + i, r.status === 200 && r.data.status === 'active', r.data);
    students.push({ username: uname, uid: u.id });
  }

  // ===== 3. 部分分验证（非模考，直接提交）=====
  r = await api('POST', '/api/auth/login', { username: students[0].username, password: 'pass123' });
  check('学生1 登录', r.status === 200, r.data);
  r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: CODE_PARTIAL }, true);
  check('学生1 提交部分分代码', r.status === 200 && r.data.id, r.data);
  let s = await waitDone(r.data.id);
  check('部分分评测完成：score=20', !!s && s.score === 20 && s.summary.display === '20', s && { score: s.score, display: s.summary.display });
  const subDetail = await api('GET', '/api/submission/' + r.data.id, null, true);
  check('子任务明细：sub1 通过(20) sub2/sub3 失败', subDetail.data.subtaskResults && subDetail.data.subtaskResults[0].pass === true && subDetail.data.subtaskResults[1].pass === false && subDetail.data.subtaskResults[2].pass === false, subDetail.data.subtaskResults);
  r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: CODE_REVERSED }, true);
  s = await waitDone(r.data.id);
  check('依赖阻断验证：大点全对但 sub1 挂 → 0 分', !!s && s.score === 0, s && { score: s.score });
  // 恢复 jar 为 admin（后续步骤需要管理员）
  await loginAs('admin', ADMIN_PW);

  // ===== 4. 创建模考（进行中 + 隐藏判定）=====
  const t0 = Date.now();
  r = await api('POST', '/api/admin/exam', { name: 'e2e模考', problemIds: [PID], startAt: t0 - 60000, endAt: t0 + 30 * 60000, publishAt: t0 + 30 * 60000, hideVerdict: true }, true);
  check('创建模考', r.status === 200 && r.data.id, r.data);
  const EXAM_ID = r.data.id;

  // 学生2 考试期提交（不传 examId，验证自动归属）
  await loginAs(students[1].username, 'pass123');
  r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: CODE_PARTIAL }, true);
  check('考试期提交自动归属模考', r.status === 200 && r.data.examId === EXAM_ID && r.data.phase === 'exam', r.data);
  const EXAM_SUB = r.data.id;
  s = await waitDone(EXAM_SUB);
  check('考试期评测完成', !!s && s.status === 'done');
  // 学生视角：结果隐藏
  const stuStatus = await api('GET', '/api/status', null, true);
  const hiddenRow = (stuStatus.data.list || []).find((x) => x.id === EXAM_SUB);
  check('学生视角成绩隐藏（verdictHidden）', !!(hiddenRow && hiddenRow.verdictHidden && hiddenRow.summary === null), hiddenRow);
  const stuSub = await api('GET', '/api/submission/' + EXAM_SUB, null, true);
  check('学生查看提交详情：结果隐藏', stuSub.status === 200 && stuSub.data.verdictHidden === true, stuSub.data);
  // 管理员视角：可见
  await loginAs('admin', ADMIN_PW);
  const admStatus = await api('GET', '/api/status', null, true);
  const admRow = (admStatus.data.list || []).find((x) => x.id === EXAM_SUB);
  check('管理员视角可见分数 20', !!(admRow && admRow.verdictHidden === false && admRow.score === 20), admRow);

  // ===== 5. 结束考试 + 公布成绩 ===== 
  r = await api('POST', '/api/admin/exam/edit', { id: EXAM_ID, endAt: Date.now() - 1000 }, true);
  check('修改考试结束时间为过去', r.status === 200, r.data);
  r = await api('POST', '/api/admin/exam/publish', { id: EXAM_ID }, true);
  check('公布成绩', r.status === 200, r.data);

  // 学生2 订正提交（全对代码）→ phase=correction
  await loginAs(students[1].username, 'pass123');
  r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: CODE_FULL }, true);
  check('订正提交归属模考（correction）', r.status === 200 && r.data.examId === EXAM_ID && r.data.phase === 'correction', r.data);
  s = await waitDone(r.data.id);
  check('订正提交满分 100', !!s && s.score === 100 && s.summary.verdict === 'AC', s && { score: s.score });
  const myExam = await api('GET', '/api/exam?id=' + EXAM_ID, null, true);
  const myCell = (myExam.data.my || {})[PID] || {};
  check('我的模考：考试得分 20 / 订正得分 100', myCell.examScore === 20 && myCell.corrScore === 100, myCell);
  const stuSub2 = await api('GET', '/api/submission/' + EXAM_SUB, null, true);
  check('公布后学生可见考试提交结果', stuSub2.status === 200 && stuSub2.data.verdictHidden !== true && stuSub2.data.score === 20, stuSub2.data);

  // ===== 6. 成绩导入同步（外部模考代码）=====
  await loginAs('admin', ADMIN_PW);
  r = await api('POST', '/api/admin/exam/import', { examId: EXAM_ID, items: [{ username: students[0].username, problemId: PID, std: 'c++17', code: CODE_FULL }] }, true);
  check('导入代码成功', r.status === 200 && r.data.created === 1, r.data);
  // 等导入的提交评测完
  let importedDone = null;
  for (let i = 0; i < 120 && !importedDone; i++) {
    const res = await api('GET', '/api/admin/exam/results?examId=' + EXAM_ID, null, true);
    const row = (res.data.rows || []).find((x) => x.username === students[0].username);
    if (row && row.problems && row.problems[PID] && row.problems[PID].score === 100) importedDone = row;
    else await new Promise((r2) => setTimeout(r2, 1000));
  }
  check('导入后成绩表：学生1 = 100', !!importedDone, importedDone);
  const results = await api('GET', '/api/admin/exam/results?examId=' + EXAM_ID, null, true);
  const row2 = (results.data.rows || []).find((x) => x.username === students[1].username);
  check('成绩表：学生2 考试 20 / 订正 100', !!(row2 && row2.problems[PID] && row2.problems[PID].score === 20 && row2.problems[PID].corrScore === 100), row2 && row2.problems[PID]);

  // ===== 7. 模考提交不进普通排行榜 ===== 
  r = await api('POST', '/api/admin/homework/programming-order', { order: [PID] }, true);
  check('加入编程作业顺序', r.status === 200, r.data);
  r = await api('GET', '/api/rank', null, true);
  const leaked = (r.data.rows || []).filter((x) => x.username === students[1].username);
  check('排行榜不出现模考/订正提交（学生2 仅模考提交，被排除）', leaked.length === 0, leaked);
  const row1 = (r.data.rows || []).find((x) => x.username === students[0].username);
  check('学生1 排行榜仅计模考前练习提交（20 分，导入的 100 分不泄漏）', !!(row1 && row1.problems[PID] && row1.problems[PID].score === 20), row1);

  // ===== 8. 向后兼容：默认按点均分 ===== 
  const mp2 = mpBody({ title: 'point模式回归题', description: '# 求和2', hidden: '0' }, [
    { name: '1.in', content: '1 2' }, { name: '1.out', content: '3' },
    { name: '2.in', content: '100 200' }, { name: '2.out', content: '300' },
  ]);
  r = await api('POST', '/api/admin/problem', mp2.body, true, { 'Content-Type': mp2.ctype });
  check('创建默认计分题', r.status === 200 && r.data.id, r.data);
  await loginAs(students[0].username, 'pass123');
  r = await api('POST', '/api/submit', { problemId: r.data.id, std: 'c++17', code: CODE_PARTIAL }, true);
  s = await waitDone(r.data.id);
  check('默认计分（点均分）：1/2 → 50', !!s && s.score === 50 && s.summary.display === '1/2', s && { score: s.score, display: s.summary.display });

  console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAILED');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(2); });
