'use strict';
// e2e 测试：AI 自动检测 + 自动拦截 + 高风险 1 分钟禁提交
// 用法：node tests/ai_auto_test.js <baseUrl> <adminPassword> <block|check>
// 前置：mock AI 由本测试自起（8123 端口）：含 "system(" → high；含 "while(1)" → medium；其余 none
const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');
const ADMIN_PW = process.argv[3] || process.env.TGBOJ_ADMIN_PASSWORD;
const MODE = process.argv[4] || 'block';
if (!ADMIN_PW) { console.error('用法: node tests/ai_auto_test.js [baseUrl] [adminPassword] [block|check]'); process.exit(2); }
const http = require('http');
const RID = String(Date.now() % 1000000).padStart(6, '0');
let fail = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra && !cond ? ' | ' + JSON.stringify(extra).slice(0, 300) : '')); if (!cond) fail++; };
const jars = {};
async function api(method, p, body, jar) {
  const headers = Object.assign({}, body ? { 'Content-Type': 'application/json' } : {}, jar && jars[jar] ? { Cookie: 'tgboj_token=' + jars[jar] } : {});
  const r = await fetch(BASE + p, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  if (method === 'POST' && p === '/api/auth/login') {
    const m = /tgboj_token=([^;]+)/.exec(r.headers.get('set-cookie') || '');
    if (m && jar) jars[jar] = m[1];
  }
  const txt = await r.text();
  let data;
  try { data = JSON.parse(txt); } catch (e) { data = txt; }
  return { status: r.status, data };
}
function mpBody(fields, files) {
  const boundary = '----tgboj' + Date.now();
  const chunks = [];
  for (const [k, v] of Object.entries(fields)) chunks.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + v + '\r\n'));
  for (const f of files) {
    chunks.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="data"; filename="' + f.name + '"\r\nContent-Type: application/octet-stream\r\n\r\n'));
    chunks.push(Buffer.from(f.content), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from('--' + boundary + '--\r\n'));
  return { ctype: 'multipart/form-data; boundary=' + boundary, body: Buffer.concat(chunks) };
}
async function waitDone(id, jar) {
  for (let i = 0; i < 200; i++) {
    const d = await api('GET', '/api/submission/' + id, null, jar || 'admin');
    if (d.data && d.data.status === 'done') return d.data;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}
const SAFE = '#include <bits/stdc++.h>\nusing namespace std;\nint main(){int a,b;cin>>a>>b;cout<<a+b<<endl;}';
const HIGH = '#include <bits/stdc++.h>\nusing namespace std;\nint main(){int a,b;cin>>a>>b;cout<<a+b<<endl;system("echo pwned");}';
const MED = '#include <bits/stdc++.h>\nusing namespace std;\nint main(){int a,b;cin>>a>>b;cout<<a+b<<endl;while(1){}}';
(async () => {
  let aiUp = true;
  const mockAi = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      // 只检测用户消息中的代码（系统提示词本身含 while(1) 等示例，不能整包匹配）
      let code = '';
      try { const d = JSON.parse(body); code = d.messages[d.messages.length - 1].content; } catch (e) { code = body; }
      const risk = code.indexOf('system(') !== -1 ? 'high' : (code.indexOf('while(1)') !== -1 ? 'medium' : 'none');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ risk, categories: risk === 'none' ? [] : ['测试'], summary: 'mock 判定 ' + risk }) } }] }));
    });
  });
  await new Promise((r) => mockAi.listen(8123, '127.0.0.1', r));

  let r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW }, 'admin');
  check('管理员登录', r.status === 200, r.data);
  // 规格化运行期配置（测试幂等：上一轮可能改过阈值/开关）
  r = await api('POST', '/api/admin/ai-settings', { autoCheck: true, autoBlock: MODE === 'block', blockRisk: 'high' }, 'admin');
  check('规格化 AI 开关', r.status === 200 && r.data.ok, r.data);

  // 建题 + 三个学生
  const mp = mpBody({ title: 'AI自动测试题' + RID, description: '# t\n\nA+B\n\n## 输入格式\n\na b\n\n## 输出格式\n\ns', hidden: '0' }, [{ name: '1.in', content: '1 2\n' }, { name: '1.out', content: '3\n' }]);
  r = await api('POST', '/api/admin/problem', mp.body, 'admin');
  // multipart 需要原始头
  if (r.status !== 200) {
    const rr = await fetch(BASE + '/api/admin/problem', { method: 'POST', headers: { 'Content-Type': mp.ctype, Cookie: 'tgboj_token=' + jars.admin }, body: mp.body });
    r = { status: rr.status, data: await rr.json() };
  }
  check('创建测试题', r.status === 200 && r.data.id, r.data);
  const PID = r.data.id;
  const S = ['aa', 'bb', 'cc'].map((x) => x + RID);
  for (const un of S) {
    await api('POST', '/api/admin/user/save', { username: un, fullname: 'AI学生' + un, password: 'stu12345' }, 'admin');
    r = await api('POST', '/api/auth/login', { username: un, password: 'stu12345' }, un);
    check('学生登录 ' + un, r.status === 200, r.data);
  }

  if (MODE === 'block') {
    // ---- 拦截模式（autoCheck + autoBlock，阈值 high）----
    r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: SAFE }, S[0]);
    const safeSub = await waitDone(r.data.id);
    check('安全代码正常评测 AC', safeSub && safeSub.summary && safeSub.summary.verdict === 'AC', safeSub && safeSub.summary);
    check('安全代码已带 AI 结果 none', safeSub && safeSub.aiReview && safeSub.aiReview.risk === 'none', safeSub && safeSub.aiReview);

    r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: MED }, S[0]);
    const medSub = await waitDone(r.data.id);
    check('中风险代码不拦截（阈值 high）', medSub && medSub.summary && !medSub.aiBlocked, medSub && { v: medSub.summary && medSub.summary.verdict, b: medSub.aiBlocked });
    check('中风险带 AI 结果 medium', medSub && medSub.aiReview && medSub.aiReview.risk === 'medium', medSub && medSub.aiReview);

    // 高风险：拦截
    r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: HIGH }, S[1]);
    const highId = r.data.id;
    const highSub = await waitDone(highId);
    check('高风险被拦截（无评测结果）', highSub && !highSub.summary && highSub.aiBlocked === true, highSub && { sm: highSub.summary, b: highSub.aiBlocked });
    check('高风险带 AI 结果 high', highSub && highSub.aiReview && highSub.aiReview.risk === 'high', highSub && highSub.aiReview);
    // 学生列表不可见
    r = await api('GET', '/api/status?page=1&size=50', null, S[1]);
    {
    const it = (r.data.list || []).find((x) => x.id === highId);
    check('本人列表可见已拦截标记', !!it && it.aiBlocked === true, r.data.list && r.data.list.length);
  }
    // 学生本人详情 = 拦截说明
    r = await api('GET', '/api/submission/' + highId, null, S[1]);
    check('本人详情为已拦截（无原因细节）', r.status === 200 && r.data.blocked === true && !r.data.blockNote && !r.data.summary, r.data);
    // 他人详情 404
    r = await api('GET', '/api/submission/' + highId, null, S[0]);
    check('他人详情 404', r.status === 404, r.status);
    // 1 分钟禁提交
    r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: SAFE }, S[1]);
    check('高风险后 1 分钟内禁提交 429', r.status === 429 && /秒后再试/.test(r.data.error || '') && !/AI|高风险/.test(r.data.error || ''), r.data);
    // 管理员提交不受影响也不自动检测
    r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: HIGH }, 'admin');
    const admSub = await waitDone(r.data.id);
    check('管理员提交照常评测不自动检测', admSub && admSub.summary && !admSub.aiReview, admSub && { v: admSub.summary && admSub.summary.verdict, ai: admSub.aiReview });
    // 解除拦截 + 重测
    r = await api('POST', '/api/admin/ai-unblock', { submissionId: highId }, 'admin');
    check('解除拦截', r.status === 200 && r.data.ok, r.data);
    r = await api('GET', '/api/submission/' + highId, null, S[0]);
    check('解除后他人可见', r.status === 200, r.status);
    r = await api('POST', '/api/admin/rejudge', { ids: [highId] }, 'admin');
    check('解除后重测', r.status === 200, r.data);
    const rejudged = await waitDone(highId);
    check('重测出结果', rejudged && rejudged.summary && rejudged.summary.verdict, rejudged && rejudged.summary);

    // fail-open：关停 mock AI，第三个学生照常评测
    mockAi.close(); aiUp = false;
    r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: SAFE }, S[2]);
    const foSub = await waitDone(r.data.id);
    check('AI 故障时提交照常评测（fail-open）', foSub && foSub.summary && foSub.summary.verdict === 'AC', foSub && foSub.summary);
  } else {
    // ---- 仅自动检测模式（autoCheck 开、autoBlock 关）：评测后异步检测；high 仍强制拦截+禁提交 ----
    r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: HIGH }, S[0]);
    const highId = r.data.id;
    const judged = await waitDone(highId);
    check('先正常评测出结果', judged && judged.summary && judged.summary.verdict, judged && judged.summary);
    // 异步检测随后落地：轮询 aiReview
    let after = null;
    for (let i = 0; i < 60; i++) {
      const d = await api('GET', '/api/submission/' + highId, null, 'admin');
      if (d.data && d.data.aiReview) { after = d.data; break; }
      await new Promise((r2) => setTimeout(r2, 500));
    }
    check('异步 AI 结果落地 high', after && after.aiReview && after.aiReview.risk === 'high', after && after.aiReview);
    check('高风险被事后强制拦截', after && after.aiBlocked === true, after && after.aiBlocked);
    r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: SAFE }, S[0]);
    check('高风险后 1 分钟内禁提交 429', r.status === 429, r.data);
    // 中风险不拦截
    r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: MED }, S[1]);
    const medId = r.data.id;
    await waitDone(medId);
    let medAfter = null;
    for (let i = 0; i < 60; i++) {
      const d = await api('GET', '/api/submission/' + medId, null, 'admin');
      if (d.data && d.data.aiReview) { medAfter = d.data; break; }
      await new Promise((r2) => setTimeout(r2, 500));
    }
    check('中风险仅记录不拦截', medAfter && medAfter.aiReview && medAfter.aiReview.risk === 'medium' && !medAfter.aiBlocked, medAfter && { ai: medAfter.aiReview, b: medAfter.aiBlocked });
    mockAi.close();
  }

  // ai-settings 开关持久化
  r = await api('POST', '/api/admin/ai-settings', { autoCheck: true, autoBlock: true, blockRisk: 'medium' }, 'admin');
  check('ai-settings 保存', r.status === 200 && r.data.ok && r.data.blockRisk === 'medium', r.data);
  r = await api('POST', '/api/admin/ai-settings', { autoCheck: true, autoBlock: true, blockRisk: 'extreme' }, 'admin');
  check('非法阈值 400', r.status === 400, r.data);
  r = await api('GET', '/api/admin/config', null, 'admin');
  check('config 透出三开关', r.status === 200 && r.data.config.aiAutoCheck === true && r.data.config.aiAutoBlock === true && r.data.config.aiBlockRisk === 'medium', r.data.config);

  console.log('\n' + (fail ? fail + ' 项失败' : '全部通过（模式：' + MODE + '）'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
