'use strict';
// e2e 测试：/api/status 服务端分页（page/size/find + 无参数全量兼容）+ 编译缓存（哈希键、复用、CE 不留痕、python 不走缓存）
// 用法：node tests/status_cache_test.js [baseUrl] [adminPassword]
const fs = require('fs');
const path = require('path');
const BASE = (process.argv[2] || 'http://localhost:8090').replace(/\/$/, '');
const ADMIN_PW = process.argv[3] || process.env.TGBOJ_ADMIN_PASSWORD || '';
const RID = String(Date.now() % 1000000).padStart(6, '0');
const CACHE_DIR = path.join(__dirname, '..', '.compile-cache');
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
  for (let i = 0; i < (tries || 100); i++) {
    const d = await api('GET', '/api/submission/' + id, null, true);
    if (d.data && d.data.status === 'done') return d.data;
    await new Promise((res) => setTimeout(res, 400));
  }
  return null;
}
function cacheBins() {
  try { return fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.bin')); } catch (e) { return []; }
}
(async () => {
  let r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  check('管理员登录', r.status === 200, r.data);

  // 建题：1 个测试点 a+b
  const mp = mpBody({ title: '分页缓存测试题' + RID, description: '# A+B', hidden: '0' }, [{ name: '1.in', content: '1 2\n' }, { name: '1.out', content: '3\n' }]);
  r = await api('POST', '/api/admin/problem', mp.body, true, { 'Content-Type': mp.ctype });
  check('创建测试题', r.status === 200 && r.data.id, r.data);
  const PID = r.data.id;

  // 提交 3 次相同 C++ 代码
  const NL = String.fromCharCode(10); // 语句间真实换行
  const BSL = String.fromCharCode(92); // 反斜杠（printf 转义）
  const AC = '#include <cstdio>' + NL + 'int main(){ int a,b; scanf("%d%d",&a,&b); printf("%d' + BSL + 'n", a+b); return 0; }';
  const AC2 = AC.replace('a+b', 'b+a'); // 语义相同、源码不同 → 新缓存条目
  const ids = [];
  for (let i = 0; i < 3; i++) {
    r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: AC }, true);
    ids.push(r.data.id);
    const s = await waitSub(r.data.id);
    check('提交#' + ids[i] + ' AC', !!s && s.summary && s.summary.verdict === 'AC', s && s.summary);
  }

  // —— 服务端分页 ——
  let st = await api('GET', '/api/status?page=1&size=2', null, true);
  check('page=1&size=2 → 2 条', st.status === 200 && st.data.list.length === 2, st.data);
  check('total=3 / page=1 / size=2', st.data.total === 3 && st.data.page === 1 && st.data.size === 2, st.data);
  check('第 1 页为新提交倒序', st.data.list[0].id === ids[2] && st.data.list[1].id === ids[1], st.data.list);
  st = await api('GET', '/api/status?page=2&size=2', null, true);
  check('page=2&size=2 → 1 条且为最旧提交', st.data.list.length === 1 && st.data.list[0].id === ids[0], st.data);
  st = await api('GET', '/api/status?page=9&size=2', null, true);
  check('超界页钳制到末页（page=2 一条）total 仍为 3', st.data.page === 2 && st.data.list.length === 1 && st.data.total === 3, st.data);
  st = await api('GET', '/api/status?find=' + ids[0] + '&size=2', null, true);
  check('find=' + ids[0] + ' → 定位第 2 页', st.data.page === 2 && st.data.list.some((x) => x.id === ids[0]), st.data);
  st = await api('GET', '/api/status?find=99999999&size=2', null, true);
  check('find 不存在 → 第 1 页', st.data.page === 1, st.data);
  st = await api('GET', '/api/status', null, true);
  check('无参数 → 全量兼容（≥3 条）', st.status === 200 && st.data.list.length >= 3 && st.data.size === null, st.data);
  st = await api('GET', '/api/status?user=nobody' + RID + '&page=1&size=2', null, true);
  check('筛选 + 分页：无结果 total=0', st.data.total === 0 && st.data.list.length === 0, st.data);
  st = await api('GET', '/api/status?problem=' + PID + '&page=1&size=1', null, true);
  check('problem 筛选 + 分页 total=3', st.data.total === 3 && st.data.list.length === 1, st.data);
  st = await api('GET', '/api/status?page=1&size=abc', null, true);
  check('非法 size → 退回全量', st.data.size === null && st.data.list.length >= 3, st.data);

  // —— 编译缓存 ——
  const bins1 = cacheBins();
  check('编译缓存已生成 ≥1 个二进制', bins1.length >= 1, bins1);
  r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: AC }, true);
  let s = await waitSub(r.data.id);
  check('相同代码再次提交 AC（缓存命中）', !!s && s.summary && s.summary.verdict === 'AC', s && s.summary);
  const bins2 = cacheBins();
  check('相同代码不新增缓存文件', bins2.length === bins1.length, { before: bins1.length, after: bins2.length });
  r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: AC2 }, true);
  s = await waitSub(r.data.id);
  check('不同代码 → 新缓存条目', cacheBins().length === bins1.length + 1, { before: bins1.length, after: cacheBins().length });
  const CE = 'int main(){ return 0 }';
  r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: CE }, true);
  s = await waitSub(r.data.id);
  check('CE 代码 → CE 判定', !!s && s.summary && s.summary.verdict === 'CE', s && s.summary);
  check('CE 不产生缓存条目', cacheBins().length === bins1.length + 1, cacheBins());
  const leftovers = (() => { try { return fs.readdirSync(CACHE_DIR).filter((f) => f.includes('.tmp')); } catch (e) { return []; } })();
  check('CE 无 .tmp 残留', leftovers.length === 0, leftovers);
  const PY = 'import sys\na, b = map(int, sys.stdin.read().split())\nprint(a + b)';
  r = await api('POST', '/api/submit', { problemId: PID, std: 'python3', code: PY }, true);
  s = await waitSub(r.data.id);
  check('python3 提交 AC（不走编译缓存）', !!s && s.summary && s.summary.verdict === 'AC', s && s.summary);
  check('python3 不新增缓存条目', cacheBins().length === bins1.length + 1, cacheBins());

  // —— 重评复用缓存 ——
  r = await api('POST', '/api/admin/rejudge', { ids: [ids[0], ids[1]] }, true);
  check('重评受理', r.status === 200, r.data);
  for (const id of [ids[0], ids[1]]) {
    s = await waitSub(id);
    check('重评#' + id + ' AC（缓存复用）', !!s && s.summary && s.summary.verdict === 'AC', s && s.summary);
  }
  check('重评后缓存条目数不变', cacheBins().length === bins1.length + 1, cacheBins());

  console.log(fail ? ('FAIL: ' + fail) : 'ALL PASS');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });