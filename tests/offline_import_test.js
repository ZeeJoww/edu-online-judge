'use strict';
// e2e 测试：线下机房模考代码包导入（编号/题目名/题目名.cpp 结构 zip）
// 用法：node tests/offline_import_test.js [baseUrl] [adminPassword]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const BASE = (process.argv[2] || 'http://localhost:8090').replace(/\/$/, '');
const ADMIN_PW = process.argv[3] || process.env.TGBOJ_ADMIN_PASSWORD || '';
let fail = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra && !cond ? ' | ' + JSON.stringify(extra) : '')); if (!cond) fail++; };

const jar = { token: '' };
function cookieHeader() { return jar.token ? { Cookie: 'tgboj_token=' + jar.token } : {}; }
async function api(method, p, body, useCookie, rawHeaders) {
  const headers = Object.assign({}, useCookie ? cookieHeader() : {}, body && !rawHeaders ? { 'Content-Type': 'application/json' } : {}, rawHeaders || {});
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
async function loginAs(u, p) { return api('POST', '/api/auth/login', { username: u, password: p }); }
function mpBody(fields, files) {
  const boundary = '----tgboj' + Date.now() + Math.random().toString(16).slice(2);
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n'));
  }
  for (const f of files) {
    chunks.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + f.name + '"\r\nContent-Type: application/octet-stream\r\n\r\n'));
    chunks.push(typeof f.content === 'string' ? Buffer.from(f.content) : f.content);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from('--' + boundary + '--\r\n'));
  return { body: Buffer.concat(chunks), ctype: 'multipart/form-data; boundary=' + boundary };
}
async function waitExamDone(username, pid, score) {
  for (let i = 0; i < 120; i++) {
    const r = await api('GET', '/api/admin/exam/results?examId=' + EXAM_ID, null, true);
    const row = (r.data.rows || []).find((x) => x.username === username);
    const cell = row && row.problems && row.problems[pid];
    if (row && cell && cell.score === score) return row;
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  return null;
}

const CODE_FULL = '#include <bits/stdc++.h>\nusing namespace std;\nint main(){int n;cin>>n;long long s=0;for(int i=0;i<n;i++){long long x;cin>>x;s+=x;}cout<<s<<endl;return 0;}';
const CODE_PARTIAL = '#include <bits/stdc++.h>\nusing namespace std;\nint main(){int n;cin>>n;vector<long long> v(n);long long s=0;for(int i=0;i<n;i++){cin>>v[i];s+=v[i];}if(n>3)cout<<42<<endl;else cout<<s<<endl;return 0;}';

let EXAM_ID = 0;
(async () => {
  console.log('BASE =', BASE);
  let r = await loginAs('admin', ADMIN_PW);
  check('admin 登录', r.status === 200 && r.data.user && r.data.user.role === 'superadmin', r.data);
  if (r.status !== 200) { console.log('无法登录 admin，终止'); process.exit(1); }

  // 1. 建题「离线求和」（2 点，50/50）+ 注册学生
  const mp = mpBody({ title: '离线求和', description: '# 离线求和\n第一行 n，第二行 n 个数，输出和。', hidden: '0' }, [
    { name: '1.in', content: '3\n1 2 3' }, { name: '1.out', content: '6' },
    { name: '2.in', content: '5\n10 20 30 40 50' }, { name: '2.out', content: '150' },
  ]);
  r = await api('POST', '/api/admin/problem', mp.body, true, { 'Content-Type': mp.ctype });
  check('创建离线求和题', r.status === 200 && r.data.id && r.data.testCount === 2, r.data);
  const PID = r.data.id;
  r = await api('POST', '/api/admin/problem/scoring', { problemId: PID, scoring: { mode: 'subtask', subtasks: [{ id: '1', score: 50, tests: ['1'], depends: [] }, { id: '2', score: 50, tests: ['2'], depends: [] }] } }, true);
  check('配置 50/50 子任务', r.status === 200, r.data);
  for (const un of ['offstu1', 'offstu2']) {
    await api('POST', '/api/auth/register', { username: un, fullname: '离线' + un, password: 'pass123' });
    const users = await api('GET', '/api/admin/users', null, true);
    const u = users.data.users.find((x) => x.username === un);
    await api('POST', '/api/admin/user/audit', { id: u.id, action: 'approve' }, true);
  }
  check('注册并审核 2 名学生', true);
  const now = Date.now();
  r = await api('POST', '/api/admin/exam', { name: '线下机房模考', problemIds: [PID], startAt: now - 2 * 86400000, endAt: now - 86400000, publishAt: now - 3600000, hideVerdict: true }, true);
  check('创建已公布模考', r.status === 200 && r.data.id, r.data);
  EXAM_ID = r.data.id;

  // 2. 构造「编号/题目名/题目名.cpp」zip
  const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'tgboj-offtest-'));
  const mk = (p) => fs.mkdirSync(path.join(tmpd, p), { recursive: true });
  mk('offstu1/离线求和'); mk('offstu2/离线求和'); mk('03/离线求和');
  fs.writeFileSync(path.join(tmpd, 'offstu1/离线求和/离线求和.cpp'), CODE_PARTIAL);
  fs.writeFileSync(path.join(tmpd, 'offstu2/离线求和/离线求和.cpp'), CODE_FULL);
  fs.writeFileSync(path.join(tmpd, '03/离线求和/离线求和.cpp'), CODE_FULL);
  const zipFile = path.join(tmpd, 'codes.zip');
  execFileSync('zip', ['-q', '-r', zipFile, 'offstu1', 'offstu2', '03'], { cwd: tmpd, stdio: 'pipe' });
  check('构造离线代码包 zip', fs.existsSync(zipFile));

  // 3. 解析预览
  const zmp = mpBody({ examId: String(EXAM_ID) }, [{ name: 'codes.zip', content: fs.readFileSync(zipFile) }]);
  r = await api('POST', '/api/admin/exam/import-zip', zmp.body, true, { 'Content-Type': zmp.ctype });
  check('解析 zip 成功（token）', r.status === 200 && !!r.data.token, r.data);
  const prev = r.data;
  const st1 = prev.students.find((s) => s.folder === 'offstu1');
  const st2 = prev.students.find((s) => s.folder === 'offstu2');
  const st3 = prev.students.find((s) => s.folder === '03');
  check('识别 3 个编号目录', prev.students.length === 3, prev.students.map((s) => s.folder));
  check('offstu1/offstu2 自动匹配账号', !!(st1 && st1.matched && st1.matched.username === 'offstu1' && st2 && st2.matched && st2.matched.username === 'offstu2'), { st1: st1 && st1.matched, st2: st2 && st2.matched });
  check('03 未匹配账号', !!(st3 && !st3.matched), st3 && st3.matched);
  check('题目名「离线求和」自动匹配模考题', !!(st1 && st1.problems[0].matchedPid === PID), st1 && st1.problems[0]);

  // 4. 确认导入（03 自动创建账号）
  const mapping = [
    { folder: 'offstu1', uid: st1.matched.uid, problems: [{ file: st1.problems[0].file, pid: PID, std: st1.problems[0].std }] },
    { folder: 'offstu2', uid: st2.matched.uid, problems: [{ file: st2.problems[0].file, pid: PID, std: st2.problems[0].std }] },
    { folder: '03', uid: 0, problems: [{ file: st3.problems[0].file, pid: PID, std: st3.problems[0].std }] },
  ];
  r = await api('POST', '/api/admin/exam/import-zip/apply', { token: prev.token, examId: EXAM_ID, createUsers: true, defaultPassword: 'offline123', students: mapping }, true);
  check('导入 3 份提交 + 创建 stu03 账号', r.status === 200 && r.data.created === 3 && r.data.createdUsers.length === 1, r.data);

  // 5. 等待评测 → 成绩表
  const row1 = await waitExamDone('offstu1', PID, 50);
  check('成绩表 offstu1 = 50（部分分）', !!row1, row1);
  const row2 = await waitExamDone('offstu2', PID, 100);
  check('成绩表 offstu2 = 100', !!row2, row2);
  const row3 = await waitExamDone('stu03', PID, 100);
  check('成绩表 stu03 = 100（自动创建账号）', !!row3, row3);

  // 6. 新账号可登录且模考页可见分数；学生可查看自己的代码
  r = await loginAs('stu03', 'offline123');
  check('stu03 用默认密码登录', r.status === 200, r.data);
  r = await api('GET', '/api/exam?id=' + EXAM_ID, null, true);
  check('stu03 模考页显示考试得分 100', !!(r.data.my && r.data.my[PID] && r.data.my[PID].examScore === 100), r.data.my);
  const codeR = await api('GET', '/api/code/' + row3.problems[PID].subId, null, true);
  check('stu03 可查看自己导入的代码', codeR.status === 200 && String(codeR.data).indexOf('#include') !== -1, codeR.status);

  // 7. 重复导入幂等（相同代码跳过）——先切回管理员
  await loginAs('admin', ADMIN_PW);
  r = await api('POST', '/api/admin/exam/import-zip/apply', { token: prev.token, examId: EXAM_ID, createUsers: true, defaultPassword: 'offline123', students: mapping }, true);
  check('重复导入：created=0 skipped=3', r.status === 200 && r.data.created === 0 && r.data.skipped === 3, r.data);

  console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAILED');
  try { fs.rmSync(tmpd, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(2); });
