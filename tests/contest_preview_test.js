'use strict';
// e2e 测试：比赛赛前预览（普通用户不可见题目集，管理员可预览当前期编程题）
// 用法：node tests/contest_preview_test.js [baseUrl] [adminPassword]
const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');
const ADMIN_PW = process.argv[3] || process.env.TGBOJ_ADMIN_PASSWORD;
if (!ADMIN_PW) { console.error('用法: node tests/contest_preview_test.js [baseUrl] [adminPassword]'); process.exit(2); }
const RID = String(Date.now() % 1000000).padStart(6, '0');
const U1 = 'cpv' + RID;
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
  for (const [name, value] of Object.entries(fields)) chunks.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n'));
  for (const f of files) {
    chunks.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="data"; filename="' + f.name + '"\r\nContent-Type: application/octet-stream\r\n\r\n'));
    chunks.push(Buffer.from(f.content));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from('--' + boundary + '--\r\n'));
  return { ctype: 'multipart/form-data; boundary=' + boundary, body: Buffer.concat(chunks) };
}
(async () => {
  let r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  check('管理员登录', r.status === 200, r.data);

  // 两道题（一公开一隐藏）设为当前期编程题
  const desc = '# 预览测试题\n\nA+B。\n\n## 输入格式\n\n两个整数。\n\n## 输出格式\n\n一个整数。';
  const mk = (name, content) => ({ name, content });
  let mp = mpBody({ title: '预览公开题' + RID, description: desc, hidden: '0' }, [mk('1.in', '1 2\n'), mk('1.out', '3\n')]);
  r = await api('POST', '/api/admin/problem', mp.body, true, { 'Content-Type': mp.ctype });
  check('创建公开题', r.status === 200 && r.data.id, r.data);
  const P1 = r.data.id;
  mp = mpBody({ title: '预览隐藏题' + RID, description: desc, hidden: '1' }, [mk('1.in', '1 2\n'), mk('1.out', '3\n')]);
  r = await api('POST', '/api/admin/problem', mp.body, true, { 'Content-Type': mp.ctype });
  check('创建隐藏题', r.status === 200 && r.data.id, r.data);
  const P2 = r.data.id;
  r = await api('POST', '/api/admin/homework/programming-order', { order: [P1, P2] }, true);
  check('设为当前期编程题', r.status === 200, r.data);

  // 比赛：1 小时后开始（upcoming）
  const start = Date.now() + 3600 * 1000;
  const end = start + 7200 * 1000;
  r = await api('POST', '/api/admin/contest', { title: '预览测试赛' + RID, startAt: start, endAt: end, mode: 'ioi' }, true);
  check('设置未来比赛', r.status === 200 && r.data.ok, r.data);

  // 管理员：可预览题目集
  r = await api('GET', '/api/contest/rank', null, true);
  check('管理员 upcoming', r.status === 200 && r.data.status === 'upcoming', r.data.status);
  check('管理员 preview=true', r.data.preview === true, r.data);
  check('预览题目=当前期 2 题且有序', Array.isArray(r.data.problems) && r.data.problems.length === 2 && r.data.problems[0].id === P1 && r.data.problems[1].id === P2, r.data.problems);
  check('隐藏题带标注', r.data.problems && r.data.problems[1].hidden === true && r.data.problems[0].hidden === false, r.data.problems);
  check('预览无榜单行', Array.isArray(r.data.rows) && r.data.rows.length === 0, r.data.rows);

  // 学生：不可预览（空题目集、无 preview 标记）
  r = await api('POST', '/api/admin/user/save', { username: U1, fullname: '预览学生', studentId: 'CP' + RID, password: 'stu12345' }, true);
  r = await api('POST', '/api/auth/login', { username: U1, password: 'stu12345' });
  check('学生登录', r.status === 200, r.data);
  r = await api('GET', '/api/contest/rank', null, true);
  check('学生 upcoming 无预览', r.status === 200 && r.data.status === 'upcoming' && !r.data.preview, r.data);
  check('学生题目集为空', Array.isArray(r.data.problems) && r.data.problems.length === 0, r.data.problems);

  // 比赛开始后：恢复正常逻辑（无 preview 标记）
  r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  r = await api('POST', '/api/admin/contest', { startAt: Date.now() - 1000, endAt: end }, true);
  check('改为进行中', r.status === 200 && r.data.ok, r.data);
  r = await api('GET', '/api/contest/rank', null, true);
  check('进行中无 preview 标记', r.status === 200 && r.data.status === 'running' && !r.data.preview, r.data);

  // 清理比赛
  r = await api('POST', '/api/admin/contest', { clear: true }, true);
  check('清除比赛', r.status === 200 && r.data.ok, r.data);
  r = await api('GET', '/api/contest/rank', null, true);
  check('清除后 status=none', r.status === 200 && r.data.status === 'none', r.data.status);

  console.log('\n' + (fail ? fail + ' 项失败' : '全部通过'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
