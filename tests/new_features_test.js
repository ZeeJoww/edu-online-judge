'use strict';
// e2e 测试：用户管理 API + 批量建号 + 题目标签 + 我的错题本 + 大输出流式比对
// 用法：node tests/new_features_test.js [baseUrl] [adminPassword]
// 幂等：每次运行使用唯一 runId 后缀，可在同一实例重复执行
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const BASE = (process.argv[2] || 'http://localhost:8090').replace(/\/$/, '');
const ADMIN_PW = process.argv[3] || process.env.TGBOJ_ADMIN_PASSWORD || '';
const RID = String(Date.now() % 1000000).padStart(6, '0');
const U1 = 'u1' + RID;          // 单个用户管理对象
const B1 = 'batch1' + RID;      // 批量-1
const B2 = 'batch2' + RID;      // 批量-2
const SID1 = '91' + RID, SID2 = '92' + RID, SID3 = '93' + RID;
const SID4 = '94' + RID, SID5 = '95' + RID, SID6 = '96' + RID; // 批量段专用，避免与单用户段碰撞
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

  // —— 用户管理 ——
  r = await api('POST', '/api/admin/user/save', { username: U1, fullname: '测试用户甲', studentId: SID1, password: 'pass1234' }, true);
  check('新增用户(带编号)', r.status === 200 && r.data.ok, r.data);
  const UID = r.data.user.id;
  let users = await api('GET', '/api/admin/users', null, true);
  const u1 = users.data.users.find((x) => x.id === UID);
  check('用户列表含编号字段', !!u1 && u1.studentId === SID1, u1);
  r = await api('POST', '/api/admin/user/save', { id: UID, username: U1, fullname: '甲改名', studentId: SID2, password: '' }, true);
  check('更新用户编号/姓名', r.status === 200, r.data);
  users = await api('GET', '/api/admin/users', null, true);
  check('更新后编号=' + SID2, users.data.users.find((x) => x.id === UID).studentId === SID2);
  r = await api('POST', '/api/admin/user/password', { id: UID, password: 'newpass123' }, true);
  check('管理员重置密码', r.status === 200 && r.data.ok, r.data);
  let lr = await api('POST', '/api/auth/login', { username: U1, password: 'pass1234' });
  check('旧密码登录失败', lr.status === 400, lr.data);
  lr = await api('POST', '/api/auth/login', { username: U1, password: 'newpass123' });
  check('新密码登录成功', lr.status === 200, lr.data);

  // 批量建号（重新以管理员身份）
  r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  check('重新登录管理员', r.status === 200, r.data);
  r = await api('POST', '/api/admin/users/batch', { defaultPassword: 'batch123', users: [
    { studentId: SID4, fullname: '批量一', username: B1 },
    { studentId: SID4, fullname: '编号重复', username: B1 + 'x' },
    { studentId: SID5, fullname: '批量二', username: B2, password: 'custom123' },
    { studentId: SID6, fullname: '缺用户名' },
  ] }, true);
  check('批量建号 created=2', r.status === 200 && r.data.created === 2, r.data);
  check('批量建号 skipped=2', r.data.skipped === 2, r.data.results);
  lr = await api('POST', '/api/auth/login', { username: B2, password: 'custom123' });
  check('批量用户(行内密码)登录', lr.status === 200, lr.data);
  lr = await api('POST', '/api/auth/login', { username: B1, password: 'batch123' });
  check('批量用户(默认密码)登录', lr.status === 200, lr.data);

  // —— 题目标签 ——
  r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  const mk = (name, content) => ({ name, content });
  const desc = '# 新功能测试题\n\n输入两个数 a b，输出 a+b。\n\n## 输入格式\n\n两个整数。\n\n## 输出格式\n\n一个整数。';
  const mp = mpBody({ title: '新功能测试题', description: desc, hidden: '0' }, [mk('1.in', '1 2\n'), mk('1.out', '3\n'), mk('2.in', '4 5\n'), mk('2.out', '9\n')]);
  r = await api('POST', '/api/admin/problem', mp.body, true, { 'Content-Type': mp.ctype });
  check('创建测试题', r.status === 200 && r.data.id, r.data);
  const PID = r.data.id;
  r = await api('POST', '/api/admin/problem/edit', { problemId: PID, tags: '哈希 线段树' }, true);
  check('设置标签', r.status === 200, r.data);
  let pl = await api('GET', '/api/problems', null, true);
  const pp = pl.data.problems.find((x) => x.id === PID);
  check('列表返回标签', !!pp && (pp.tags || []).join(',') === '哈希,线段树', pp);
  const pd = await api('GET', '/api/problem?id=' + PID, null, true);
  check('题目详情返回标签', (pd.data.tags || []).join(',') === '哈希,线段树', pd.data.tags);

  // —— 我的错题本（B2 账号）——
  r = await api('POST', '/api/auth/login', { username: B2, password: 'custom123' });
  check('切回 ' + B2, r.status === 200, r.data);
  const WA_CODE = '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ int a,b; cin>>a>>b; if(a==1&&b==2) cout<<3; else cout<<0; }';
  const AC_CODE = '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ int a,b; cin>>a>>b; cout<<a+b<<endl; }';
  let sub = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: WA_CODE }, true);
  await waitSub(sub.data.id);
  let my = await api('GET', '/api/myproblems', null, true);
  let mp0 = my.data.problems.find((x) => x.id === PID);
  check('错题本收录(未AC, 部分分50)', !!mp0 && mp0.ac === false && mp0.bestScore === 50 && mp0.tries === 1, mp0);
  sub = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: AC_CODE }, true);
  await waitSub(sub.data.id);
  my = await api('GET', '/api/myproblems', null, true);
  mp0 = my.data.problems.find((x) => x.id === PID);
  check('错题本最高分=100 归入已解决', !!mp0 && mp0.ac === true && mp0.bestScore === 100 && mp0.tries === 2, mp0);
  check('未提交的题不在错题本', my.data.problems.every((x) => x.id !== PID + 1));

  // —— 大输出流式比对（14MB 级输出）——
  r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  check('切回管理员', r.status === 200, r.data);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bigout-'));
  const n = 2000000;
  fs.writeFileSync(path.join(tmp, 'big.cpp'), '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ int n; cin>>n; for(int i=0;i<n;i++) cout<<i<<"\\n"; }');
  execFileSync('g++', ['-O2', '-o', path.join(tmp, 'big'), path.join(tmp, 'big.cpp')]);
  fs.writeFileSync(path.join(tmp, '1.in'), n + '\n');
  const gen = execFileSync(path.join(tmp, 'big'), { input: n + '\n', maxBuffer: 512 * 1024 * 1024 });
  fs.writeFileSync(path.join(tmp, '1.out'), gen);
  const outBytes = fs.statSync(path.join(tmp, '1.out')).size;
  console.log('  大输出测试点大小: ' + Math.round(outBytes / 1024 / 1024) + 'MB');
  const mp2 = mpBody({ title: '大输出流式比对题', description: '# 大输出\n\n输入 n，输出 0..n-1 每行一个。', hidden: '0' }, [mk('1.in', fs.readFileSync(path.join(tmp, '1.in'))), mk('1.out', fs.readFileSync(path.join(tmp, '1.out')))]);
  r = await api('POST', '/api/admin/problem', mp2.body, true, { 'Content-Type': mp2.ctype });
  check('创建大输出题', r.status === 200 && r.data.id, r.data);
  const BIG = r.data.id;
  const BIG_AC = '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ int n; cin>>n; for(int i=0;i<n;i++) cout<<i<<"\\n"; }';
  sub = await api('POST', '/api/submit', { problemId: BIG, std: 'c++17', code: BIG_AC }, true);
  let bigSub = await waitSub(sub.data.id, 120);
  check('大输出 AC（流式比对）', !!bigSub && bigSub.summary && bigSub.summary.verdict === 'AC', bigSub && bigSub.summary);
  const BIG_WA = '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ int n; cin>>n; for(int i=0;i<n-1;i++) cout<<i<<"\\n"; }';
  sub = await api('POST', '/api/submit', { problemId: BIG, std: 'c++17', code: BIG_WA }, true);
  bigSub = await waitSub(sub.data.id, 120);
  check('大输出少一行 → WA', !!bigSub && bigSub.summary && bigSub.summary.verdict === 'WA', bigSub && bigSub.summary);
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(fail ? ('FAIL: ' + fail) : 'ALL PASS');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });