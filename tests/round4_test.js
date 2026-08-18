'use strict';
// e2e 测试（第四轮）：OLE 输出超限 / 私信 toUsername 入口 / AI 风险检测（mock AI 服务）
// 用法：node tests/round4_test.js [baseUrl] [adminPassword]
// 前置：隔离实例 config 需 outputLimitKb=2048（2MB，加速 OLE 测试）且 aiReview 指向 mock（本测试 8123 端口自起）
const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');
const ADMIN_PW = process.argv[3] || process.env.TGBOJ_ADMIN_PASSWORD;
if (!ADMIN_PW) { console.error('用法: node tests/round4_test.js [baseUrl] [adminPassword]'); process.exit(2); }
const http = require('http');
const RID = String(Date.now() % 1000000).padStart(6, '0');
const U1 = 'r4u' + RID;
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
async function waitSub(id) {
  for (let i = 0; i < 200; i++) {
    const d = await api('GET', '/api/submission/' + id, null, true);
    if (d.data && d.data.status === 'done') return d.data;
    await new Promise((res) => setTimeout(res, 300));
  }
  return null;
}
(async () => {
  // mock AI 服务（OpenAI 兼容）
  let aiCalls = 0;
  const mockAi = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      aiCalls++;
      const dangerous = body.indexOf('system(') !== -1;
      const verdict = dangerous
        ? { risk: 'high', categories: ['危险系统调用'], summary: '代码调用 system 执行外部命令，属危险系统调用。' }
        : { risk: 'none', categories: [], summary: '正常算法代码，未发现风险。' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }] }));
    });
  });
  await new Promise((res) => mockAi.listen(8123, '127.0.0.1', res));

  let r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  check('管理员登录', r.status === 200, r.data);

  // ---- 私信 toUsername 入口 ----
  r = await api('POST', '/api/admin/user/save', { username: U1, fullname: '入口学生', studentId: 'R4' + RID, password: 'stu12345' }, true);
  check('创建学生', r.status === 200 && r.data.ok, r.data);
  r = await api('POST', '/api/admin/message', { toUsername: U1, text: '按用户名发送' }, true);
  check('toUsername 发送', r.status === 200 && r.data.ok && r.data.id, r.data);
  r = await api('POST', '/api/admin/message', { toUsername: 'no_such_user', text: 'x' }, true);
  check('toUsername 不存在 404', r.status === 404, r.data);
  r = await api('GET', '/api/admin/messages?toUsername=' + U1, null, true);
  check('toUsername 查历史', r.status === 200 && r.data.list.length === 1 && r.data.list[0].text === '按用户名发送', r.data);
  r = await api('GET', '/api/admin/messages?toUsername=no_such_user', null, true);
  check('不存在用户历史为空', r.status === 200 && r.data.list.length === 0, r.data);

  // ---- OLE ----
  const desc = '# OLE 测试题\n\nA+B。\n\n## 输入格式\n\n两个整数。\n\n## 输出格式\n\n一个整数。';
  const mk = (name, content) => ({ name, content });
  const mp = mpBody({ title: 'OLE测试题' + RID, description: desc, hidden: '0' }, [mk('1.in', '1 2\n'), mk('1.out', '3\n')]);
  r = await api('POST', '/api/admin/problem', mp.body, true, { 'Content-Type': mp.ctype });
  check('创建 OLE 测试题', r.status === 200 && r.data.id, r.data);
  const PID = r.data.id;

  // 正常提交仍 AC（输出远低于 2MB 限额）
  r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: '#include <bits/stdc++.h>\nusing namespace std;\nint main(){int a,b;cin>>a>>b;cout<<a+b<<endl;}' }, true);
  check('正常代码提交', r.status === 200 && r.data.id, r.data);
  let sub = await waitSub(r.data.id);
  check('正常代码 AC', sub && sub.summary && sub.summary.verdict === 'AC', sub && sub.summary);

  // 输出轰炸代码 → OLE，且被及时终止（远小于 2×时限+宽限）
  const oleCode = '#include <bits/stdc++.h>\nusing namespace std;\nint main(){int a,b;cin>>a>>b;string s(1000,\'x\');while(1){fputs(s.c_str(),stdout);fflush(stdout);}}';
  const t0 = Date.now();
  r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: oleCode }, true);
  check('轰炸代码提交', r.status === 200 && r.data.id, r.data);
  sub = await waitSub(r.data.id);
  const oleMs = Date.now() - t0;
  check('评测完成', !!sub && sub.status === 'done', sub);
  check('判定为 OLE', sub && sub.points && sub.points.some((p) => p.verdict === 'OLE'), sub && sub.points);
  check('汇总首错为 OLE', sub && sub.summary && /OLE/.test(sub.summary.firstError || ''), sub && sub.summary);
  check('被及时终止（<30s）', oleMs < 30000, { oleMs });
  const OLE_SUB = r.data.id;

  // ---- AI 风险检测 ----
  r = await api('GET', '/api/auth/me', null, true);
  check('管理员可见 aiReviewEnabled', r.status === 200 && r.data.aiReviewEnabled === true, r.data);

  r = await api('POST', '/api/admin/ai-review', { submissionId: 999999 }, true);
  check('检测不存在提交 404', r.status === 404, r.data);

  r = await api('POST', '/api/admin/ai-review', { submissionId: OLE_SUB }, true);
  check('AI 检测成功', r.status === 200 && r.data.ok && r.data.review, r.data);
  check('风险等级合法', r.data.review && ['none', 'low', 'medium', 'high'].indexOf(r.data.review.risk) !== -1, r.data.review);
  const callsAfterFirst = aiCalls;
  check('mock 被调用', callsAfterFirst >= 1, { aiCalls });

  r = await api('POST', '/api/admin/ai-review', { submissionId: OLE_SUB }, true);
  check('二次检测走缓存', r.status === 200 && r.data.cached === true && aiCalls === callsAfterFirst, { aiCalls, cached: r.data.cached });

  r = await api('POST', '/api/admin/ai-review', { submissionId: OLE_SUB, force: true }, true);
  check('force 重检调用 AI', r.status === 200 && aiCalls === callsAfterFirst + 1, { aiCalls });

  // 详情对管理员返回 aiReview
  r = await api('GET', '/api/submission/' + OLE_SUB, null, true);
  check('详情含 aiReview', r.status === 200 && r.data.aiReview && r.data.aiReview.risk, r.data.aiReview);

  // 危险代码检测（mock 按 system( 判 high）
  r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: '#include <bits/stdc++.h>\nusing namespace std;\nint main(){int a,b;cin>>a>>b;cout<<a+b<<endl;system("echo hi");}' }, true);
  const D_SUB = r.data.id;
  await waitSub(D_SUB);
  r = await api('POST', '/api/admin/ai-review', { submissionId: D_SUB }, true);
  check('危险代码判 high', r.status === 200 && r.data.review && r.data.review.risk === 'high' && r.data.review.categories.indexOf('危险系统调用') !== -1, r.data.review);

  // 学生无权
  r = await api('POST', '/api/auth/login', { username: U1, password: 'stu12345' });
  r = await api('POST', '/api/admin/ai-review', { submissionId: OLE_SUB }, true);
  check('学生检测 403', r.status === 403, r);
  r = await api('GET', '/api/submission/' + OLE_SUB, null, true);
  check('学生详情不含 aiReview', r.status === 200 && r.data.aiReview === undefined, Object.keys(r.data));

  mockAi.close();
  console.log('\n' + (fail ? fail + ' 项失败' : '全部通过'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
