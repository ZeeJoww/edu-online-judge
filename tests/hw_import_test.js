'use strict';
// e2e 测试：作业期次离线 OI 代码导入（考生编号/题名/题名.cpp，编号如 GD-S00186）
// 用法：node tests/hw_import_test.js [baseUrl] [adminPassword]
// 幂等：每次运行使用唯一 runId 后缀（题目名/编号），可在同一实例重复执行
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const BASE = (process.argv[2] || 'http://localhost:8090').replace(/\/$/, '');
const ADMIN_PW = process.argv[3] || process.env.TGBOJ_ADMIN_PASSWORD || '';
const RID = String(Date.now() % 1000000).padStart(6, '0');
const TITLE = '作业导入题' + RID;
const NO1 = 'GD-S' + RID.slice(0, 2) + RID.slice(2);  // GD-Sxxxxxx 风格编号
const NO2 = 'GD-S' + String((parseInt(RID, 10) + 1)).padStart(6, '0');
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
  return { ctype: 'multipart/form-data; boundary=' + boundary, body: Buffer.concat(chunks) };
}
async function waitSub(id, tries) {
  for (let i = 0; i < (tries || 80); i++) {
    const d = await api('GET', '/api/submission/' + id, null, true);
    if (d.data && d.data.status === 'done') return d.data;
    await new Promise((res) => setTimeout(res, 500));
  }
  return null;
}
(async () => {
  let r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  check('管理员登录', r.status === 200, r.data);

  // 建题 + 配置当前期编程作业
  const mk = (name, content) => ({ name, content });
  const desc = '# ' + TITLE + '\n\n输入两个数 a b，输出 a+b。';
  const mp = mpBody({ title: TITLE, description: desc, hidden: '0' }, [mk('1.in', '1 2\n'), mk('1.out', '3\n'), mk('2.in', '4 5\n'), mk('2.out', '9\n')]);
  r = await api('POST', '/api/admin/problem', mp.body, true, { 'Content-Type': mp.ctype });
  check('创建测试题', r.status === 200 && r.data.id, r.data);
  const PID = r.data.id;
  r = await api('POST', '/api/admin/homework/programming-order', { order: [PID] }, true);
  check('配置当前期编程作业', r.status === 200, r.data);

  // 构造「编号/题名/题名.cpp」zip（两个编号：GD-S 风格）
  const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'hwimp-'));
  const AC = '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ long long a,b; cin>>a>>b; cout<<a+b<<endl; }';
  const WA = '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ long long a,b; cin>>a>>b; if(a==1&&b==2) cout<<3; else cout<<0; }';
  for (const [no, code] of [[NO1, AC], [NO2, WA]]) {
    const dir = path.join(tmpd, no, TITLE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, TITLE + '.cpp'), code);
  }
  const zipFile = path.join(tmpd, 'hw.zip');
  execFileSync('zip', ['-q', '-r', zipFile, NO1, NO2], { cwd: tmpd, stdio: 'pipe' });

  // 第一步：解析预览
  const pkg = mpBody({ session: '0' }, [mk('hw.zip', fs.readFileSync(zipFile))]);
  r = await api('POST', '/api/admin/homework/import-zip', pkg.body, true, { 'Content-Type': pkg.ctype });
  check('解析压缩包', r.status === 200 && r.data.token, r.data);
  const PRE = r.data;
  check('预览：2 个编号', PRE.students.length === 2, PRE.students);
  check('预览：编号未匹配=2（无账号）', PRE.unmatchedStudents === 2, PRE);
  check('预览：题目自动匹配', PRE.students.every((s) => s.problems.every((p) => p.matchedPid === PID)), PRE.students);
  check('预览：期次题目列表含本题', PRE.sesProblems.some((p) => p.id === PID), PRE.sesProblems);

  // 第二步：导入（自动创建账号）
  const stItems = PRE.students.map((s) => ({ folder: s.folder, uid: 0, problems: s.problems.map((p) => ({ file: p.file, pid: p.matchedPid, std: p.std })) }));
  r = await api('POST', '/api/admin/homework/import-zip/apply', { token: PRE.token, session: 0, students: stItems, createUsers: true, defaultPassword: 'stu12345' }, true);
  check('导入 created=2', r.status === 200 && r.data.created === 2, r.data);
  check('自动创建 2 个账号', (r.data.createdUsers || []).length === 2, r.data);

  // 账号校验：编号写入 studentId，用户名为编号清理后的合法名
  const users = await api('GET', '/api/admin/users', null, true);
  const u1 = users.data.users.find((u) => u.studentId === NO1);
  const u2 = users.data.users.find((u) => u.studentId === NO2);
  check('账号1 studentId=' + NO1, !!u1, u1);
  check('账号2 studentId=' + NO2, !!u2, u2);
  check('用户名合法（字母开头，无连字符）', !!u1 && /^[a-z][a-z0-9_]{1,15}$/.test(u1.username), u1 && u1.username);
  r = await api('POST', '/api/auth/login', { username: u1.username, password: 'stu12345' });
  check('导入账号可登录', r.status === 200, r.data);

  // 等待评测完成，验证成绩
  let st = await api('GET', '/api/status?problem=' + PID, null, true);
  let done = false;
  for (let i = 0; i < 40 && !done; i++) {
    await new Promise((res) => setTimeout(res, 500));
    st = await api('GET', '/api/status?problem=' + PID, null, true);
    const list = st.data.list || [];
    done = list.length >= 2 && list.every((s) => s.status !== 'judging' && s.status !== 'queued');
  }
  const finals = (st.data.list || []).filter((s) => s.imported); // M-10 后学生视角不再返回 ip，改用 imported 标记
  check('评测完成（2 条离线导入）', finals.length >= 2, finals);
  const byNo = {};
  for (const s of finals) { if (!byNo[s.username]) byNo[s.username] = s; }
  check('AC 学生 100 分', byNo[u1.username] && byNo[u1.username].summary && byNo[u1.username].summary.verdict === 'AC' && (byNo[u1.username].score === 100), byNo[u1.username]);
  check('WA 学生 50 分（1/2 点）', byNo[u2.username] && (byNo[u2.username].score === 50 || (byNo[u2.username].summary && byNo[u2.username].summary.ac === 1)), byNo[u2.username]);
  check('导入提交带 hwSession=0', finals.every((s) => s.hwSession === 0), finals);

  // 导入代码：所有登录用户无限制互看（当前 jar 为 u1）
  const otherSub = byNo[u2.username];
  r = await api('GET', '/api/code/' + otherSub.id, null, true);
  check('学生互看导入代码(200)', r.status === 200 && /#include/.test(String(r.data)), String(r.data).slice(0, 60));
  // 非导入提交仍按原规则：u1 正常提交一份（AC），u2 无 AC → 仍 403
  let sub = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: AC }, true);
  await waitSub(sub.data.id);
  r = await api('POST', '/api/auth/login', { username: u2.username, password: 'stu12345' });
  check('切到 u2', r.status === 200, r.data);
  r = await api('GET', '/api/code/' + sub.data.id, null, true);
  check('非导入提交他人无AC仍403', r.status === 403, r.data);
  r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });

  // 重复导入幂等（切回管理员）
  r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  check('切回管理员', r.status === 200, r.data);
  const pkg2 = mpBody({ session: '0' }, [mk('hw.zip', fs.readFileSync(zipFile))]);
  r = await api('POST', '/api/admin/homework/import-zip', pkg2.body, true, { 'Content-Type': pkg2.ctype });
  if (r.status !== 200 || !r.data || !r.data.students) { console.log('DEBUG second parse:', r.status, JSON.stringify(r.data).slice(0, 200)); }
  const PRE2 = r.data;
  const stItems2 = PRE2.students.map((s) => ({ folder: s.folder, uid: s.matched ? s.matched.uid : 0, problems: s.problems.map((p) => ({ file: p.file, pid: p.matchedPid, std: p.std })) }));
  r = await api('POST', '/api/admin/homework/import-zip/apply', { token: PRE2.token, session: 0, students: stItems2, createUsers: false, defaultPassword: '' }, true);
  check('重复导入 created=0 skipped=2', r.status === 200 && r.data.created === 0 && r.data.skipped === 2, r.data);

  // 不存在的期次 → 404
  const pkg3 = mpBody({ session: '9' }, [mk('hw.zip', fs.readFileSync(zipFile))]);
  r = await api('POST', '/api/admin/homework/import-zip', pkg3.body, true, { 'Content-Type': pkg3.ctype });
  check('不存在的期次返回 404', r.status === 404 && /期次不存在/.test(r.data.error || ''), r.data);

  fs.rmSync(tmpd, { recursive: true, force: true });
  console.log(fail ? ('FAIL: ' + fail) : 'ALL PASS');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });