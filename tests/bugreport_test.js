'use strict';
// e2e 测试：Bug 反馈功能（学生提交 → 管理员列表/计数/处理 → 限速与校验）
// 用法：node tests/bugreport_test.js [baseUrl] [adminPassword]
const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');
const ADMIN_PW = process.argv[3] || process.env.TGBOJ_ADMIN_PASSWORD;
if (!ADMIN_PW) { console.error('用法: node tests/bugreport_test.js [baseUrl] [adminPassword]（或设环境变量 TGBOJ_ADMIN_PASSWORD）'); process.exit(2); }
const RID = String(Date.now() % 1000000).padStart(6, '0');
const U1 = 'bug' + RID;
let fail = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra && !cond ? ' | ' + JSON.stringify(extra) : '')); if (!cond) fail++; };
let jar = null;
async function api(method, p, body, useCookie) {
  const headers = Object.assign({}, body ? { 'Content-Type': 'application/json' } : {}, useCookie && jar ? { Cookie: 'tgboj_token=' + jar } : {});
  const r = await fetch(BASE + p, { method, headers, body: body === undefined || body === null ? undefined : JSON.stringify(body) });
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
(async () => {
  let r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  check('管理员登录', r.status === 200, r.data);

  r = await api('POST', '/api/admin/user/save', { username: U1, fullname: '反馈学生', studentId: 'B' + RID, password: 'stu12345' }, true);
  check('创建学生', r.status === 200 && r.data.ok, r.data);

  // 匿名与权限
  jar = null;
  r = await api('POST', '/api/bugreport', { text: '匿名反馈' });
  check('匿名反馈 401', r.status === 401, r);

  // 学生登录
  r = await api('POST', '/api/auth/login', { username: U1, password: 'stu12345' });
  check('学生登录', r.status === 200, r.data);

  r = await api('POST', '/api/bugreport', { text: '   ' }, true);
  check('空内容 400', r.status === 400, r.data);

  r = await api('POST', '/api/bugreport', { text: 'x'.repeat(1001) }, true);
  check('超长内容 400', r.status === 400, r.data);

  r = await api('POST', '/api/bugreport', { text: '样例复制按钮没反应', page: '/problem.html?id=1' }, true);
  check('学生反馈 1', r.status === 200 && r.data.ok && r.data.id, r.data);
  const id1 = r.data.id;

  r = await api('POST', '/api/bugreport', { text: '排行榜期次切换无效' }, true);
  check('学生反馈 2', r.status === 200 && r.data.ok, r.data);

  r = await api('GET', '/api/admin/bugreports', null, true);
  check('学生查列表 403', r.status === 403, r);
  r = await api('GET', '/api/admin/bugreports/count', null, true);
  check('学生查计数 403', r.status === 403, r);
  r = await api('POST', '/api/admin/bugreport/resolve', { id: id1 }, true);
  check('学生处理反馈 403', r.status === 403, r);

  // 限速：10 分钟内第 3 条可以，第 4 条 429
  r = await api('POST', '/api/bugreport', { text: '第三条反馈' }, true);
  check('10分钟内第3条允许', r.status === 200, r.data);
  r = await api('POST', '/api/bugreport', { text: '第四条反馈' }, true);
  check('10分钟内第4条 429', r.status === 429, r.data);

  // 管理员端
  r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  check('管理员重新登录', r.status === 200, r.data);

  r = await api('GET', '/api/admin/bugreports', null, true);
  const mine = (r.data.list || []).filter((x) => x.username === U1);
  check('管理员列表含 3 条反馈', r.status === 200 && mine.length === 3, { count: mine.length });
  check('反馈含页面地址', mine.some((x) => x.page === '/problem.html?id=1'), mine);
  check('open 优先排序', r.data.list.every((x, i, a) => i === 0 || (a[i - 1].status === 'open' || x.status !== 'open') ), r.data.list && r.data.list.map((x) => x.status));

  r = await api('GET', '/api/admin/bugreports?status=open', null, true);
  check('status=open 过滤', r.status === 200 && (r.data.list || []).every((x) => x.status === 'open'), r.data);

  r = await api('GET', '/api/admin/bugreports/count', null, true);
  check('计数正确', r.status === 200 && r.data.openCount === mine.length, r.data);

  r = await api('POST', '/api/admin/bugreport/resolve', { id: id1 }, true);
  check('标记已处理', r.status === 200 && r.data.ok, r.data);

  r = await api('POST', '/api/admin/bugreport/resolve', { id: id1 }, true);
  check('重复处理 400', r.status === 400, r.data);

  r = await api('POST', '/api/admin/bugreport/resolve', { id: 999999 }, true);
  check('处理不存在 404', r.status === 404, r.data);

  r = await api('GET', '/api/admin/bugreports?status=done', null, true);
  const doneOne = (r.data.list || []).find((x) => x.id === id1);
  check('done 列表含处理记录', !!doneOne && doneOne.status === 'done' && !!doneOne.resolvedAt && doneOne.resolvedBy === 'admin', doneOne);

  console.log('\n' + (fail ? fail + ' 项失败' : '全部通过'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
