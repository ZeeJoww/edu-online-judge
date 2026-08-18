'use strict';
// e2e 测试：P2/P3（用户删除 / 时限·内存·fileIO 编辑 / checker 上传重编译 / 配置展示 / 全站公告 / 评语已读 POST / 非法 JSON 400 / 注册限速 / 答案版本上限 / 队列上限提示）
// 用法：node tests/p2_p3_test.js [baseUrl] [adminPassword]；幂等（runId 后缀）
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const BASE = (process.argv[2] || 'http://localhost:8090').replace(/\/$/, '');
const ADMIN_PW = process.argv[3] || process.env.TGBOJ_ADMIN_PASSWORD || '';
const RID = String(Date.now() % 1000000).padStart(6, '0');
const S1 = 'q1' + RID;
let fail = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra && !cond ? ' | ' + JSON.stringify(extra).slice(0, 200) : '')); if (!cond) fail++; };
const jar = { token: '' }; const jarS = { token: '' };
function cookieHeader(j) { return j.token ? { Cookie: 'tgboj_token=' + j.token } : {}; }
async function api(method, p, body, useCookie, rawHeaders, jarUse) {
  const headers = Object.assign({}, useCookie ? cookieHeader(jarUse || jar) : {}, body && !rawHeaders ? { 'Content-Type': 'application/json' } : {}, rawHeaders || {});
  const r = await fetch(BASE + p, { method, headers, body: (body === undefined || body === null) ? undefined : (rawHeaders ? body : JSON.stringify(body)) });
  if (method === 'POST' && p === '/api/auth/login') { const sc = r.headers.get('set-cookie') || ''; const m = /tgboj_token=([^;]+)/.exec(sc); if (m) (jarUse || jar).token = m[1]; }
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: r.status, data };
}
function mpBody(fields, files) {
  const boundary = '----tgboj' + Date.now() + Math.random().toString(16).slice(2);
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) chunks.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n'));
  for (const f of files) {
    chunks.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="data"; filename="' + f.name + '"\r\nContent-Type: application/octet-stream\r\n\r\n'));
    chunks.push(Buffer.from(f.content)); chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from('--' + boundary + '--\r\n'));
  return { ctype: 'multipart/form-data; boundary=' + boundary, body: Buffer.concat(chunks) };
}
const upload = async (fields, files, p) => { const mp = mpBody(fields, files); return fetch(BASE + p, { method: 'POST', headers: Object.assign({ Cookie: 'tgboj_token=' + jar.token }, { 'Content-Type': mp.ctype }), body: mp.body }).then(async (res) => ({ status: res.status, data: await res.json().catch(() => null) })); };
async function waitSub(id, tries) {
  for (let i = 0; i < (tries || 80); i++) {
    const d = await api('GET', '/api/submission/' + id, null, true);
    if (d.data && d.data.status === 'done') return d.data;
    await new Promise((res) => setTimeout(res, 500));
  }
  return null;
}
const AC = '#include <cstdio>\nint main(){int a,b; scanf("%d%d",&a,&b); printf("%d\\n",a+b); return 0;}';
const AC_CNT = '#include <cstdio>\nint main(){int a,b; scanf("%d%d",&a,&b); printf("%d\\n",a*a+b*b); return 0;}';
(async () => {
  let r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  check('管理员登录', r.status === 200, r.data);
  // —— 全站公告 ——
  r = await api('GET', '/api/notice', null, false);
  check('公告接口匿名可读', r.status === 200, r.data);
  r = await api('POST', '/api/admin/notice', { text: 'P23公告' + RID }, true);
  check('发布公告', r.status === 200 && r.data.text, r.data);
  r = await api('GET', '/api/notice', null, false);
  check('公告内容可见', r.status === 200 && r.data.text === 'P23公告' + RID, r.data);
  r = await api('POST', '/api/admin/notice', { text: '' }, true);
  check('清空公告', r.status === 200 && r.data.text === '', r.data);
  // —— 运行配置 ——
  r = await api('GET', '/api/admin/config', null, true);
  check('配置接口（管理员）', r.status === 200 && typeof r.data.config.maxParallel === 'number', r.data);
  // —— 用户删除 ——
  r = await api('POST', '/api/admin/user/save', { username: S1, fullname: '删除测试', password: 'pass1234' }, true);
  const uid = r.data.user.id;
  r = await api('POST', '/api/auth/login', { username: S1, password: 'pass1234' }, false, null, jarS);
  check('待删用户登录', r.status === 200, r.data);
  r = await api('POST', '/api/admin/user/delete', { id: uid }, true);
  check('超管删除用户', r.status === 200 && r.data.ok, r.data);
  r = await api('GET', '/api/auth/me', null, true, null, jarS);
  check('被删用户会话失效', r.status === 200 && r.data.user === null, r.data);
  r = await api('POST', '/api/admin/user/delete', { id: 1 }, true);
  check('不能删除超管', r.status === 400, r.data);
  // —— 建题 + 时限/内存/fileIO 编辑 ——
  r = await upload({ title: 'P23题' + RID, description: 'a+b', hidden: '0' }, [{ name: '1.in', content: '2 3' }, { name: '1.out', content: '5\n' }, { name: '2.in', content: '10 20' }, { name: '2.out', content: '30\n' }], '/api/admin/problem');
  const PID = r.data.id;
  check('建题', r.status === 200 && PID, r.data);
  r = await api('POST', '/api/admin/problem/edit', { problemId: PID, timeLimitSec: 2, memLimitKb: 524288, fileIO: { in: 'p23.in', out: 'p23.out' } }, true);
  check('编辑时限/内存/fileIO', r.status === 200 && r.data.timeLimitSec === 2 && r.data.memLimitKb === 524288 && r.data.fileIO && r.data.fileIO.in === 'p23.in', r.data);
  r = await api('GET', '/api/problem?id=' + PID, null, false);
  check('/api/problem 返回 fileIO', r.status === 200 && r.data.fileIO && r.data.fileIO.out === 'p23.out', r.data);
  // fileIO 评测：freopen 写法 AC
  const FIO = '#include <cstdio>\nint main(){freopen("p23.in","r",stdin); freopen("p23.out","w",stdout); int a,b; scanf("%d%d",&a,&b); printf("%d\\n",a+b); return 0;}';
  await api('POST', '/api/admin/user/save', { username: S1, fullname: '删除测试', password: 'pass1234' }, true);
  r = await api('POST', '/api/auth/login', { username: S1, password: 'pass1234' }, false, null, jarS);
  r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: FIO }, true, null, jarS);
  const fsub = await waitSub(r.data.id);
  check('fileIO freopen 写法 AC', !!fsub && fsub.summary && fsub.summary.verdict === 'AC', fsub && fsub.summary);
  r = await api('POST', '/api/admin/problem/edit', { problemId: PID, fileIO: null }, true);
  check('清除 fileIO 恢复标准IO', r.status === 200 && !r.data.fileIO, r.data);
  r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: AC }, true, null, jarS);
  const ssub = await waitSub(r.data.id);
  check('标准IO 写法 AC', !!ssub && ssub.summary && ssub.summary.verdict === 'AC', ssub && ssub.summary);
  // —— checker 上传（SPJ：判 a*a+b*b 也正确）——
  r = await api('GET', '/api/admin/problem/checker', null, true);
  check('checker GET 未定义 → 404', r.status === 404, r.data);
  r = await upload({ problemId: String(PID) }, [{ name: 'checker.cpp', content: '#include "testlib.h"\nint main(int argc,char*argv[]){registerTestlibCmd(argc,argv); int a=inf.readInt(), b=inf.readInt(); long long x=ouf.readLong(); long long s=ans.readLong(); if(x==s||x==1LL*a*a+1LL*b*b) quitf(_ok,"ok"); quitf(_wa,"wa");}' }], '/api/admin/problem/checker');
  check('上传 checker', r.status === 200 && r.data.checker === true, r.data);
  r = await api('POST', '/api/submit', { problemId: PID, std: 'c++17', code: AC_CNT }, true, null, jarS);
  const csub = await waitSub(r.data.id);
  check('SPJ 接受平方和答案', !!csub && csub.summary && csub.summary.verdict === 'AC', csub && csub.summary);
  r = await upload({ problemId: String(PID), clear: '1' }, [], '/api/admin/problem/checker');
  check('清除 checker', r.status === 200 && r.data.checker === false, r.data);
  // —— 非法 JSON 400 ——
  const bad = await fetch(BASE + '/api/submit', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'tgboj_token=' + jarS.token }, body: '{oops' });
  check('非法 JSON → 400', bad.status === 400, bad.status);
  // —— D：压缩包含符号链接被拒（symlink 写穿防护；须在注册限速前，避免占用限速额度）——
  const symTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tgboj-symlink-'));
  try {
    fs.writeFileSync(path.join(symTmp, 'description.md'), '# 恶意包\n');
    fs.symlinkSync('/etc/passwd', path.join(symTmp, 'evil-link'));
    execFileSync('zip', ['-q', '-y', 'mal.zip', 'description.md', 'evil-link'], { cwd: symTmp });
    r = await upload({}, [{ name: 'mal.zip', content: fs.readFileSync(path.join(symTmp, 'mal.zip')) }], '/api/admin/problem/package');
    check('symlink 压缩包被拒（400）', r.status === 400 && /符号链接/.test(String(r.data && r.data.error)), r.data);
  } finally { fs.rmSync(symTmp, { recursive: true, force: true }); }
  // —— E：注册用户名枚举统一（「已占用」与通用失败不可区分）——
  r = await api('POST', '/api/auth/register', { username: 'admin', fullname: '枚举测试', password: 'pass1234' });
  check('已占用用户名 → 通用文案（无「占用」字样）', r.status === 400 && typeof r.data.error === 'string' && r.data.error.indexOf('占用') === -1 && /注册失败/.test(r.data.error), r.data);
  // —— 注册限速 ——
  let reg429 = false;
  for (let i = 0; i < 12; i++) {
    const rr = await api('POST', '/api/auth/register', { username: 'rx' + RID + String(i), fullname: '限速测试', password: 'pass1234' });
    if (rr.status === 429) { reg429 = true; break; }
  }
  check('注册限速（10 次/10 分钟）', reg429, '未触发 429');
  // —— 作业答案版本上限 ——
  r = await api('POST', '/api/admin/homework', { title: 'P23作业' + RID, questions: ['Q'] }, true);
  const HWID = r.data.id;
  for (let i = 0; i < 22; i++) await api('POST', '/api/homework/answer', { homeworkId: HWID, answers: ['v' + i] }, true, null, jarS);
  r = await api('GET', '/api/homework/answers?homeworkId=' + HWID, null, true);
  const mine = r.data.answers.filter((a) => a.uid && String(a.username) === S1);
  check('答案版本上限 20', mine.length === 20, mine.length);
  // —— 评语已读 POST ——
  r = await api('POST', '/api/admin/homework/comment', { homeworkId: HWID, uid: (await api('GET', '/api/admin/users', null, true)).data.users.find((u) => u.username === S1).id, comment: '评语' + RID }, true);
  check('写评语', r.status === 200, r.data);
  r = await api('POST', '/api/homework/read', { id: HWID }, true, null, jarS);
  check('评语已读 POST', r.status === 200 && r.data.ok, r.data);
  r = await api('GET', '/api/notifications/unread', null, true, null, jarS);
  check('已读后无红点', r.status === 200 && !r.data.items.some((x) => x.type === 'hw' && x.homeworkId === HWID), r.data);
  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(2); });