'use strict';
// e2e 冒烟测试：注册 → 审核 → 登录（记住我） → 提交评测 → 作业 → 登出
const fs = require('fs');
const path = require('path');
const BASE = (process.argv[2] || 'http://localhost:8090').replace(/\/$/, '');
const ADMIN_PW = process.argv[3] || process.env.TGBOJ_ADMIN_PASSWORD;
if (!ADMIN_PW) { console.error('用法: node tests/e2e_test.js [baseUrl] [adminPassword]（或设环境变量 TGBOJ_ADMIN_PASSWORD，不再提供默认密码）'); process.exit(2); }
const TEST_DIR = __dirname;
let fail = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name); if (!cond) fail++; };

const rand = 'u' + Date.now().toString(36);
const jar = {}; // token 管理（模拟 cookie）
function cookieHeader() { return jar.token ? { Cookie: 'tgboj_token=' + jar.token } : {}; }
async function api(method, p, body, useCookie) {
  const r = await fetch(BASE + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(useCookie ? cookieHeader() : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (method === 'POST' && p === '/api/auth/login') {
    const sc = r.headers.get('set-cookie') || '';
    const m = /tgboj_token=([^;]+)/.exec(sc);
    if (m) jar.token = m[1];
  }
  return { status: r.status, data: await r.json().catch(() => null) };
}

(async () => {
  // 1. 注册
  let r = await api('POST', '/api/auth/register', { username: rand, fullname: '冒烟测试', password: 'pass123' });
  check('注册（待审核）', r.status === 200 && r.data.ok);
  // 2. 未审核登录被拒
  r = await api('POST', '/api/auth/login', { username: rand, password: 'pass123' });
  check('未审核登录被拒', r.status === 400 && /审核/.test(r.data.error));
  // 3. admin 登录 + 审核
  r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW, remember: true });
  check('admin 登录（30 天）', r.status === 200 && r.data.user.role === 'superadmin');
  const users = await api('GET', '/api/admin/users', null, true);
  const target = users.data.users.find((u) => u.username === rand);
  r = await api('POST', '/api/admin/user/audit', { id: target.id, action: 'approve' }, true);
  check('admin 审核通过', r.status === 200 && r.data.status === 'active');
  // 3.5 自建冒烟作业（不依赖生产种子数据）
  r = await api('POST', '/api/admin/homework', { title: '冒烟作业' + rand, questions: ['q1', 'q2', 'q3', 'q4'] }, true);
  check('自建冒烟作业', r.status === 200 && r.data.id, r.data);
  const smokeHwId = r.data.id;
  // 4. 用户登录（不记住 → 1 天）
  r = await api('POST', '/api/auth/login', { username: rand, password: 'pass123' });
  check('用户登录（1 天）', r.status === 200 && r.data.user.fullname === '冒烟测试');
  // 5. 提交评测
  const code = fs.readFileSync(path.join(TEST_DIR, 'std_stdin.cpp'), 'utf8');
  r = await api('POST', '/api/submit', { std: 'c++17', problemId: 2026, code }, true);
  check('提交（账号身份）', r.status === 200 && typeof r.data.id === 'number');
  const sid = r.data.id;
  for (;;) {
    const st = await api('GET', '/api/status', null, true);
    const s = st.data.list.find((x) => x.id === sid);
    if (s && s.status === 'done') { check('评测完成: ' + s.summary.display, s.summary.verdict === 'AC'); break; }
    await new Promise((r) => setTimeout(r, 1200));
  }
  // 6. 作业
  r = await api('POST', '/api/homework/answer', { homeworkId: smokeHwId, answers: ['a', 'b', 'c', 'd'] }, true);
  check('作业提交', r.status === 200 && r.data.ok);
  // 7. 普通用户无管理权限
  r = await api('GET', '/api/admin/users', null, true);
  check('普通用户访问管理 API 被拒', r.status === 403);
  // 8. 登出
  r = await api('POST', '/api/auth/logout', null, true);
  const me = await api('GET', '/api/auth/me');
  check('登出后未登录', me.status === 200 && me.data.user === null);

  console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
})();
