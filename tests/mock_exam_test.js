'use strict';
// e2e 测试：模考卷 4 题（2136-2139）组装验证：std 提交 → AC 100 分；样例附件可下载
// 前置：实例 problems/ 下已有 2136-2139 四题（含 data/、sample*、problem.json、description.md、solution.md）
// 用法：node tests/mock_exam_test.js [baseUrl] [adminPassword]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const BASE = (process.argv[2] || 'http://localhost:8090').replace(/\/$/, '');
const ADMIN_PW = process.argv[3] || process.env.TGBOJ_ADMIN_PASSWORD || '';
let fail = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra && !cond ? ' | ' + JSON.stringify(extra).slice(0, 300) : '')); if (!cond) fail++; };
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
async function waitSub(id, tries) {
  for (let i = 0; i < (tries || 200); i++) {
    const d = await api('GET', '/api/submission/' + id, null, true);
    if (d.data && d.data.status === 'done') return d.data;
    await new Promise((res) => setTimeout(res, 500));
  }
  return null;
}
(async () => {
  let r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  check('管理员登录', r.status === 200, r.data);
  const PROBS = [
    { id: 2136, tag: 'network', title: '小信研究网络' },
    { id: 2137, tag: 'server', title: '小信管机房' },
    { id: 2138, tag: 'colors', title: '小信数颜色' },
    { id: 2139, tag: 'minecraft', title: '小信想玩 MC' },
  ];
  const srcDir = '/home/joww/Work/CP-Problems/NOI2004-yydcny/problems-src/mock/';
  for (const P of PROBS) {
    // 题目元数据
    const pd = await api('GET', '/api/problem?id=' + P.id, null, true);
    check('题目 ' + P.id + ' 元数据可读', pd.status === 200 && pd.data.title === '【模考】' + P.title, pd.data);
    check('题目 ' + P.id + ' 测试点=20', pd.data.testCount === 20, pd.data.testCount);
    const sc = pd.data.scoring;
    check('题目 ' + P.id + ' 为测试点均分计分（CSP-S 惯例，无子任务）', !sc || sc.mode !== 'subtask' || !sc.subtasks || !sc.subtasks.length, sc);
    // 编译并提交 std
    const bin = '/tmp/e2e_' + P.tag + '_std';
    execFileSync('g++', ['-O2', '-std=c++17', '-o', bin, path.join(srcDir, P.tag, 'std.cpp')]);
    const code = fs.readFileSync(path.join(srcDir, P.tag, 'std.cpp'), 'utf8');
    r = await api('POST', '/api/submit', { problemId: P.id, std: 'c++17', code }, true);
    check('题目 ' + P.id + ' 提交成功', r.status === 200 && r.data.id, r.data);
    const sub = await waitSub(r.data.id);
    const ac = sub && sub.summary && sub.summary.verdict === 'AC' && sub.summary.score === 100;
    check('题目 ' + P.id + ' std AC 100 分', !!ac, sub && { verdict: sub.summary && sub.summary.verdict, score: sub.summary && sub.summary.score, pts: sub.points && sub.points.map((p) => p.verdict).join('') });
  }
  // 样例附件下载（files 14-17）
  for (const [fid, name] of [[14, 'T1'], [15, 'T2'], [16, 'T3'], [17, 'T4']]) {
    r = await api('GET', '/files/' + fid + '/download', null, true);
    check(name + ' 样例zip可下载', r.status === 200 && String(r.data).length > 0, r.data);
  }
  // 题面渲染含附件链接
  const pd = await api('GET', '/api/problem?id=2136', null, true);
  check('题面含样例打包下载链接', /样例打包下载/.test(pd.data.html || ''), pd.data.html && pd.data.html.slice(0, 100));
  console.log(fail ? ('FAIL: ' + fail) : 'ALL PASS');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });