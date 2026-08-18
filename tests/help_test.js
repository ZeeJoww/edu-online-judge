'use strict';
// e2e 测试：代码求助功能（当前期次提交 → 学生请求 → 教师列表/公屏展示 → 已处理移除）
// 用法：node tests/help_test.js [baseUrl] [adminPassword]
const BASE = (process.argv[2] || 'http://localhost:8090').replace(/\/$/, '');
const ADMIN_PW = process.argv[3] || process.env.TGBOJ_ADMIN_PASSWORD;
if (!ADMIN_PW) { console.error('用法: node tests/help_test.js [baseUrl] [adminPassword]（或设环境变量 TGBOJ_ADMIN_PASSWORD）'); process.exit(2); }
const RID = String(Date.now() % 1000000).padStart(6, '0');
const U1 = 'help1' + RID;
const U2 = 'help2' + RID;
let fail = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra && !cond ? ' | ' + JSON.stringify(extra) : '')); if (!cond) fail++; };
let jar = null;
async function api(method, p, body, useCookie, rawHeaders) {
  const headers = Object.assign({}, body && !rawHeaders ? { 'Content-Type': 'application/json' } : {}, useCookie && jar ? { Cookie: 'tgboj_token=' + jar } : {}, rawHeaders || {});
  const r = await fetch(BASE + p, { method, headers, body: body === undefined || body === null ? undefined : (rawHeaders ? body : JSON.stringify(body)) });
  if (method === 'POST' && p === '/api/auth/login') {
    const sc = r.headers.get('set-cookie') || '';
    const m = /tgboj_token=([^;]+)/.exec(sc);
    if (m) jar = m[1];
  }
  const txt = await r.text();
  let data;
  try { data = JSON.parse(txt); } catch (e) { data = txt; }
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
async function waitSub(id) {
  for (let i = 0; i < 100; i++) {
    const d = await api('GET', '/api/submission/' + id, null, true);
    if (d.data && d.data.status === 'done') return d.data;
    await new Promise((res) => setTimeout(res, 300));
  }
  return null;
}
(async () => {
  let r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  check('管理员登录', r.status === 200, r.data);

  // 创建测试题并设为当前期次编程题
  const desc = '# 求助功能测试题\n\n输入两个整数，输出它们的和。\n\n## 输入格式\n\n两个整数。\n\n## 输出格式\n\n一个整数。';
  const mk = (name, content) => ({ name, content });
  const mp = mpBody({ title: '求助功能测试题', description: desc, hidden: '0' }, [
    mk('1.in', '1 2\n'), mk('1.out', '3\n'), mk('2.in', '4 5\n'), mk('2.out', '9\n'),
  ]);
  r = await api('POST', '/api/admin/problem', mp.body, true, { 'Content-Type': mp.ctype });
  check('创建测试题', r.status === 200 && r.data.id, r.data);
  const PID = r.data.id;
  r = await api('POST', '/api/admin/homework/programming-order', { order: [PID] }, true);
  check('设为当前期次编程题', r.status === 200, r.data);

  // 两名学生账号
  r = await api('POST', '/api/admin/user/save', { username: U1, fullname: '求助学生一', studentId: 'H1' + RID, password: 'stu12345' }, true);
  check('创建学生1', r.status === 200 && r.data.ok, r.data);
  r = await api('POST', '/api/admin/user/save', { username: U2, fullname: '求助学生二', studentId: 'H2' + RID, password: 'stu12345' }, true);
  check('创建学生2', r.status === 200 && r.data.ok, r.data);

  r = await api('POST', '/api/auth/login', { username: U1, password: 'stu12345' });
  check('学生1登录', r.status === 200, r.data);
  const code = '#include <bits/stdc++.h>\nusing namespace std;\nint main(){int a,b;cin>>a>>b;cout<<a+b<<endl;}';
  r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code }, true);
  check('学生1提交', r.status === 200 && r.data.id, r.data);
  const subId = r.data.id;
  const sub = await waitSub(subId);
  check('评测完成', !!sub && sub.status === 'done', sub);
  check('提交详情返回 canHelp', sub && sub.canHelp === true && sub.help === null, sub && { canHelp: sub.canHelp, help: sub.help });

  r = await api('POST', '/api/help/request', { submissionId: subId }, true);
  const helpReqId = r.data && r.data.id;
  check('学生发起求助', r.status === 200 && r.data.ok, r.data);
  r = await api('POST', '/api/help/request', { submissionId: subId }, true);
  check('重复求助被拒绝', r.status === 400, r.data);
  r = await api('GET', '/api/submission/' + subId, null, true);
  check('详情显示求助中', r.data && r.data.help && r.data.help.status === 'open' && r.data.canHelp === false, r.data);

  // 学生2不能替学生1求助
  r = await api('POST', '/api/auth/login', { username: U2, password: 'stu12345' });
  check('学生2登录', r.status === 200, r.data);
  r = await api('POST', '/api/help/request', { submissionId: subId }, true);
  check('替他人求助被拒绝', r.status === 403, r.data);

  // 教师端查看与处理
  r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  check('管理员重新登录', r.status === 200, r.data);
  r = await api('GET', '/api/help', null, true);
  const open = (r.data.list || []).find((x) => x.submissionId === subId && x.status === 'open');
  check('管理端看到求助', r.status === 200 && !!open, r.data);
  r = await api('GET', '/api/help/count', null, true);
  check('红点计数显示未处理', r.status === 200 && r.data.openCount >= 1, r.data);
  r = await api('GET', '/api/board', null, true);
  const bOpen = (r.data.helpRequests || []).find((x) => x.submissionId === subId);
  check('公屏携带求助代码', !!bOpen && typeof bOpen.code === 'string' && bOpen.code.includes('a+b'), bOpen && bOpen.code && bOpen.code.slice(0, 60));
  r = await api('POST', '/api/admin/help/resolve', { id: helpReqId }, true);
  check('标记已处理', r.status === 200 && r.data.ok, r.data);
  r = await api('GET', '/api/board', null, true);
  check('公屏已移除该求助', !(r.data.helpRequests || []).some((x) => x.submissionId === subId), r.data.helpRequests);
  r = await api('GET', '/api/help/count', null, true);
  check('处理后红点计数归零', r.status === 200 && r.data.openCount === 0, r.data);
  r = await api('GET', '/api/help?status=done', null, true);
  const done = (r.data.list || []).find((x) => x.submissionId === subId && x.status === 'done');
  check('管理端已处理列表', !!done && !!done.resolvedAt, r.data);

  console.log(fail ? 'FAILURES: ' + fail : 'ALL PASS');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });