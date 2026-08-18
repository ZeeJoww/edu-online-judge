'use strict';
// e2e 测试：教师私信 —— 发送/接收/未读整合/已读/权限
// 用法：node tests/msg_test.js [baseUrl] [adminPassword]
const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');
const ADMIN_PW = process.argv[3] || process.env.TGBOJ_ADMIN_PASSWORD;
if (!ADMIN_PW) { console.error('用法: node tests/msg_test.js [baseUrl] [adminPassword]（或设环境变量 TGBOJ_ADMIN_PASSWORD）'); process.exit(2); }
const RID = String(Date.now() % 1000000).padStart(6, '0');
const U1 = 'msg1' + RID;
const U2 = 'msg2' + RID;
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

  r = await api('POST', '/api/admin/user/save', { username: U1, fullname: '私信学生一', studentId: 'M1' + RID, password: 'stu12345' }, true);
  check('创建学生1', r.status === 200 && r.data.ok, r.data);
  r = await api('POST', '/api/admin/user/save', { username: U2, fullname: '私信学生二', studentId: 'M2' + RID, password: 'stu12345' }, true);
  check('创建学生2', r.status === 200 && r.data.ok, r.data);
  r = await api('GET', '/api/admin/users', null, true);
  const users = r.data.users || r.data.list || [];
  const s1 = users.find((u) => u.username === U1);
  const s2 = users.find((u) => u.username === U2);
  const adminU = users.find((u) => u.username === 'admin');
  check('查到 uid', !!s1 && !!s2 && !!adminU, users.length);

  // 参数与权限校验
  r = await api('POST', '/api/admin/message', { toUid: 999999, text: 'hi' }, true);
  check('收件人不存在 404', r.status === 404, r.data);
  r = await api('POST', '/api/admin/message', { toUid: s1.id, text: '   ' }, true);
  check('空内容 400', r.status === 400, r.data);
  r = await api('POST', '/api/admin/message', { toUid: s1.id, text: 'x'.repeat(2001) }, true);
  check('超长内容 400', r.status === 400, r.data);
  r = await api('POST', '/api/admin/message', { toUid: adminU.id, text: 'hi' }, true);
  check('发给管理员 400', r.status === 400, r.data);

  // 发送两条给学生1
  r = await api('POST', '/api/admin/message', { toUid: s1.id, text: '你的提交 #1234 有边界错误，参考 https://example.com/sol' }, true);
  check('发送消息1', r.status === 200 && r.data.ok && r.data.id, r.data);
  const mid1 = r.data.id;
  r = await api('POST', '/api/admin/message', { toUid: s1.id, text: '第二条消息' }, true);
  check('发送消息2', r.status === 200 && r.data.ok, r.data);
  const mid2 = r.data.id;

  // 管理端列表
  r = await api('GET', '/api/admin/messages?toUid=' + s1.id, null, true);
  check('管理端列表 2 条且倒序', r.status === 200 && r.data.list.length === 2 && r.data.list[0].id === mid2, r.data);
  check('列表含未读标记', r.data.list.every((m) => m.read === false), r.data.list);

  // 学生端
  r = await api('POST', '/api/auth/login', { username: U1, password: 'stu12345' });
  check('学生1登录', r.status === 200, r.data);
  r = await api('GET', '/api/messages', null, true);
  check('我的消息 2 条', r.status === 200 && r.data.list.length === 2, r.data);
  check('消息含全文与发送者', r.data.list.some((m) => m.text.includes('#1234') && m.fromName), r.data.list);

  // 未读整合
  r = await api('GET', '/api/notifications/unread', null, true);
  const msgItems = (r.data.items || []).filter((x) => x.type === 'msg');
  check('未读含 2 条 msg', msgItems.length === 2, r.data.items);
  check('msg 项含发送者与全文', msgItems.every((x) => x.fromName && typeof x.text === 'string' && x.text.length > 0), msgItems);

  // 学生2 看不到学生1 的消息
  r = await api('POST', '/api/auth/login', { username: U2, password: 'stu12345' });
  r = await api('GET', '/api/messages', null, true);
  check('学生2 消息为空', r.status === 200 && r.data.list.length === 0, r.data);
  r = await api('POST', '/api/messages/read', { id: mid1 }, true);
  check('学生2 标记他人消息 404', r.status === 404, r.data);
  r = await api('GET', '/api/admin/messages', null, true);
  check('学生查管理列表 403', r.status === 403, r);
  r = await api('POST', '/api/admin/message', { toUid: s1.id, text: 'x' }, true);
  check('学生发消息 403', r.status === 403, r);

  // 学生1：统一已读接口 msg 单条
  r = await api('POST', '/api/auth/login', { username: U1, password: 'stu12345' });
  r = await api('POST', '/api/notifications/read', { type: 'msg', messageId: mid1 }, true);
  check('统一接口标记 msg1', r.status === 200 && r.data.ok, r.data);
  r = await api('GET', '/api/notifications/unread', null, true);
  const left = (r.data.items || []).filter((x) => x.type === 'msg');
  check('未读剩 1 条 msg', left.length === 1 && left[0].messageId === mid2, r.data.items);

  // /api/messages/read 单条
  r = await api('POST', '/api/messages/read', { id: mid2 }, true);
  check('标记 msg2 已读', r.status === 200 && r.data.ok, r.data);
  r = await api('GET', '/api/messages', null, true);
  check('全部已读状态', r.data.list.every((m) => m.read === true), r.data.list);

  // 再发一条 → all:true 统一清除
  r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  await api('POST', '/api/admin/message', { toUid: s1.id, text: '第三条' }, true);
  r = await api('POST', '/api/auth/login', { username: U1, password: 'stu12345' });
  r = await api('GET', '/api/notifications/unread', null, true);
  check('新消息再次出现未读', (r.data.items || []).filter((x) => x.type === 'msg').length === 1, r.data.items);
  r = await api('POST', '/api/notifications/read', { all: true }, true);
  check('全部已读', r.status === 200 && r.data.ok, r.data);
  r = await api('GET', '/api/notifications/unread', null, true);
  check('未读清零', (r.data.items || []).filter((x) => x.type === 'msg').length === 0, r.data.items);

  // 匿名
  jar = null;
  r = await api('GET', '/api/messages', null, true);
  check('匿名查消息 401', r.status === 401, r);

  console.log('\n' + (fail ? fail + ' 项失败' : '全部通过'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
