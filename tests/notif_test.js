'use strict';
// e2e 测试：未读反馈面板后端 —— 统一已读接口 + __global__ 公告不产生幻影未读
// 用法：node tests/notif_test.js [baseUrl] [adminPassword]
const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');
const ADMIN_PW = process.argv[3] || process.env.TGBOJ_ADMIN_PASSWORD;
if (!ADMIN_PW) { console.error('用法: node tests/notif_test.js [baseUrl] [adminPassword]（或设环境变量 TGBOJ_ADMIN_PASSWORD）'); process.exit(2); }
const RID = String(Date.now() % 1000000).padStart(6, '0');
const U1 = 'notif' + RID;
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
(async () => {
  let r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  check('管理员登录', r.status === 200, r.data);

  // 学生 + 作业 + 题目
  r = await api('POST', '/api/admin/user/save', { username: U1, fullname: '通知学生', studentId: 'N' + RID, password: 'stu12345' }, true);
  check('创建学生', r.status === 200 && r.data.ok, r.data);
  r = await api('GET', '/api/admin/users', null, true);
  const stu = (r.data.list || r.data.users || []).find((u) => u.username === U1);
  check('查到学生 uid', !!stu && stu.id > 0, r.data);
  const UID = stu && stu.id;

  r = await api('POST', '/api/admin/homework', { title: '通知测试作业' + RID, questions: ['1+1=?'] }, true);
  check('创建作业', r.status === 200 && r.data.id, r.data);
  const HWID = r.data.id;

  const desc = '# 通知测试题\n\nA+B。\n\n## 输入格式\n\n两个整数。\n\n## 输出格式\n\n一个整数。';
  const mk = (name, content) => ({ name, content });
  const mp = mpBody({ title: '通知测试题' + RID, description: desc, hidden: '0' }, [mk('1.in', '1 2\n'), mk('1.out', '3\n')]);
  r = await api('POST', '/api/admin/problem', mp.body, true, { 'Content-Type': mp.ctype });
  check('创建题目', r.status === 200 && r.data.id, r.data);
  const PID = r.data.id;

  // 学生作答
  r = await api('POST', '/api/auth/login', { username: U1, password: 'stu12345' });
  check('学生登录', r.status === 200, r.data);
  r = await api('POST', '/api/homework/answer', { homeworkId: HWID, answers: ['2'] }, true);
  check('学生作答', r.status === 200 && r.data.ok, r.data);
  // 清零历史未读，保证断言只针对本轮数据（测试可重复跑）
  await api('POST', '/api/notifications/read', { all: true }, true);
  r = await api('GET', '/api/notifications/unread', null, true);
  check('初始无未读', r.status === 200 && r.data.count === 0, r.data);
  const mineOf = (d) => (d.items || []).filter((x) => (x.type === 'hw' && x.homeworkId === HWID) || (x.type === 'problem' && x.problemId === PID));

  // 管理员评语 → 学生出现 hw 未读
  r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  r = await api('POST', '/api/admin/homework/comment', { homeworkId: HWID, uid: UID, comment: '做得很好' }, true);
  check('管理员写评语', r.status === 200 && r.data.ok, r.data);
  // 管理员发题目通知
  r = await api('POST', '/api/admin/problem/notify', { problemId: PID, text: '数据已更新，请查看' }, true);
  check('管理员发题目通知', r.status === 200 && r.data.ok, r.data);
  // 全站公告（__global__）不应产生幻影未读
  r = await api('POST', '/api/admin/notice', { text: '全局公告测试' + RID }, true);
  check('设置全站公告', r.status === 200, r.data);

  r = await api('POST', '/api/auth/login', { username: U1, password: 'stu12345' });
  r = await api('GET', '/api/notifications/unread', null, true);
  check('未读=2（hw+problem）', r.status === 200 && mineOf(r.data).length === 2, r.data);
  const types = mineOf(r.data).map((x) => x.type).sort();
  check('类型为 hw+problem', types.join(',') === 'hw,problem', r.data.items);
  check('公告不产生幻影 problem 项', !(r.data.items || []).some((x) => x.type === 'problem' && !Number.isInteger(x.problemId)), r.data.items);

  // 参数校验
  r = await api('POST', '/api/notifications/read', {}, true);
  check('空参数 400', r.status === 400, r.data);
  r = await api('POST', '/api/notifications/read', { type: 'hw' }, true);
  check('缺 homeworkId 400', r.status === 400, r.data);

  // 单条消除：hw
  r = await api('POST', '/api/notifications/read', { type: 'hw', homeworkId: HWID }, true);
  check('标记 hw 已读', r.status === 200 && r.data.ok, r.data);
  r = await api('GET', '/api/notifications/unread', null, true);
  check('未读=1（仅剩 problem）', r.status === 200 && mineOf(r.data).length === 1 && mineOf(r.data)[0].type === 'problem', r.data);

  // 单条消除：problem
  r = await api('POST', '/api/notifications/read', { type: 'problem', problemId: PID }, true);
  check('标记 problem 已读', r.status === 200 && r.data.ok, r.data);
  r = await api('GET', '/api/notifications/unread', null, true);
  check('未读=0', r.status === 200 && mineOf(r.data).length === 0, r.data);

  // 再次制造未读 → 全部已读
  r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  await api('POST', '/api/admin/homework/comment', { homeworkId: HWID, uid: UID, comment: '再评一次' }, true);
  await api('POST', '/api/admin/problem/notify', { problemId: PID, text: '再次更新' }, true);
  r = await api('POST', '/api/auth/login', { username: U1, password: 'stu12345' });
  r = await api('GET', '/api/notifications/unread', null, true);
  check('重新出现 2 条未读', r.status === 200 && mineOf(r.data).length === 2, r.data);
  r = await api('POST', '/api/notifications/read', { all: true }, true);
  check('全部已读', r.status === 200 && r.data.ok, r.data);
  r = await api('GET', '/api/notifications/unread', null, true);
  check('全部已读后未读=0', r.status === 200 && r.data.count === 0 && mineOf(r.data).length === 0, r.data);

  // 匿名
  jar = null;
  r = await api('POST', '/api/notifications/read', { all: true });
  check('匿名标记已读 401', r.status === 401, r);

  // 清理全站公告
  r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  r = await api('POST', '/api/admin/notice', { text: '' }, true);
  check('清理全站公告', r.status === 200, r.data);

  console.log('\n' + (fail ? fail + ' 项失败' : '全部通过'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
