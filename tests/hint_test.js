'use strict';
// e2e 测试：评测小结 hint —— WA 首个错误位置 / CE 报错摘要 / RE 退出码 / TLE / 样例 hint
// 用法：node tests/hint_test.js [baseUrl] [adminPassword]
const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');
const ADMIN_PW = process.argv[3] || process.env.TGBOJ_ADMIN_PASSWORD;
if (!ADMIN_PW) { console.error('用法: node tests/hint_test.js [baseUrl] [adminPassword]'); process.exit(2); }
const RID = String(Date.now() % 1000000).padStart(6, '0');
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
async function submitAndWait(pid, code, std) {
  const r = await api('POST', '/api/submit', { problemId: pid, std: std || 'c++17', code }, true);
  if (r.status !== 200) return { submitErr: r.data };
  return await waitSub(r.data.id);
}
(async () => {
  let r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  check('管理员登录', r.status === 200, r.data);

  // 题目：样例 1 组 + 2 个正式点；输入 n，输出 1..n 每行一个数
  const desc = '# hint 测试题\n\n输出 1 到 n。\n\n## 输入格式\n\n一个整数 n。\n\n## 输出格式\n\nn 行。';
  const mk = (name, content) => ({ name, content });
  const mp = mpBody({ title: 'hint测试题' + RID, description: desc, hidden: '0' }, [
    mk('sample.in', '3\n'), mk('sample.out', '1\n2\n3\n'),
    mk('1.in', '2\n'), mk('1.out', '1\n2\n'),
    mk('2.in', '4\n'), mk('2.out', '1\n2\n3\n4\n'),
  ]);
  r = await api('POST', '/api/admin/problem', mp.body, true, { 'Content-Type': mp.ctype });
  check('创建测试题', r.status === 200 && r.data.id, r.data);
  const PID = r.data.id;

  // 1. AC：无 hint
  let sub = await submitAndWait(PID, '#include <bits/stdc++.h>\nusing namespace std;\nint main(){int n;cin>>n;for(int i=1;i<=n;i++)cout<<i<<"\\n";}');
  check('AC 无 hint', sub && sub.summary && sub.summary.verdict === 'AC' && !sub.summary.hint, sub && sub.summary);

  // 2. WA 第 2 行不同
  sub = await submitAndWait(PID, '#include <bits/stdc++.h>\nusing namespace std;\nint main(){int n;cin>>n;for(int i=1;i<=n;i++)cout<<(i==2?99:i)<<"\\n";}');
  check('WA 判定', sub && sub.summary && /WA/.test(sub.summary.firstError || ''), sub && sub.summary);
  check('WA hint 首个错误位置', sub && sub.summary.hint && sub.summary.hint.indexOf('第 2 行不同') !== -1 && sub.summary.hint.indexOf('期望 "2"') !== -1 && sub.summary.hint.indexOf('"99"') !== -1, sub && sub.summary.hint);

  // 3. WA 输出过早结束
  sub = await submitAndWait(PID, '#include <bits/stdc++.h>\nusing namespace std;\nint main(){int n;cin>>n;for(int i=1;i<n;i++)cout<<i<<"\\n";}');
  check('缺行 hint', sub && sub.summary.hint && sub.summary.hint.indexOf('输出过早结束') !== -1, sub && sub.summary.hint);

  // 4. WA 输出多余
  sub = await submitAndWait(PID, '#include <bits/stdc++.h>\nusing namespace std;\nint main(){int n;cin>>n;for(int i=1;i<=n+1;i++)cout<<i<<"\\n";}');
  check('多行 hint', sub && sub.summary.hint && sub.summary.hint.indexOf('输出多余') !== -1, sub && sub.summary.hint);

  // 5. CE：hint 含报错行
  sub = await submitAndWait(PID, '#include <bits/stdc++.h>\nusing namespace std;\nint main(){int n;cin>>n;undeclared_func(n);}');
  check('CE 判定', sub && sub.summary && sub.summary.verdict === 'CE', sub && sub.summary);
  check('CE hint 含报错', sub && sub.summary.hint && /error/i.test(sub.summary.hint), sub && sub.summary.hint);
  check('CE 保留完整 compileError', sub && sub.summary.compileError && sub.summary.compileError.length > 0);

  // 6. RE：段错误 → 退出码+信号
  sub = await submitAndWait(PID, '#include <bits/stdc++.h>\nusing namespace std;\nint main(){int n;cin>>n;volatile int*p=nullptr;*p=1;return 0;}');
  check('RE 判定', sub && sub.summary && /RE/.test(sub.summary.firstError || ''), sub && sub.summary);
  check('RE hint 退出码与信号', sub && sub.summary.hint && /退出码 \d+/.test(sub.summary.hint) && sub.summary.hint.indexOf('信号') !== -1, sub && sub.summary.hint);

  // 7. TLE：hint 含时间限制
  sub = await submitAndWait(PID, '#include <bits/stdc++.h>\nusing namespace std;\nint main(){int n;cin>>n;long long x=0;while(1){x++;}return 0;}');
  check('TLE 判定', sub && sub.summary && /TLE/.test(sub.summary.firstError || ''), sub && sub.summary);
  check('TLE hint 时间限制', sub && sub.summary.hint && sub.summary.hint.indexOf('时间限制') !== -1, sub && sub.summary.hint);

  // 8. 样例 WA：/api/sample 返回 hint
  sub = await submitAndWait(PID, '#include <bits/stdc++.h>\nusing namespace std;\nint main(){int n;cin>>n;if(n==3){cout<<"1\\n9\\n3\\n";}else for(int i=1;i<=n;i++)cout<<i<<"\\n";}');
  check('样例失败标记', sub && sub.summary && sub.summary.sampleFailed === true, sub && sub.summary);
  check('汇总 hint 来自样例', sub && sub.summary.hint && sub.summary.hint.indexOf('第 2 行不同') !== -1, sub && sub.summary.hint);
  const subId = sub && sub.id;
  r = await api('GET', '/api/sample/' + subId + '?sid=1', null, true);
  check('样例详情含 hint', r.status === 200 && r.data.hint && r.data.hint.indexOf('9') !== -1, r.data);

  console.log('\n' + (fail ? fail + ' 项失败' : '全部通过'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
